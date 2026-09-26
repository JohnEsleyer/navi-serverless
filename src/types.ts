/**
 * Navi Serverless — core type contracts.
 *
 * Design notes
 * ------------
 * Everything here is structural, brand-free where possible, and survives
 * `isolatedModules` + `verbatimModuleSyntax` (type-only imports stay erasable).
 * The public generics are intentionally "append-only": `registerAction` returns a
 * *new* registry type, so the action map is a compile-time fact rather than a
 * value that must be duplicated by hand.
 */

export type HttpMethod = "GET" | "POST" | "OPTIONS" | "HEAD";

/** Roles are plain strings so apps can use their own vocabulary. */
export type Role = string & { readonly __brand?: "navi.role" };

/** Absolute age in seconds. */
export type Seconds = number;

/** Which cache tier satisfied a request. */
export type CacheTier =
  | "L1-HEAP"
  | "L2-EDGE-CACHE"
  | "SINGLEFLIGHT"
  | "BATCH-SHARED"
  | "CDN"
  | "NONE";

/** How a client-side cache entry was served. */
export type ClientTier = "MEMORY" | "IDB" | "INFLIGHT" | "BATCH" | "NETWORK";

/** Platform-neutral "keep this promise alive past the response" hook. */
export type WaitUntil = (promise: Promise<unknown>) => void;

export interface RequestContext {
  /** Correlation id, echoed on every envelope. */
  readonly id: string;
  /** Verified role for the caller (`"guest"` when unauthenticated). */
  readonly role: Role;
  /** Verified subject id, present only when a token carried one. */
  readonly userId?: string | undefined;
  readonly clientIp: string;
  readonly timestamp: number;
  readonly waitUntil: WaitUntil;
  readonly env: Readonly<Record<string, unknown>>;
  /** Parsed query string (always present, empty for POST calls). */
  readonly query: Readonly<Record<string, string>>;
  /** Present for `GET /_navi/a/:name` style read requests. */
  readonly request: Request;
  /** Claims extracted from a signed capability token, if the app enabled them. */
  readonly claims?: Readonly<Record<string, unknown>> | undefined;
}

export type SecurityPolicy = (ctx: RequestContext) => boolean | Promise<boolean>;

export interface ActionMetadata {
  /** Number of secret fields removed before serialization. */
  readonly projectedSecretsCount: number;
  /** Dotted paths of every stripped field, e.g. `variants[0].wholesaleCost`. */
  readonly strippedKeys: readonly string[];
  readonly cacheHit?: CacheTier | undefined;
  readonly executionTimeMs: number;
  /** True when the response body was served without touching the handler. */
  readonly avoidedInvocation?: boolean | undefined;
  /** Populated when the client asked for a slim envelope. */
  readonly batched?: boolean | undefined;
}

export interface ActionError {
  readonly code: NaviErrorCode;
  readonly message: string;
  readonly tip?: string | undefined;
}

export type NaviErrorCode =
  | "CONFIG_ERROR"
  | "MALFORMED_JSON"
  | "ACTION_NOT_FOUND"
  | "POLICY_VIOLATION"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_MISSING"
  | "EXECUTION_ERROR"
  | "VALIDATION_ERROR"
  | "BATCH_TOO_LARGE"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "INTERNAL";

export interface ActionEnvelope<T = unknown> {
  readonly ok: boolean;
  readonly correlationId: string;
  readonly data?: T;
  readonly error?: ActionError;
  readonly _meta: ActionMetadata;
}

/** Wire shape of a single action call (`POST /_navi/action`). */
export interface SingleActionPayload {
  readonly action: string;
  readonly payload?: unknown;
  /** Client-advertised schema version; mismatches are rejected when `strict`. */
  readonly v?: number;
}

/** One entry of a multiplexed batch. */
export interface BatchEntry {
  readonly id: string;
  readonly action: string;
  readonly payload?: unknown;
}

export interface BatchRequestPayload {
  readonly _batch: readonly BatchEntry[];
}

export type BatchResponseItem =
  | { readonly id: string; readonly ok: true; readonly data: unknown; readonly cacheHit: CacheTier }
  | { readonly id: string; readonly ok: false; readonly error: ActionError };

export interface BatchEnvelope {
  readonly ok: boolean;
  readonly correlationId: string;
  readonly results: readonly BatchResponseItem[];
  readonly _meta: ActionMetadata & { readonly batched: true };
}

