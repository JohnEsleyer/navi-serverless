/**
 * The engine.
 *
 * Request pipeline, in the exact order the money is spent:
 *
 *   OPTIONS            → 204 + `max-age=31536000` (the browser keeps the
 *                        preflight, so repeat calls never reach the isolate)
 *   token preflight    → HMAC over the token only; junk dies before `JSON.parse`
 *   route match        → 404 for unknown paths
 *   action lookup      → Map hit, no allocation
 *   access rule        → synchronous; no microtask hop
 *   policy             → only when the app needs async logic
 *   cache key          → canonical hash of (action, identity, payload)
 *   If-None-Match      → 304 from cached metadata alone, zero body serialization
 *   L1 heap            → served from the isolate's own memory
 *   L2 Cache API       → served from the edge datacenter
 *   stale-while-revalidate → the caller gets the old value immediately and
 *                        exactly one background refresh runs via `waitUntil`
 *   singleflight       → N concurrent misses collapse into 1 handler execution
 *   handler            → the only place compute actually happens
 *   secret projection  → before a single byte is serialized
 */

import { deriveCacheKey, EdgeL2Cache, IsolateL1Cache, Singleflight, type L1Entry } from "./cache.js";
import { NaviError, toActionError } from "./errors.js";
import { fnv1a64, stableStringify } from "./internal/canonical.js";
import {
  allowAccess,
  RateLimiter,
  type RateLimitOptions,
  type TokenResult,
  type TokenVerifier,
} from "./policies.js";
import {
  project,
  unclaimedSecretFields,
  type Public,
  type PublicBySchema,
  type RuntimeSecretSchema,
  type SecretSchema,
  type SecretSchemaMarker,
  type SecretSchemaSpec,
} from "./security.js";
import type {
  AccessRule,
  ActionEnvelope,
  ActionError,
  ActionMap,
  ActionSpec,
  BatchRequestPayload,
  CacheOptions,
  CacheTier,
  RequestContext,
  Role,
  SecurityPolicy,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/*                                   Options                                   */
/* -------------------------------------------------------------------------- */

export interface CorsOptions {
  readonly origin?: string;
  readonly methods?: readonly string[];
  readonly headers?: readonly string[];
  /** Seconds a browser may cache the preflight. Default one year. */
  readonly maxAgeSeconds?: number;
  readonly credentials?: boolean;
}

export interface NaviOptions {
  /** Route prefix. Default `/_navi`. */
  readonly basePath?: string;
  /** L1 capacity per isolate. */
  readonly l1MaxEntries?: number;
  /** Enables the zero-I/O auth preflight. */
  readonly verifyToken?: TokenVerifier;
  /** Sheds abusive clients before dispatch. */
  readonly rateLimit?: RateLimitOptions;
  /** Hard cap on `POST /_navi/action` batch size. Default 50. */
  readonly maxBatchSize?: number;
  /** Reject bodies whose `v` does not match. Default false. */
  readonly strictVersion?: boolean;
  /** Wire protocol version, echoed in every response. */
  readonly version?: number;
  readonly cors?: CorsOptions;
  /** Fallback bindings for adapters that cannot pass `env` per request. */
  readonly env?: Record<string, unknown>;
  /** Observability hook; never allowed to break a response. */
  readonly onError?: (error: unknown, ctx: RequestContext | undefined) => void;
  /** Emit `_meta` by default. Clients may opt out per call. Default true. */
  readonly includeMeta?: boolean;
  /** Honour `X-Forwarded-For` for the client IP. Default true. */
  readonly trustProxyHeaders?: boolean;
  /** `Cache-Control` lifetime for the manifest route. Default 86400. */
  readonly manifestMaxAgeSeconds?: number;
}

/** What the engine stores per cache entry. Envelopes are built per request. */
interface CacheRecord {
  readonly data: unknown;
  readonly stripped: readonly string[];
  /** Content hash of `data` — the ETag, independent of per-request metadata. */
  readonly etag: string;
  /** Insertion time, so an L2 hit can be aged into fresh/stale correctly. */
  readonly storedAt: number;
}

export interface NaviMetrics {
  /** Requests that reached the engine. */
  readonly requests: number;
  /** Handler executions. This is the number you are billed for. */
  readonly handlerRuns: number;
  /** Requests answered without a handler execution. */
  readonly avoidedInvocations: number;
  readonly l1Hits: number;
  readonly l1StaleHits: number;
  readonly l2Hits: number;
  readonly singleflightCoalesced: number;
  readonly batchSubrequestsCollapsed: number;
  readonly conditionalNotModified: number;
  readonly cdnEligibleResponses: number;
  readonly policyRejections: number;
  readonly errors: number;
  readonly l1: { hits: number; misses: number; staleHits: number; evictions: number; size: number };
}

interface ResolvedAction {
  readonly name: string;
  readonly handler: (ctx: RequestContext, input: unknown) => unknown;
  readonly rule: SecurityPolicy | undefined;
  readonly schema: RuntimeSecretSchema | undefined;
  readonly modelKeys: ReadonlySet<string | symbol> | undefined;
  readonly cache: CacheOptions | undefined;
  readonly scope: "public" | "private" | "none";
  readonly ttlSeconds: number;
  readonly swrSeconds: number;
  readonly tags: readonly string[] | undefined;
  readonly cdnEligible: boolean;
  readonly cacheable: boolean;
  readonly gettable: boolean;
  readonly cacheKeyOf: (ctx: RequestContext, payload: unknown) => string | undefined;
  readonly flightKeyOf: (ctx: RequestContext, payload: unknown) => string | undefined;
}

/** Request facts that exist before a token is verified. */
interface RequestFacts {
  readonly waitUntil: RequestContext["waitUntil"];
  readonly clientIp: string;
  readonly query: Record<string, string>;
  readonly env: Readonly<Record<string, unknown>>;
}

const DEFAULT_CORS_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Navi-Role",
  "X-Navi-User-Id",
  "X-Navi-Meta",
  "If-None-Match",
] as const;

/* -------------------------------------------------------------------------- */
/*                                   Engine                                    */
/* -------------------------------------------------------------------------- */

export class NaviServerless<M extends ActionMap = {}> {
  /** Phantom field: the compiler's view of the registered actions. */
  declare readonly __registry: M;

  readonly #actions = new Map<string, ResolvedAction>();
  readonly #singleflight = new Singleflight();
  readonly #l1: IsolateL1Cache;
  readonly #limiter: RateLimiter | undefined;
  readonly #verify: TokenVerifier | undefined;
  readonly #options: NaviOptions;
  #manifest: string | undefined;

  /** Thrown objects already forwarded to `onError`; see `#reportError`. */
  readonly #reported = new WeakSet<object>();

  readonly #counters = {
    requests: 0,
    handlerRuns: 0,
    l1Hits: 0,
    l1StaleHits: 0,
    l2Hits: 0,
    batchSubrequestsCollapsed: 0,
    conditionalNotModified: 0,
    cdnEligibleResponses: 0,
    policyRejections: 0,
    errors: 0,
  };

  constructor(options?: NaviOptions) {
    this.#options = {
      basePath: "/_navi",
      maxBatchSize: 50,
      version: 1,
      includeMeta: true,
      trustProxyHeaders: true,
      manifestMaxAgeSeconds: 86_400,
      ...options,
    };
    this.#l1 = new IsolateL1Cache(this.#options.l1MaxEntries ?? 1000);
    this.#verify = this.#options.verifyToken;
    this.#limiter = this.#options.rateLimit === undefined ? undefined : new RateLimiter(this.#options.rateLimit);
  }

  /* ----------------------------- registration ---------------------------- */

  /**
   * Register an action and return an app type that remembers it.
   *
   * The return type carries the input type, the raw output type, and the
   * *public* (secret-stripped) output type, so `NaviClient<App>` infers
   * everything with no shared schema file and no codegen step.
   */
  registerAction<
    K extends string,
    TInput,
    TOutput,
    const S extends ActionSchemaInput<TOutput> | undefined = undefined,
  >(
    definition: ActionRegistration<TInput, TOutput, S> & { readonly name: K },
  ): NaviServerless<M & { readonly [P in K]: ActionSpec<TInput, TOutput, PublicOutput<TOutput, S>> }> {
    // A `@Secret` field that no class ever claimed would be serialized as-is.
    // That is a leak, not a mistake, so refuse to serve at all.
    const unclaimed = unclaimedSecretFields();
    if (unclaimed.length > 0) {
      throw new NaviError(
        "CONFIG_ERROR",
        `Unbound @Secret field(s): ${unclaimed.map(String).join(", ")}. ` +
          "Decorate the owning class with @SecretModel, or list the fields in SecretFields([...]).",
      );
    }

    const cache = definition.cache !== undefined && definition.cache.ttl > 0 ? definition.cache : undefined;
    const scope = cache?.scope ?? "none";
    const ttlSeconds = cache?.ttl ?? 0;
    const swrSeconds = cache?.swr ?? 0;
    const cacheable = cache !== undefined && scope !== "none";
    const schemaHolder = definition.schema as { spec?: RuntimeSecretSchema; keys?: ReadonlySet<string | symbol> } | undefined;
    const cdnEligible = scope === "public" && cacheable && cache?.cdn !== false;
    const gettable = scope === "public" || definition.readonlyTransport === true;

    this.#actions.set(definition.name, {
      name: definition.name,
      handler: definition.handler as (ctx: RequestContext, input: unknown) => unknown,
      rule: compileRule(definition.access, definition.policy),
      schema: schemaHolder?.spec,
      modelKeys: schemaHolder?.keys,
      cache,
      scope,
      ttlSeconds,
      swrSeconds,
      tags: cache?.tags,
      cdnEligible,
      cacheable,
      gettable,
      cacheKeyOf: (ctx, payload) => resolveCacheKey(definition.name, cache, scope, ctx, payload),
      flightKeyOf: (ctx, payload) => resolveFlightKey(definition.name, scope, ctx, payload),
    });

    this.#manifest = undefined;
    const next = this as unknown as NaviServerless<M & { readonly [P in K]: ActionSpec<TInput, TOutput, PublicOutput<TOutput, S>> }>;
    return next;
  }

  /** Compile-time proof that `name` is registered. Returns the name. */
  assertAction<K extends keyof M & string>(name: K): K {
    return name;
  }

  get actionNames(): string[] {
    return [...this.#actions.keys()];
  }

  get basePath(): string {
    return this.#options.basePath ?? "/_navi";
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /**
   * Drop cached entries. Accepts a cache tag, a full cache key, or a `prefix:`
   * selector. L2 is purged through the Cache API; purge the CDN separately
   * (`app.invalidate` is intentionally not a purge API — see README).
   */
  async invalidate(target: string): Promise<{ l1: number; l2: boolean }> {
    const l1 = this.#l1.invalidateTag(target) + this.#l1.invalidatePrefix(target);
    const l2 = await EdgeL2Cache.delete(target);
    return { l1, l2 };
  }

  /** Release memory held by expired entries. Call from a scheduled handler. */
  sweep(): { l1Dropped: number; inFlight: number } {
    return { l1Dropped: this.#l1.trim(), inFlight: this.#singleflight.size };
  }

  metrics(): NaviMetrics {
    const l1 = this.#l1.stats;
    const coalesced = this.#singleflight.coalescedCount;
    return {
      requests: this.#counters.requests,
      handlerRuns: this.#counters.handlerRuns,
      avoidedInvocations:
        this.#counters.l1Hits +
        this.#counters.l1StaleHits +
        this.#counters.l2Hits +
        coalesced +
        this.#counters.batchSubrequestsCollapsed,
      l1Hits: this.#counters.l1Hits,
      l1StaleHits: this.#counters.l1StaleHits,
      l2Hits: this.#counters.l2Hits,
      singleflightCoalesced: coalesced,
      batchSubrequestsCollapsed: this.#counters.batchSubrequestsCollapsed,
      conditionalNotModified: this.#counters.conditionalNotModified,
      cdnEligibleResponses: this.#counters.cdnEligibleResponses,
      policyRejections: this.#counters.policyRejections,
      errors: this.#counters.errors,
      l1,
    };
  }

  resetMetrics(): void {
    this.#counters.requests = 0;
    this.#counters.handlerRuns = 0;
    this.#counters.l1Hits = 0;
    this.#counters.l1StaleHits = 0;
    this.#counters.l2Hits = 0;
    this.#counters.batchSubrequestsCollapsed = 0;
    this.#counters.conditionalNotModified = 0;
    this.#counters.cdnEligibleResponses = 0;
    this.#counters.policyRejections = 0;
    this.#counters.errors = 0;
    this.#singleflight.coalescedCount = 0;
    this.#l1.clear();
  }

  /* ------------------------------- routing ------------------------------- */

  /**
   * The single entry point every adapter calls. Web Standards in, Web Standards
   * out — workerd, Vercel Edge, Deno and Bun all provide these globals.
   */
  async handleRequest(
    request: Request,
    env?: Record<string, unknown>,
    executionCtx?: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<Response> {
    this.#counters.requests++;
    const started = performance.now();
    const url = new URL(request.url);
    const base = this.#options.basePath ?? "/_navi";

    if (request.method === "OPTIONS") return this.#preflight();

    if (!url.pathname.startsWith(base)) {
      return this.#respond(NOT_FOUND_ROUTE, 404, started, request);
    }

    const route = url.pathname.slice(base.length) || "/";

    if (route === "/health" || route === "/healthz") {
      return request.method === "GET" || request.method === "HEAD"
        ? this.#health(request.method === "HEAD")
        : this.#respond(METHOD_NOT_ALLOWED_ROUTE, 405, started, request, { allow: "GET, HEAD" });
    }

    if (route === "/manifest") {
      return this.#manifestResponse();
    }

    if (route === "/action") {
      if (request.method !== "POST") {
        return this.#respond(METHOD_NOT_ALLOWED_ROUTE, 405, started, request, { allow: "POST, OPTIONS" });
      }
      return this.#handlePost(request, url, env, executionCtx, started);
    }

    if (route.startsWith("/a/")) {
      if (request.method === "GET" || request.method === "HEAD") {
        return this.#handleRead(request, url, decodeURIComponent(route.slice(3)), env, executionCtx, started);
      }
      return this.#respond(METHOD_NOT_ALLOWED_ROUTE, 405, started, request, { allow: "GET, HEAD, OPTIONS" });
    }

    return this.#respond(NOT_FOUND_ROUTE, 404, started, request);
  }

  /* ------------------------------- context ------------------------------- */

  /**
   * The facts that are knowable before a token is verified. Computed once per
   * request and handed to both the verifier and the final context, so a
   * verifier sees exactly the `env` and caller IP that the handler will.
   */
  #requestFacts(
    request: Request,
    url: URL,
    env: Record<string, unknown> | undefined,
    executionCtx: { waitUntil: (promise: Promise<unknown>) => void } | undefined,
  ): RequestFacts {
    const waitUntil: RequestContext["waitUntil"] =
      executionCtx === undefined
        ? (promise) => {
            // No platform context to extend the lifetime, and an unhandled
            // rejection would be worse than a lost cache write.
            void promise.catch(() => undefined);
          }
        : (promise) => {
            executionCtx.waitUntil(promise.catch(() => undefined));
          };

    const forwarded =
      this.#options.trustProxyHeaders === true ? request.headers.get("x-forwarded-for") : null;
    const clientIp =
      request.headers.get("cf-connecting-ip") ??
      forwarded?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "0.0.0.0";

    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    return { waitUntil, clientIp, query, env: env ?? this.#options.env ?? {} };
  }

  #context(request: Request, facts: RequestFacts, auth: TokenResult | undefined): RequestContext {
    const { waitUntil, clientIp, query, env } = facts;

    // A verified token is the only source of identity once a verifier is
    // configured. Falling back to a self-declared header would let anyone
    // poison another user's private cache.
    const authenticated = this.#verify !== undefined;
    const userId =
      auth !== undefined && auth.ok
        ? auth.userId
        : authenticated
          ? undefined
          : (request.headers.get("X-Navi-User-Id") ?? undefined);

    const role: Role = (
      auth !== undefined && auth.ok
        ? auth.role
        : authenticated
          ? "guest"
          : ((request.headers.get("X-Navi-Role") ?? "guest") as Role)
    ) as Role;

    return {
      id: crypto.randomUUID(),
      role,
      userId,
      clientIp,
      timestamp: Date.now(),
      waitUntil,
      env,
      query,
      request,
      claims: auth !== undefined && auth.ok ? auth.claims : undefined,
    };
  }

  /**
   * Auth preflight. Deliberately runs before the body is read: an invalid
   * token must not cost a `JSON.parse`, let alone a handler execution.
   */
  async #preflightAuth(request: Request, facts: RequestFacts): Promise<TokenResult | undefined> {
    if (this.#verify === undefined) return undefined;
    try {
      return await this.#verify(request, {
        request,
        env: facts.env,
        clientIp: facts.clientIp,
        waitUntil: facts.waitUntil,
        query: facts.query,
      });
    } catch (error) {
      this.#reportError(error, undefined);
      return { ok: false, code: "TOKEN_INVALID" };
    }
  }

  async #guard(
    request: Request,
    url: URL,
    env: Record<string, unknown> | undefined,
    executionCtx: { waitUntil: (promise: Promise<unknown>) => void } | undefined,
    started: number,
  ): Promise<{ ctx: RequestContext } | { response: Response }> {
    const facts = this.#requestFacts(request, url, env, executionCtx);
    const auth = await this.#preflightAuth(request, facts);
    if (auth !== undefined && !auth.ok) {
      return {
        response: this.#respond(
          {
            ok: false,
            correlationId: crypto.randomUUID(),
            error: {
              code: auth.code,
              message:
                auth.code === "TOKEN_EXPIRED"
                  ? "Capability token expired."
                  : "Capability token missing or invalid.",
              tip: "Send `Authorization: Bearer <token>`.",
            },
            _meta: { projectedSecretsCount: 0, strippedKeys: [], executionTimeMs: 0, avoidedInvocation: true },
          },
          auth.code === "TOKEN_MISSING" ? 401 : 403,
          started,
          request,
          { "Cache-Control": "no-store" },
        ),
      };
    }

    const ctx = this.#context(request, facts, auth);

    const limit = this.#limiter?.check(ctx);
    if (limit !== undefined && !limit.allowed) {
      this.#counters.policyRejections++;
      return {
        response: this.#respond(
          {
            ok: false,
            correlationId: ctx.id,
            error: { code: "RATE_LIMITED", message: "Too many requests.", tip: `Retry in ${limit.retryAfterSeconds}s.` },
            _meta: { projectedSecretsCount: 0, strippedKeys: [], executionTimeMs: 0, avoidedInvocation: true },
          },
          429,
          started,
          request,
          { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" },
        ),
      };
    }

    return { ctx };
  }

  /* ------------------------------ POST path ------------------------------ */

  async #handlePost(
    request: Request,
    url: URL,
    env: Record<string, unknown> | undefined,
    executionCtx: { waitUntil: (promise: Promise<unknown>) => void } | undefined,
    started: number,
  ): Promise<Response> {
    const guard = await this.#guard(request, url, env, executionCtx, started);
    if ("response" in guard) return guard.response;
    const ctx = guard.ctx;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return this.#respond(
        errorEnvelope(ctx.id, "MALFORMED_JSON", "Request body must be valid JSON."),
        400,
        started,
        request,
      );
    }

    if (isBatch(body)) return this.#handleBatch(request, body, ctx, started);

    const single = body as { action?: unknown; payload?: unknown; v?: unknown };

    if (this.#options.strictVersion === true && typeof single.v === "number" && single.v !== this.#options.version) {
      return this.#respond(
        errorEnvelope(
          ctx.id,
          "VALIDATION_ERROR",
          `Protocol version mismatch: client ${String(single.v)}, server ${String(this.#options.version)}.`,
        ),
        400,
        started,
        request,
      );
    }

    if (typeof single.action !== "string" || single.action.length === 0) {
      return this.#respond(errorEnvelope(ctx.id, "VALIDATION_ERROR", "`action` must be a non-empty string."), 400, started, request);
    }

    let outcome: DispatchOutcome;
    try {
      outcome = await this.#dispatch(single.action, single.payload, ctx, request, started);
    } catch (error) {
      // A handler that throws must still produce a structured envelope. Letting
      // the rejection escape crashes a Node process and hands edge clients an
      // opaque platform error page instead of something they can branch on.
      this.#reportError(error, ctx);
      const actionError = toActionError(error);
      return this.#respond(
        errorEnvelope(ctx.id, actionError.code, actionError.message, actionError.tip),
        statusFor(actionError.code),
        started,
        request,
        { "Cache-Control": "no-store" },
      );
    }
    return this.#render(outcome, ctx, started, request);
  }

  /* ------------------------------- batching ------------------------------ */

  /**
   * Multiplexed execution: N actions, one invocation, one HTTP round trip.
   *
   * Every sub-request goes through the same cache and singleflight path as a
   * single call, so a batch that asks for the same product three times still
   * runs one handler, and a batch overlapping a concurrent single request costs
   * nothing extra.
   */
  async #handleBatch(
    request: Request,
    batch: BatchRequestPayload,
    ctx: RequestContext,
    started: number,
  ): Promise<Response> {
    const maxBatchSize = this.#options.maxBatchSize ?? 50;
    if (batch._batch.length > maxBatchSize) {
      return this.#respond(
        errorEnvelope(
          ctx.id,
          "BATCH_TOO_LARGE",
          `Batch of ${batch._batch.length} exceeds the limit of ${maxBatchSize}.`,
        ),
        413,
        started,
        request,
      );
    }

    const runsBefore = this.#counters.handlerRuns;
    const results = await Promise.all(
      batch._batch.map(async (entry) => {
        const itemStarted = performance.now();
        try {
          return { id: entry.id, outcome: await this.#dispatch(entry.action, entry.payload, ctx, request, itemStarted) };
        } catch (error) {
          this.#reportError(error, ctx);
          return {
            id: entry.id,
            outcome: { tier: "NONE" as CacheTier, error: toActionError(error) },
          };
        }
      }),
    );

    // Honest measurement: entries that did not need their own execution because
    // the cache, a duplicate entry, or a concurrent request already had it.
    const executed = this.#counters.handlerRuns - runsBefore;
    this.#counters.batchSubrequestsCollapsed += Math.max(0, results.length - executed);

    const includeMeta = this.#options.includeMeta === true && wantsMeta(request);
    const body = {
      ok: results.every((item) => item.outcome.error === undefined),
      correlationId: ctx.id,
      results: results.map((item) =>
        item.outcome.error !== undefined
          ? { id: item.id, ok: false as const, error: item.outcome.error }
          : {
              id: item.id,
              ok: true as const,
              data: item.outcome.record?.data,
              cacheHit: item.outcome.tier,
            },
      ),
      _meta: includeMeta
        ? {
            projectedSecretsCount: 0,
            strippedKeys: [] as readonly string[],
            executionTimeMs: round(performance.now() - started),
            batched: true as const,
            avoidedInvocation: executed < results.length,
          }
        : { projectedSecretsCount: 0, strippedKeys: [] as readonly string[], executionTimeMs: 0, batched: true as const },
    };

    const headers = this.#headers(request, { includeMeta: false });
    headers.set("Cache-Control", "no-store");
    headers.set("X-Navi-Correlation-Id", ctx.id);
    return new Response(JSON.stringify(body), { status: 200, headers });
  }

  /* ------------------------------ GET transport -------------------------- */

  /**
   * Read-only transport, and the only route that can reach *zero* invocations:
   * with `s-maxage` set, the CDN answers repeat readers and the isolate is
   * never scheduled.
   */
  async #handleRead(
    request: Request,
    url: URL,
    name: string,
    env: Record<string, unknown> | undefined,
    executionCtx: { waitUntil: (promise: Promise<unknown>) => void } | undefined,
    started: number,
  ): Promise<Response> {
    const known = this.#actions.has(name);
    if (!known || (this.#actions.get(name) as ResolvedAction).gettable === false) {
      return this.#respond(
        {
          ...errorEnvelope(crypto.randomUUID(), "ACTION_NOT_FOUND", `Action '${name}' is not readable over GET.`),
          error: {
            code: "ACTION_NOT_FOUND",
            message: `Action '${name}' is not readable over GET.`,
            tip: "Only public-scope or `readonlyTransport: true` actions are exposed there.",
          },
        } satisfies ActionEnvelope,
        404,
        started,
        request,
      );
    }

    const guard = await this.#guard(request, url, env, executionCtx, started);
    if ("response" in guard) return guard.response;

    const outcome = await this.#dispatch(name, payloadFromQuery(url), guard.ctx, request, started);
    return this.#render(outcome, guard.ctx, started, request);
  }

  /* ------------------------------- dispatch ------------------------------ */

  /**
   * Resolve one action to a record. Pure bookkeeping — no `Response` is built
   * here so batching can reuse a single implementation.
   */
  async #dispatch(
    name: string,
    payload: unknown,
    ctx: RequestContext,
    request: Request,
    started: number,
  ): Promise<DispatchOutcome> {
    const action = this.#actions.get(name);
    if (action === undefined) {
      return {
        tier: "NONE",
        error: {
          code: "ACTION_NOT_FOUND",
          message: `Action '${name}' is not registered.`,
          tip: this.actionNames.length === 0 ? "No actions are registered." : `Known: ${this.actionNames.join(", ")}.`,
        },
      };
    }

    // Authorization first: a rejected probe must cost no cache work and no
    // storage read.
    if (action.rule !== undefined && !(await action.rule(ctx))) {
      this.#counters.policyRejections++;
      return {
        tier: "NONE",
        error: {
          code: "POLICY_VIOLATION",
          message: `Colocated policy rejected '${name}'.`,
          tip: ctx.userId === undefined ? "Credentials required for this action." : undefined,
        },
      };
    }

    const cacheKey = action.cacheable ? action.cacheKeyOf(ctx, payload) : undefined;
    // Always derivable, even with no cache configured: this is the only thing
    // standing between 50 identical simultaneous requests and 50 handler runs.
    const flightKey = action.flightKeyOf(ctx, payload) ?? `${name}#${crypto.randomUUID()}`;
    const ifNoneMatch = request.headers.get("If-None-Match");

    // --- L1: isolate heap -------------------------------------------------
    if (cacheKey !== undefined) {
      const hit = this.#l1.lookup<CacheRecord>(cacheKey);
      if (hit.state === "fresh") {
        this.#counters.l1Hits++;
        if (ifNoneMatch !== null && etagMatches(ifNoneMatch, hit.entry.etag)) {
          this.#counters.conditionalNotModified++;
          return { tier: "NONE", notModified: hit.entry.etag, action, ctx };
        }
        return { tier: "L1-HEAP", record: hit.entry.value, action, ctx };
      }
      if (hit.state === "stale") {
        this.#counters.l1StaleHits++;
        // The caller gets the old value now; exactly one refresh runs behind it.
        ctx.waitUntil(this.#revalidate(action, cacheKey, flightKey, hit.entry.meta, ctx));
        if (ifNoneMatch !== null && etagMatches(ifNoneMatch, hit.entry.etag)) {
          this.#counters.conditionalNotModified++;
          return { tier: "L1-HEAP", notModified: hit.entry.etag, action, ctx };
        }
        return { tier: "L1-HEAP", record: hit.entry.value, action, ctx };
      }
    }

    // --- L2: edge Cache API ----------------------------------------------
    if (cacheKey !== undefined) {
      const l2 = await EdgeL2Cache.match<CacheRecord>(cacheKey);
      if (l2 !== undefined) {
        this.#counters.l2Hits++;
        const age = (Date.now() - l2.value.storedAt) / 1000;
        const fresh = age <= action.ttlSeconds;
        const entry = this.#l1.set(cacheKey, l2.value, {
          ttlSeconds: action.ttlSeconds,
          swrSeconds: action.swrSeconds,
          etag: l2.etag ?? l2.value.etag,
          tags: action.tags,
          meta: payload,
        });
        // A stale L2 entry is served immediately and refreshed once.
        if (!fresh && action.swrSeconds > 0) {
          ctx.waitUntil(this.#revalidate(action, cacheKey, flightKey, payload, ctx));
        }
        if (ifNoneMatch !== null && etagMatches(ifNoneMatch, entry.etag)) {
          this.#counters.conditionalNotModified++;
          return { tier: "L2-EDGE-CACHE", notModified: entry.etag, action, ctx };
        }
        return { tier: "L2-EDGE-CACHE", record: l2.value, action, ctx };
      }
    }

    // --- execute, collapsing concurrent identical work --------------------
    const { result, shared } = await this.#singleflight.do(flightKey, async () => {
      const record = await this.#execute(action, payload, ctx);
      if (cacheKey !== undefined) {
        this.#l1.set(cacheKey, record, {
          ttlSeconds: action.ttlSeconds,
          swrSeconds: action.swrSeconds,
          etag: record.etag,
          tags: action.tags,
          meta: payload,
        });
        if (action.scope === "public") {
          // Cross-isolate writes are background work: a storage round trip must
          // never sit in front of a response.
          ctx.waitUntil(
            EdgeL2Cache.put(cacheKey, record, {
              ttlSeconds: action.ttlSeconds,
              swrSeconds: action.swrSeconds,
              tags: action.tags,
            }),
          );
        }
      }
      return record;
    });

    if (ifNoneMatch !== null && etagMatches(ifNoneMatch, result.etag)) {
      this.#counters.conditionalNotModified++;
      return { tier: shared ? "SINGLEFLIGHT" : "NONE", notModified: result.etag, action, ctx };
    }

    return { tier: shared ? "SINGLEFLIGHT" : "NONE", record: result, action, ctx };
  }

  /** The only place a handler is allowed to run. */
  async #execute(action: ResolvedAction, payload: unknown, ctx: RequestContext): Promise<CacheRecord> {
    this.#counters.handlerRuns++;
    const raw = await action.handler(ctx, payload);
    const { clean, stripped } = project(raw as object, {
      schema: action.schema,
      modelKeys: action.modelKeys,
    });
    const canonical = stableStringify(clean);
    return {
      data: clean,
      stripped,
      etag: `"${fnv1a64(canonical.ok ? canonical.value : "unhashable")}"`,
      storedAt: Date.now(),
    };
  }

  /**
   * Background refresh of a stale entry. Runs inside the platform's
   * `waitUntil` window, under the same singleflight lock as a cold miss, so N
   * stale readers produce one refresh — and a refresh racing a cold miss does
   * not produce two handler runs.
   */
  async #revalidate(
    action: ResolvedAction,
    cacheKey: string,
    flightKey: string,
    payload: unknown,
    ctx: RequestContext,
  ): Promise<void> {
    await this.#singleflight.do(flightKey, async () => {
      const record = await this.#execute(action, payload, ctx);
      this.#l1.set(cacheKey, record, {
        ttlSeconds: action.ttlSeconds,
        swrSeconds: action.swrSeconds,
        etag: record.etag,
        tags: action.tags,
        meta: payload,
      });
      if (action.scope === "public") {
        await EdgeL2Cache.put(cacheKey, record, {
          ttlSeconds: action.ttlSeconds,
          swrSeconds: action.swrSeconds,
          tags: action.tags,
        });
      }
    });
  }

  /* ------------------------------- rendering ----------------------------- */

  #render(outcome: DispatchOutcome, ctx: RequestContext, started: number, request: Request): Response {
    if (outcome.error !== undefined) {
      const status = statusFor(outcome.error.code);
      return this.#respond(
        { ok: false, correlationId: ctx.id, error: outcome.error, _meta: EMPTY_META },
        status,
        started,
        request,
        { "Cache-Control": "no-store" },
      );
    }

    const action = outcome.action;
    const includeMeta = this.#options.includeMeta === true && wantsMeta(request);
    const headers = this.#headers(request, { includeMeta });

    if (action !== undefined) {
      if (action.cdnEligible && isGet(request)) {
        this.#counters.cdnEligibleResponses++;
        applyCdnHeaders(headers, action.ttlSeconds, action.swrSeconds);
      } else if (action.cdnEligible === false && action.cache?.vary !== undefined) {
        headers.set("Vary", action.cache.vary.join(", "));
      }
    }

    if (outcome.notModified !== undefined) {
      headers.set("ETag", outcome.notModified);
      headers.set("X-Navi-Cache", outcome.tier);
      headers.set("X-Navi-Avoided", "1");
      return new Response(null, { status: 304, headers });
    }

    const record = outcome.record as CacheRecord;
    headers.set("ETag", record.etag);
    headers.set("X-Navi-Cache", outcome.tier);
    if (outcome.tier !== "NONE") headers.set("X-Navi-Avoided", "1");

    const envelope: ActionEnvelope = {
      ok: true,
      correlationId: ctx.id,
      data: record.data,
      _meta: {
        projectedSecretsCount: record.stripped.length,
        strippedKeys: includeMeta ? record.stripped : [],
        cacheHit: outcome.tier,
        executionTimeMs: round(performance.now() - started),
        avoidedInvocation: outcome.tier !== "NONE",
      },
    };

    if (request.method === "HEAD") {
      headers.set("Content-Length", String(jsonLength(record.data)));
      return new Response(null, { status: 200, headers });
    }

    headers.set("Content-Length", String(jsonLength(envelope)));
    return new Response(JSON.stringify(envelope), { status: 200, headers });
  }

  /* ------------------------------- plumbing ------------------------------ */

  #headers(request: Request, opts: { includeMeta: boolean }): Headers {
    const cors = this.#options.cors;
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Navi-Version": String(this.#options.version ?? 1),
    });
    headers.set("Access-Control-Allow-Origin", cors?.origin ?? "*");
    if (cors?.credentials === true) headers.set("Access-Control-Allow-Credentials", "true");
    if (opts.includeMeta === false) headers.set("X-Navi-Meta", "0");
    if (request.method !== "GET" && request.method !== "HEAD") headers.set("Cache-Control", "no-store");
    return headers;
  }

  #preflight(): Response {
    const cors = this.#options.cors;
    const headers = new Headers({
      "Access-Control-Allow-Origin": cors?.origin ?? "*",
      "Access-Control-Allow-Methods": (cors?.methods ?? ["POST", "GET", "HEAD", "OPTIONS"]).join(", "),
      "Access-Control-Allow-Headers": (cors?.headers ?? DEFAULT_CORS_HEADERS).join(", "),
      "Access-Control-Expose-Headers": "ETag, X-Navi-Cache, X-Navi-Avoided, X-Navi-Correlation-Id, X-Navi-Version",
      // A year: the browser asks once, so preflights stop costing invocations.
      "Access-Control-Max-Age": String(cors?.maxAgeSeconds ?? 31_536_000),
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    if (cors?.credentials === true) headers.set("Access-Control-Allow-Credentials", "true");
    return new Response(null, { status: 204, headers });
  }

  #health(head: boolean): Response {
    const body = {
      ok: true,
      version: this.#options.version ?? 1,
      actions: this.actionNames.length,
      l2: EdgeL2Cache.available,
      metrics: this.metrics(),
    };
    return new Response(head ? null : JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  /**
   * Static description of the action surface, built once and then served from
   * the CDN for a day, so clients can plan batching and transport for free.
   */
  #manifestResponse(): Response {
    this.#manifest ??= JSON.stringify({
      version: this.#options.version ?? 1,
      basePath: this.#options.basePath ?? "/_navi",
      maxBatchSize: this.#options.maxBatchSize ?? 50,
      actions: Object.fromEntries(
        [...this.#actions.values()].map((action) => [
          action.name,
          {
            cached: action.cacheable,
            scope: action.scope,
            ttl: action.ttlSeconds,
            swr: action.swrSeconds,
            get: action.gettable,
            cdn: action.cdnEligible,
          },
        ]),
      ),
    });

    const maxAge = this.#options.manifestMaxAgeSeconds ?? 86_400;
    return new Response(this.#manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=300, s-maxage=${maxAge}, stale-while-revalidate=604800`,
        "CDN-Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=604800`,
      },
    });
  }

  #respond(
    envelope: ActionEnvelope,
    status: number,
    started: number,
    request: Request,
    extra?: Record<string, string>,
  ): Response {
    const headers = this.#headers(request, { includeMeta: true });
    if (request.method === "GET" || request.method === "HEAD") headers.set("Cache-Control", "no-store");
    if (extra !== undefined) {
      for (const key of Object.keys(extra)) headers.set(key, extra[key] as string);
    }
    const body: ActionEnvelope = {
      ...envelope,
      _meta: { ...envelope._meta, executionTimeMs: round(performance.now() - started) },
    };
    return new Response(JSON.stringify(body), { status, headers });
  }

  /**
   * Forward an unexpected error to `onError`, exactly once per thrown object.
   *
   * Singleflight hands the *same* `Error` instance to every waiter, and each of
   * them catches it on the way to building its own envelope. Without the
   * `WeakSet`, one database outage would page you ten times.
   */
  #reportError(error: unknown, ctx: RequestContext | undefined): void {
    if (error instanceof NaviError) return; // expected; already normalized
    if (typeof error === "object" && error !== null) {
      if (this.#reported.has(error)) return;
      this.#reported.add(error);
    }
    this.#counters.errors++;
    try {
      this.#options.onError?.(error, ctx);
    } catch {
      // A reporter that throws is worse than no reporter.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                             Registration types                              */
/* -------------------------------------------------------------------------- */

/** A schema may be given inline or via `defineSecretSchema()`. */
export type ActionSchemaInput<T> = SecretSchemaSpec<T> | SecretSchema<T, SecretSchemaSpec<T>>;

/** The output a client can observe, given whatever schema was registered. */
export type PublicOutput<TOutput, S> = S extends SecretSchemaMarker<infer Sp>
  ? PublicBySchema<TOutput, Sp>
  : S extends SecretSchemaSpec<TOutput>
    ? PublicBySchema<TOutput, S>
    : Public<TOutput>;

export type ActionRegistration<TInput, TOutput, S> = {
  readonly name: string;
  readonly policy?: SecurityPolicy;
  readonly access?: AccessRule;
  readonly cache?: CacheOptions;
  readonly schema?: S;
  readonly readonlyTransport?: boolean;
  readonly handler: (ctx: RequestContext, input: TInput) => Promise<TOutput> | TOutput;
};

interface DispatchOutcome {
  readonly record?: CacheRecord | undefined;
  readonly tier: CacheTier;
  readonly error?: ActionError | undefined;
  readonly notModified?: string | undefined;
  readonly action?: ResolvedAction | undefined;
  readonly ctx?: RequestContext | undefined;
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const EMPTY_META = { projectedSecretsCount: 0, strippedKeys: [] as readonly string[], executionTimeMs: 0 };

const NOT_FOUND_ROUTE: ActionEnvelope = {
  ok: false,
  correlationId: "0",
  error: { code: "NOT_FOUND", message: "No such Navi route.", tip: "Navi mounts at /_navi." },
  _meta: EMPTY_META,
};

const METHOD_NOT_ALLOWED_ROUTE: ActionEnvelope = {
  ok: false,
  correlationId: "0",
  error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported method for this route." },
  _meta: EMPTY_META,
};

function errorEnvelope(id: string, code: ActionError["code"], message: string, tip?: string): ActionEnvelope {
  return {
    ok: false,
    correlationId: id,
    error: tip === undefined ? { code, message } : { code, message, tip },
    _meta: EMPTY_META,
  };
}

function statusFor(code: ActionError["code"]): number {
  switch (code) {
    case "ACTION_NOT_FOUND":
    case "NOT_FOUND":
      return 404;
    case "POLICY_VIOLATION":
    case "TOKEN_INVALID":
    case "TOKEN_EXPIRED":
      return 403;
    case "TOKEN_MISSING":
    case "UNAUTHORIZED":
      return 401;
    case "RATE_LIMITED":
      return 429;
    case "BATCH_TOO_LARGE":
      return 413;
    case "VALIDATION_ERROR":
    case "MALFORMED_JSON":
      return 400;
    case "METHOD_NOT_ALLOWED":
      return 405;
    default:
      return 500;
  }
}

/** Fold the declarative rule and the functional policy into one gate. */
function compileRule(access: AccessRule | undefined, policy: SecurityPolicy | undefined): SecurityPolicy | undefined {
  if (access === undefined) return policy;
  const rule = allowAccess(access);
  if (policy === undefined) return rule;
  return async (ctx) => rule(ctx) && (await policy(ctx));
}

function resolveCacheKey(
  name: string,
  cache: CacheOptions | undefined,
  scope: "public" | "private" | "none",
  ctx: RequestContext,
  payload: unknown,
): string | undefined {
  if (cache === undefined) return undefined;
  if (cache.keyGenerator !== undefined) {
    const custom = cache.keyGenerator(ctx, payload);
    if (custom === null) return undefined;
    // A custom key replaces the *payload* half of the key, never the identity
    // half. Dropping identity here would let a `private` action hand one
    // user's cached response to another, which is the one thing the scope is
    // there to prevent.
    if (scope === "public") return custom;
    const identity = scope === "private" ? (ctx.userId ?? `ip:${ctx.clientIp}`) : "none";
    return `${custom}|${identity}`;
  }
  const identity = scope === "public" ? "public" : scope === "private" ? (ctx.userId ?? `ip:${ctx.clientIp}`) : "none";
  return deriveCacheKey({ action: name, identity, payload });
}

/**
 * Coalescing key for concurrent identical work.
 *
 * Deliberately independent of the cache key: singleflight must also collapse
 * concurrent work for *uncached* actions, which is exactly where a stampede
 * hurts most (an uncached read hit by 50 tabs at once). A custom
 * `cache.keyGenerator` may return a shared aggregate key, so it is never
 * reused here — the full canonical payload is hashed instead.
 *
 * The caller identity is always part of the key, even for a `public` action,
 * because a handler can read `ctx` for reasons the cache scope cannot know.
 */
function resolveFlightKey(
  name: string,
  scope: "public" | "private" | "none",
  ctx: RequestContext,
  payload: unknown,
): string | undefined {
  const caller = scope === "public" ? "public" : `${ctx.userId ?? `ip:${ctx.clientIp}`}|${ctx.role}`;
  const key = deriveCacheKey({ action: name, identity: caller, payload });
  // An unserializable payload cannot be safely shared between callers.
  return key === undefined ? undefined : `f:${key}`;
}

function wantsMeta(request: Request): boolean {
  return request.headers.get("X-Navi-Meta") !== "0";
}

function isGet(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === "*") return true;
  const normalize = (value: string): string => value.trim().replace(/^W\//, "");
  const target = normalize(etag);
  for (const candidate of ifNoneMatch.split(",")) {
    if (normalize(candidate) === target) return true;
  }
  return false;
}

/**
 * Query-string payloads for the CDN-friendly GET transport.
 * `?p=<urlencoded json>` wins; otherwise params become an object, and a `k[]`
 * suffix yields an array so list reads stay cacheable.
 */
function payloadFromQuery(url: URL): unknown {
  const packed = url.searchParams.get("p");
  if (packed !== null) {
    try {
      return JSON.parse(packed) as unknown;
    } catch {
      return undefined;
    }
  }
  const out: Record<string, unknown> = {};
  url.searchParams.forEach((value, key) => {
    if (key === "p") return;
    if (key.endsWith("[]")) {
      const name = key.slice(0, -2);
      const existing = out[name];
      out[name] = Array.isArray(existing) ? [...existing, value] : [value];
      return;
    }
    out[key] = value;
  });
  return Object.keys(out).length === 0 ? undefined : out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function jsonLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : json.length;
}

/**
 * CDN instructions. `s-maxage` governs only the shared cache; `max-age=0`
 * keeps browsers revalidating so a user never pins stale content. Cloudflare and
 * Vercel each read their own header and ignore `Cache-Control`'s shared rules,
 * so all three are emitted.
 */
function applyCdnHeaders(headers: Headers, ttl: number, swr: number): void {
  const shared =
    swr > 0
      ? `s-maxage=${ttl + swr}, stale-while-revalidate=${swr}, stale-if-error=86400`
      : `s-maxage=${ttl}, stale-if-error=86400`;
  headers.set("Cache-Control", `public, max-age=0, must-revalidate, ${shared}`);
  headers.set("CDN-Cache-Control", `public, ${shared}`);
  headers.set("Vercel-CDN-Cache-Control", `public, ${shared}`);
}

function isBatch(value: unknown): value is BatchRequestPayload {
  return typeof value === "object" && value !== null && Array.isArray((value as { _batch?: unknown })._batch);
}