/* -------------------------------------------------------------------------- */
/*                              Cache configuration                            */
/* -------------------------------------------------------------------------- */

export type CacheScope = "public" | "private" | "none";

export interface CacheOptions {
  /** Fresh window in seconds. */
  readonly ttl: Seconds;
  /** Additional stale-while-revalidate window in seconds. */
  readonly swr?: Seconds | undefined;
  /**
   * Custom key derivation. Returning `null` opts the call out of caching
   * entirely (useful for actions that only sometimes make sense to cache).
   */
  readonly keyGenerator?: ((ctx: RequestContext, payload: unknown) => string | null) | undefined;
  /**
   * `public` → shared across users (CDN + L2 + L1), `private` → per-user L1/L2,
   * `none` → no caching at all. Defaults to `private`.
   */
  readonly scope?: CacheScope | undefined;
  /**
   * Emit `Cache-Control: s-maxage` / `stale-while-revalidate` so the *CDN*
   * answers repeat reads without invoking the isolate at all. This is the only
   * tier that literally removes a billed invocation, so it is on by default for
   * public caches. Requires the action to be reachable over `GET`.
   */
  readonly cdn?: boolean | undefined;
  /** Emit `Vary` for these request headers (private scopes only). */
  readonly vary?: readonly string[] | undefined;
  /**
   * Invalidation tags. `app.invalidate("product:prod-1")` drops matching L1/L2
   * entries across every isolate that saw the tag.
   */
  readonly tags?: readonly string[] | undefined;
}

/* -------------------------------------------------------------------------- */
/*                              Action definitions                            */
/* -------------------------------------------------------------------------- */

export interface ActionDefinition<TInput = unknown, TOutput = unknown, S = unknown> {
  readonly name: string;
  /** Functional gate. Runs *before* cache lookups and before handler compute. */
  readonly policy?: SecurityPolicy;
  /** Declarative gate — cheaper than a closure, evaluated synchronously. */
  readonly access?: AccessRule;
  readonly cache?: CacheOptions;
  /**
   * Secret schema from `defineSecretSchema()`. Typing it here is what removes
   * the field from the client's view of the response at compile time.
   */
  readonly schema?: S;
  /**
   * Opt into `GET /_navi/a/:name` transport (query params only) so CDNs can
   * cache the response. Cached actions are automatically exposed.
   */
  readonly readonlyTransport?: boolean;
  readonly handler: (ctx: RequestContext, input: TInput) => Promise<TOutput> | TOutput;
}

export interface AccessRule {
  /** Caller must hold one of these roles. */
  readonly roles?: readonly Role[] | undefined;
  /** `true` (default) allows `role === "guest"` requests through. */
  readonly allowGuest?: boolean | undefined;
  /** Require a verified `userId` on the context. */
  readonly requireUser?: boolean | undefined;
  /** Static allow/deny list of `ctx.clientIp` prefixes (CIDR-lite). */
  readonly allowIps?: readonly string[] | undefined;
  readonly denyIps?: readonly string[] | undefined;
}

/* -------------------------------------------------------------------------- */
/*                          Type-level action registry                        */
/* -------------------------------------------------------------------------- */

/** A single registered action, as remembered by the compiler. */
export interface ActionSpec<TInput = unknown, TOutput = unknown, TPublic = TOutput> {
  readonly input: TInput;
  readonly output: TOutput;
  /** Output after secret projection — what a client can actually observe. */
  readonly public: TPublic;
}

export type ActionMap = Record<string, ActionSpec<unknown, unknown, unknown>>;

export type ActionName<M> = Extract<keyof M, string>;

export type ActionInput<M, K extends string> = M extends Record<K, ActionSpec<infer I, unknown, unknown>> ? I : never;

export type ActionOutput<M, K extends string> = M extends Record<K, ActionSpec<unknown, infer O, unknown>> ? O : never;

export type ActionPublic<M, K extends string> = M extends Record<K, ActionSpec<unknown, unknown, infer P>> ? P : never;

/** Anything that structurally carries a registry. */
export type RegistryOf<T> = T extends { readonly __registry: infer M } ? M : ActionMap;

export type ReadonlyRegistryOf<T> = T extends { readonly __registry: infer M } ? Readonly<M> : ActionMap;
