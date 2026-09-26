/**
 * The zero-invocation client runtime.
 *
 * Every layer exists to answer a call *without* reaching the network. In the
 * order they fire in a real app:
 *
 *   1. In-flight dedupe   N identical calls in one tick collapse to a single
 *                         promise. The single biggest win on a page that fires
 *                         the same query from several widgets.
 *   2. Memory cache       a re-render, or a later widget asking for the same
 *                         thing. One Map lookup, no await.
 *   3. IndexedDB cache    survives a reload: a second visit costs 0 requests.
 *   4. Conditional revalidation
 *                         stale-but-usable data returns instantly and refreshes
 *                         with `If-None-Match`, which the engine answers with a
 *                         bodyless 304 — zero handler executions.
 *   5. Microtask batching everything else in the same tick rides in one request.
 *   6. CDN transport      public reads go out as `GET`, so the edge answers
 *                         repeat readers without scheduling an isolate at all.
 */

import { fnv1a64, stableStringify } from "../internal/canonical.js";
import type { ActionInput, ActionName, ActionPublic, RegistryOf } from "../types.js";
import { IdbStore, MemoryStore, type CacheEntry } from "./store.js";

export type { CacheEntry } from "./store.js";

/* -------------------------------------------------------------------------- */
/*                                   Options                                   */
/* -------------------------------------------------------------------------- */

export interface ClientCachePolicy {
  /** Fresh window in ms. */
  readonly ttlMs?: number | undefined;
  /** Extra window in ms where data is served instantly and revalidated. */
  readonly swrMs?: number | undefined;
  /** Mirror into IndexedDB so the value survives a reload. */
  readonly persist?: boolean | undefined;
  /** Skip cache reads and force the network. */
  readonly refresh?: boolean | undefined;
}

export type TransportMode = "auto" | "get" | "post";

export interface NaviClientOptions {
  /** Absolute or relative action endpoint. Default `/_navi/action`. */
  readonly endpoint?: string;
  /** Injectable `fetch` (tests, service workers, React Native). */
  readonly fetch?: typeof fetch;
  /** Current capability token; awaited at most once per call. */
  readonly token?: (() => string | undefined | Promise<string | undefined>) | undefined;
  /**
   * Identity mixed into cache keys. Two users sharing a browser must not share
   * private entries. Defaults to a hash of the token.
   */
  readonly identity?: (() => string | undefined | Promise<string | undefined>) | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Batch window in ms. `0` (default) flushes at the end of the microtask
   * queue, collapsing everything from one synchronous render pass. A positive
   * value waits, catching calls spread across animation frames.
   */
  readonly batchWindowMs?: number | undefined;
  readonly memoryEntries?: number | undefined;
  readonly idbEntries?: number | undefined;
  readonly transport?: TransportMode | undefined;
  /** Attach the `Authorization` header. Default true. */
  readonly credentials?: boolean | undefined;
  /** Request `_meta` from the server. Default true. */
  readonly meta?: boolean | undefined;
  /** Retries for transport/5xx failures. Default 1. A 4xx is never retried. */
  readonly retries?: number | undefined;
  /** Default abort signal for every call. */
  readonly signal?: AbortSignal | undefined;
  /** Longest payload Navi will put in a `GET` query string. */
  readonly maxGetPayloadChars?: number | undefined;
  /** Observability hook, fired on every suppression and every response. */
  readonly onMetrics?: ((snapshot: ClientSnapshot) => void) | undefined;
}

export interface CallOptions {
  readonly cache?: ClientCachePolicy | boolean | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Force a transport for this call only. */
  readonly transport?: TransportMode | undefined;
  /** Bypass the batch queue and flush immediately. */
  readonly immediate?: boolean | undefined;
}

export interface CallResult<T> {
  readonly data: T;
  /** Which local layer answered. */
  readonly tier: ClientTier;
  /** Tier the *server* reported, when it reported one. */
  readonly serverTier: string | undefined;
  readonly correlationId: string | undefined;
  readonly etag: string | undefined;
}

export type ClientTier = "MEMORY" | "IDB" | "INFLIGHT" | "BATCH" | "GET" | "NETWORK";

export interface ClientSnapshot {
  readonly calls: number;
  readonly networkRequests: number;
  /** Calls answered without a network request. */
  readonly suppressed: number;
  readonly byTier: Readonly<Record<ClientTier, number>>;
  readonly retries: number;
  /** Responses the server marked as served from a cache tier. */
  readonly serverAvoided: number;
  /** Calls the CDN answered without invoking an isolate. */
  readonly cdnHits: number;
}

/* -------------------------------------------------------------------------- */
/*                                   Internals                                 */
/* -------------------------------------------------------------------------- */

interface Waiter {
  resolve: (value: CallResult<unknown>) => void;
  reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  detached: boolean;
}

interface QueueItem {
  readonly id: string;
  readonly action: string;
  readonly payload: unknown;
  readonly cacheKey: string;
  readonly policy: NormalizedPolicy;
  readonly headers: Record<string, string>;
  readonly transport: TransportMode;
  /**
   * One entry per caller. An item fans its single result out to all of them, so
   * aborting one caller can never disturb the others.
   */
  readonly waiters: Set<Waiter>;
  settled: boolean;
  result: CallResult<unknown> | undefined;
  error: unknown;
}

interface PolicyLike {
  readonly ttlMs: number;
  readonly swrMs: number;
  readonly persist: boolean;
}

interface ManifestEntry {
  readonly cached: boolean;
  readonly scope: string;
  readonly ttl: number;
  readonly swr: number;
  readonly get: boolean;
  readonly cdn: boolean;
}

export interface ActionManifest {
  readonly version: number;
  readonly basePath: string;
  readonly maxBatchSize: number;
  readonly actions: Readonly<Record<string, ManifestEntry>>;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_SWR_MS = 0;
const DEFAULT_MAX_GET_CHARS = 1800;
const PROTOCOL_VERSION = 1;

type NormalizedPolicy = PolicyLike & { readonly refresh: boolean };

/* -------------------------------------------------------------------------- */
/*                                   Client                                    */
/* -------------------------------------------------------------------------- */

export class NaviClient<App = unknown> {
  readonly #endpoint: string;
  readonly #root: string;
  readonly #fetch: typeof fetch;
  readonly #options: NaviClientOptions;
  readonly #memory: MemoryStore;
  readonly #idb: IdbStore;
  readonly #queue: QueueItem[] = [];
  readonly #pending = new Map<string, QueueItem>();
  readonly #revalidating = new Set<string>();
  #scheduled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #manifest: Promise<ActionManifest | undefined> | undefined;
  #token: string | undefined;
  #tokenResolved = false;

  readonly #stats = {
    calls: 0,
    networkRequests: 0,
    suppressed: 0,
    retries: 0,
    serverAvoided: 0,
    cdnHits: 0,
    byTier: {
      MEMORY: 0,
      IDB: 0,
      INFLIGHT: 0,
      BATCH: 0,
      GET: 0,
      NETWORK: 0,
    } as Record<ClientTier, number>,
  };

  constructor(options?: NaviClientOptions) {
    this.#options = options ?? {};
    this.#endpoint = options?.endpoint ?? "/_navi/action";
    this.#root = this.#endpoint.replace(/\/action\/?$/, "");
    const bound = options?.fetch ?? globalThis.fetch;
    if (typeof bound !== "function") {
      throw new TypeError("NaviClient requires a `fetch` implementation (pass one via options).");
    }
    this.#fetch = bound.bind(globalThis) as typeof fetch;
    this.#memory = new MemoryStore(options?.memoryEntries ?? 200);
    this.#idb = new IdbStore(options?.idbEntries ?? 500);
  }

  /* ------------------------------- calling ------------------------------- */

  /**
   * Invoke an action. The resolved type is the *public* projection of the
   * handler's output: secret fields are not only stripped at runtime, they are
   * absent from the type.
   *
   * A field is secret in the type when it is branded `Secret<T>` (what
   * `@Secret` asks you to write) or named in a `schema:` passed to
   * `registerAction`. A bare `@Secret` on a `string` field still strips on the
   * wire, but the type cannot know — decorators run at runtime and cannot
   * rewrite the property — so the field stays visible to the type checker.
   */
  call<K extends ActionName<RegistryOf<App>>>(
    action: K,
    input?: ActionInput<RegistryOf<App>, K>,
    options?: CallOptions,
  ): Promise<ActionPublic<RegistryOf<App>, K>> {
    return this.#run(action as string, input, options).then((result) => result.data as ActionPublic<RegistryOf<App>, K>);
  }

  /** Same as `call`, but reports which tier answered. */
  callDetailed<K extends ActionName<RegistryOf<App>>>(
    action: K,
    input?: ActionInput<RegistryOf<App>, K>,
    options?: CallOptions,
  ): Promise<CallResult<ActionPublic<RegistryOf<App>, K>>> {
    return this.#run(action as string, input, options) as Promise<CallResult<ActionPublic<RegistryOf<App>, K>>>;
  }

  /** Fire-and-forget warm-up. Rejections are swallowed on purpose. */
  preload<K extends ActionName<RegistryOf<App>>>(
    action: K,
    input?: ActionInput<RegistryOf<App>, K>,
    options?: CallOptions,
  ): void {
    void this.#run(action as string, input, options).catch(() => undefined);
  }

  async #run(action: string, input: unknown, options: CallOptions | undefined): Promise<CallResult<unknown>> {
    this.#stats.calls++;
    const policy = normalizePolicy(options?.cache);
    await this.#resolveToken();
    const key = await this.#cacheKey(action, input);

    // 1. In-flight dedupe: the same call asked for more than once, before any
    //    response landed. One request, many callers.
    if (policy.refresh !== true) {
      // Only a *live* item may be joined. An item that already failed — for
      // instance because its only caller aborted before it was created — must
      // not hand its error to the next caller.
      const existing = this.#pending.get(key);
      if (existing !== undefined && !existing.settled) {
        this.#stats.suppressed++;
        this.#stats.byTier.INFLIGHT++;
        const shared = await this.#attach(existing, options?.signal);
        this.#emit();
        return { ...shared, tier: "INFLIGHT" };
      }
    }

    // 2. Memory tier — synchronous, so it is genuinely free.
    if (policy.refresh !== true) {
      const hit = this.#memory.lookup(key);
      if (hit.state !== "miss") {
        this.#stats.suppressed++;
        this.#stats.byTier.MEMORY++;
        if (hit.state === "stale") {
          this.#revalidate(action, key, input, hit.entry.etag, policy, options);
        }
        this.#emit();
        return {
          data: hit.entry.data,
          tier: "MEMORY",
          serverTier: undefined,
          correlationId: undefined,
          etag: hit.entry.etag,
        };
      }
    }

    // 3. Persistent tier. One IndexedDB read, so it is only consulted when the
    //    caller opted into persistence.
    if (policy.persist && policy.refresh !== true) {
      const persisted = await this.#idb.lookup(key);
      if (persisted.state !== "miss") {
        this.#memory.set(key, persisted.entry);
        this.#stats.suppressed++;
        this.#stats.byTier.IDB++;
        if (persisted.state === "stale") {
          this.#revalidate(action, key, input, persisted.entry.etag, policy, options);
        }
        this.#emit();
        return {
          data: persisted.entry.data,
          tier: "IDB",
          serverTier: undefined,
          correlationId: undefined,
          etag: persisted.entry.etag,
        };
      }
    }

    // 4. Network, through the batch queue.
    const item = this.#enqueue(action, input, key, policy, options);
    if (policy.refresh !== true && !item.settled) this.#pending.set(key, item);
    return await this.#attach(item, options?.signal);
  }

  /* ------------------------------ cache keys ----------------------------- */

  async #cacheKey(action: string, payload: unknown): Promise<string> {
    const canonical = stableStringify(payload);
    const payloadPart = canonical.ok ? fnv1a64(canonical.value) : "unserializable";
    const scope =
      this.#options.identity === undefined ? this.#token : await this.#options.identity();
    const scopePart = scope === undefined || scope === "" ? "public" : fnv1a64(scope);
    return `${action}|${scopePart}|${payloadPart}`;
  }

  /* -------------------------------- queue --------------------------------- */

  #enqueue(
    action: string,
    payload: unknown,
    key: string,
    policy: NormalizedPolicy,
    options: CallOptions | undefined,
  ): QueueItem {
    const signal = options?.signal ?? this.#options.signal;
    const item: QueueItem = {
      id: crypto.randomUUID(),
      action,
      payload,
      cacheKey: key,
      policy,
      headers: { ...this.#options.headers, ...options?.headers },
      transport: options?.transport ?? this.#options.transport ?? "auto",
      waiters: new Set(),
      settled: false,
      result: undefined,
      error: undefined,
    };

    if (signal?.aborted === true) {
      // Nothing to send: fail this caller before the item reaches the queue.
      // No waiter exists yet, so `#fail` only records the outcome.
      this.#fail(item, abortError(signal.reason));
      return item;
    }

    this.#queue.push(item);
    this.#schedule(options?.immediate === true);
    return item;
  }

  /**
   * Adds one caller to an item and returns that caller's own promise.
   *
   * Every caller gets a distinct deferred: aborting detaches that caller alone,
   * and the item keeps travelling for whoever is still waiting. A caller that
   * arrives after the item settled is answered from the recorded result without
   * a new request.
   */
  #attach(item: QueueItem, signal: AbortSignal | undefined): Promise<CallResult<unknown>> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal.reason));
    if (item.settled) {
      return item.error === undefined
        ? Promise.resolve(item.result as CallResult<unknown>)
        : Promise.reject(item.error);
    }

    return new Promise<CallResult<unknown>>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, detached: false };
      item.waiters.add(waiter);

      if (signal !== undefined) {
        signal.addEventListener(
          "abort",
          () => {
            if (item.settled) return;
            // Detach this caller only. The item lives on if anyone else is
            // still waiting, so the request is not cancelled for them.
            item.waiters.delete(waiter);
            waiter.detached = true;
            reject(abortError(signal.reason));
          },
          { once: true },
        );
      }
    });
  }

  #schedule(immediate: boolean): void {
    const window = this.#options.batchWindowMs ?? 0;
    if (immediate) {
      // The open window no longer owns the queue, so it cannot veto the flush.
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#scheduled = false;
      queueMicrotask(() => this.#flushNow());
      return;
    }
    if (this.#scheduled) return;
    this.#scheduled = true;
    const flush = (): void => this.#flushNow();
    if (window <= 0) queueMicrotask(flush);
    else this.#timer = setTimeout(flush, window);
  }

  #flushNow(): void {
    this.#scheduled = false;
    this.#timer = undefined;
    void this.#flush().catch(() => undefined);
  }

  /**
   * One batch window. Two rules:
   *  - a lone item goes out as a single action, or as a `GET` when the manifest
   *    says the CDN can serve it (CDN caching beats batching when both apply);
   *  - everything else goes out as one multiplexed batch, so N widgets cost one
   *    invocation.
   */
  async #flush(): Promise<void> {
    const queued = this.#queue.splice(0, this.#queue.length);
    const live = queued.filter((item) => !item.settled && item.waiters.size > 0);
    if (live.length === 0) return;

    const manifest = live.some((item) => item.transport === "auto") ? await this.#loadManifest() : undefined;

    const getItems: QueueItem[] = [];
    const postItems: QueueItem[] = [];
    for (const item of live) {
      if (this.#shouldUseGet(item, manifest)) getItems.push(item);
      else postItems.push(item);
    }

    await Promise.all([
      ...getItems.map((item) => this.#sendGet(item)),
      ...(postItems.length === 0 ? [] : [this.#sendBatch(postItems)]),
    ]);
  }

  /**
   * `GET` is only worth it when the server said the action is CDN-eligible and
   * the payload actually fits in a URL.
   */
  #shouldUseGet(item: QueueItem, manifest: ActionManifest | undefined): boolean {
    if (item.transport === "get") return true;
    if (item.transport === "post") return false;
    if (manifest === undefined) return false;
    const entry = manifest.actions[item.action];
    if (entry === undefined || entry.get !== true || entry.cdn !== true) return false;
    const canonical = stableStringify(item.payload);
    if (!canonical.ok) return false;
    return canonical.value.length <= (this.#options.maxGetPayloadChars ?? DEFAULT_MAX_GET_CHARS);
  }

  /* ------------------------------ transports ----------------------------- */

  async #sendBatch(items: readonly QueueItem[]): Promise<void> {
    const body = JSON.stringify({
      _batch: items.map((item) => ({ id: item.id, action: item.action, payload: item.payload })),
      v: PROTOCOL_VERSION,
    });

    let response: Response;
    try {
      response = await this.#request(this.#endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...mergeHeaders(items) },
        body,
      });
    } catch (error) {
      for (const item of items) this.#fail(item, error);
      return;
    }

    const envelope = (await readJson(response)) as BatchEnvelopeWire;

    // A request-level failure (401, 403, 413, 429, 500) answers with a single
    // error envelope and no `results` at all. Reporting that as a per-item
    // MISSING_RESULT would throw away the only useful part of the response.
    if (envelope.ok !== true && envelope.error !== undefined) {
      for (const item of items) {
        this.#fail(
          item,
          new NaviClientError(
            envelope.error.code ?? "EXECUTION_ERROR",
            envelope.error.message ?? `HTTP ${response.status}`,
            envelope.error.tip,
          ),
        );
      }
      return;
    }

    const byId = new Map<string, BatchItemWire>();
    for (const entry of envelope.results ?? []) byId.set(entry.id, entry);

    for (const item of items) {
      const result = byId.get(item.id);
      if (result === undefined) {
        this.#fail(item, new NaviClientError("MISSING_RESULT", `No result for '${item.action}' in batch response.`));
        continue;
      }
      if (!result.ok) {
        this.#fail(item, new NaviClientError(result.error?.code ?? "EXECUTION_ERROR", result.error?.message ?? "Action failed", result.error?.tip));
        continue;
      }
      const etag = items.length === 1 ? response.headers.get("ETag") ?? undefined : undefined;
      this.#store(item.cacheKey, item.policy, result.data, etag);
      if (result.cacheHit !== undefined && result.cacheHit !== "NONE") this.#stats.serverAvoided++;
      this.#stats.byTier.BATCH++;
      this.#settle(item, {
        data: result.data,
        tier: "BATCH",
        serverTier: result.cacheHit,
        correlationId: envelope.correlationId,
        etag,
      });
    }
    this.#emit();
  }

  async #sendGet(item: QueueItem): Promise<void> {
    const payload = JSON.stringify(item.payload ?? null);
    const url = `${this.#root}/a/${encodeURIComponent(item.action)}?p=${encodeURIComponent(payload)}`;

    let response: Response;
    try {
      // The default HTTP cache is left alone on purpose: for a CDN-eligible
      // read, the browser and edge caches answering directly is the goal.
      response = await this.#request(url, { method: "GET", headers: item.headers });
    } catch (error) {
      this.#fail(item, error);
      return;
    }

    const envelope = (await readJson(response)) as SingleEnvelopeWire;
    if (envelope.ok !== true) {
      this.#fail(item, new NaviClientError(envelope.error?.code ?? "EXECUTION_ERROR", envelope.error?.message ?? `HTTP ${response.status}`, envelope.error?.tip));
      return;
    }

    const etag = response.headers.get("ETag") ?? undefined;
    this.#store(item.cacheKey, item.policy, envelope.data, etag);

    // A CDN-served response carries no `_meta` at all; the `Age` header is the
    // tell that the request never reached an isolate.
    const servedByCdn = envelope._meta === undefined;
    if (servedByCdn) this.#stats.cdnHits++;
    else if (envelope._meta?.cacheHit !== undefined && envelope._meta.cacheHit !== "NONE") this.#stats.serverAvoided++;

    this.#stats.byTier.GET++;
    this.#settle(item, {
      data: envelope.data,
      tier: "GET",
      serverTier: servedByCdn ? "CDN" : envelope._meta?.cacheHit,
      correlationId: envelope.correlationId,
      etag,
    });
    this.#emit();
  }

  /* ----------------------------- revalidation ---------------------------- */

  /**
   * One conditional revalidation per key at a time, always in the background:
   * the caller already has usable data, so there is nothing to wait for.
   */
  #revalidate(
    action: string,
    key: string,
    payload: unknown,
    etag: string | undefined,
    policy: NormalizedPolicy,
    options: CallOptions | undefined,
  ): void {
    if (this.#revalidating.has(key)) return;
    this.#revalidating.add(key);

    void (async () => {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...this.#options.headers,
          ...options?.headers,
        };
        if (etag !== undefined) headers["If-None-Match"] = etag;

        const response = await this.#request(this.#endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ action, payload, v: PROTOCOL_VERSION }),
        });

        if (response.status === 304) {
          // Unchanged: extend the entry without transferring a body, and
          // without the server having run the handler.
          const current = this.#memory.lookup(key);
          if (current.state !== "miss") {
            const now = Date.now();
            this.#store(key, policy, current.entry.data, current.entry.etag, {
              freshUntil: now + policy.ttlMs,
              staleUntil: now + policy.ttlMs + policy.swrMs,
            });
          }
          this.#stats.serverAvoided++;
          return;
        }

        const envelope = (await readJson(response)) as SingleEnvelopeWire;
        if (envelope.ok !== true) return;
        this.#store(key, policy, envelope.data, response.headers.get("ETag") ?? undefined);
        if (envelope._meta?.cacheHit !== undefined && envelope._meta.cacheHit !== "NONE") this.#stats.serverAvoided++;
      } catch {
        // A failed background refresh is not a failure the caller can see.
      } finally {
        this.#revalidating.delete(key);
        this.#emit();
      }
    })();
  }

  /* -------------------------------- storage ------------------------------ */

  #store(
    key: string,
    policy: PolicyLike,
    data: unknown,
    etag: string | undefined,
    windows?: { freshUntil: number; staleUntil: number },
  ): void {
    const now = Date.now();
    const entry: CacheEntry = {
      data,
      etag,
      storedAt: now,
      freshUntil: windows?.freshUntil ?? now + policy.ttlMs,
      staleUntil: windows?.staleUntil ?? now + policy.ttlMs + policy.swrMs,
    };
    this.#memory.set(key, entry);
    if (policy.persist) void this.#idb.set(key, entry);
  }

  /**
   * Drop client entries. Omit `action` to clear everything; omit `payload` to
   * clear one action's entries.
   */
  async invalidate(action?: string, payload?: unknown): Promise<{ memory: number; idb: number }> {
    if (action === undefined) {
      const memory = this.#memory.clear();
      const idb = await this.#idb.clear();
      this.#emit();
      return { memory, idb };
    }
    const prefix = payload === undefined ? `${action}|` : await this.#cacheKey(action, payload);
    const memory = this.#memory.deletePrefix(prefix);
    const idb = await this.#idb.deletePrefix(prefix);
    this.#emit();
    return { memory, idb };
  }

  metrics(): ClientSnapshot {
    return { ...this.#stats, byTier: { ...this.#stats.byTier } };
  }

  /* -------------------------------- network ------------------------------ */

  /**
   * `fetch` with bounded retries on transport failures and 5xx only. A 4xx is a
   * verdict, not a hiccup — retrying it would spend an invocation to be told
   * the same thing.
   */
  async #request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const maxRetries = this.#options.retries ?? 1;
    const headers = new Headers(init.headers);
    if (this.#options.credentials !== false && this.#token !== undefined && this.#token !== "") {
      headers.set("Authorization", `Bearer ${this.#token}`);
    }
    if (this.#options.meta === false) headers.set("X-Navi-Meta", "0");
    const request: RequestInit = signal === undefined ? { ...init, headers } : { ...init, headers, signal };

    let attempt = 0;
    for (;;) {
      this.#stats.networkRequests++;
      try {
        const response = await this.#fetch(url, request);
        if (response.status < 500 || attempt >= maxRetries) return response;
        attempt++;
        this.#stats.retries++;
      } catch (error) {
        if (attempt >= maxRetries || (error instanceof Error && error.name === "AbortError")) throw error;
        attempt++;
        this.#stats.retries++;
        await delay(2 ** attempt * 40);
      }
    }
  }

  async #resolveToken(): Promise<void> {
    if (this.#tokenResolved || this.#options.token === undefined) return;
    this.#tokenResolved = true;
    this.#token = (await this.#options.token()) ?? undefined;
  }

  /* -------------------------------- manifest ----------------------------- */

  /**
   * The manifest lists which actions the CDN can answer. It is a static
   * document with a day of `s-maxage`, so loading it is close to free, and it is
   * memoized for the life of the client. A failure is not fatal: the client
   * simply keeps using the POST transport.
   */
  async #loadManifest(): Promise<ActionManifest | undefined> {
    this.#manifest ??= (async () => {
      if (this.#options.transport === "post") return undefined;
      await this.#resolveToken();
      try {
        const headers = new Headers(this.#options.headers);
        if (this.#options.credentials !== false && this.#token !== undefined && this.#token !== "") {
          headers.set("Authorization", `Bearer ${this.#token}`);
        }
        const response = await this.#fetch(`${this.#root}/manifest`, { headers });
        this.#stats.networkRequests++;
        if (!response.ok) return undefined;
        return (await response.json()) as ActionManifest;
      } catch {
        return undefined;
      }
    })();
    return this.#manifest;
  }

  /** The cached manifest, or `undefined` if it could not be loaded. */
  async manifest(): Promise<ActionManifest | undefined> {
    return this.#loadManifest();
  }

  /* ------------------------------- internals ----------------------------- */

  #settle(item: QueueItem, result: CallResult<unknown>): void {
    if (item.settled) return;
    item.settled = true;
    item.result = result;
    for (const waiter of item.waiters) waiter.resolve(result);
    item.waiters.clear();
    this.#retire(item);
  }

  #fail(item: QueueItem, error: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.error = error;
    for (const waiter of item.waiters) waiter.reject(error);
    item.waiters.clear();
    this.#retire(item);
  }

  /** An item that has been answered must not dedupe the next call. */
  #retire(item: QueueItem): void {
    if (this.#pending.get(item.cacheKey) === item) this.#pending.delete(item.cacheKey);
  }

  #emit(): void {
    this.#options.onMetrics?.(this.metrics());
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                   */
/* -------------------------------------------------------------------------- */

interface SingleEnvelopeWire {
  ok?: boolean;
  data?: unknown;
  correlationId?: string;
  error?: { code?: string; message?: string; tip?: string };
  _meta?: { cacheHit?: string; avoidedInvocation?: boolean };
}

interface BatchItemWire {
  readonly id: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly cacheHit?: string;
  readonly error?: { code?: string; message?: string; tip?: string };
}

interface BatchEnvelopeWire {
  ok?: boolean;
  correlationId?: string;
  results?: readonly BatchItemWire[];
  error?: { code?: string; message?: string; tip?: string };
  _meta?: { avoidedInvocation?: boolean };
}

function normalizePolicy(cache: ClientCachePolicy | boolean | undefined): NormalizedPolicy {
  if (cache === false) return { ttlMs: 0, swrMs: 0, persist: false, refresh: true };
  if (cache === true || cache === undefined) {
    return { ttlMs: DEFAULT_TTL_MS, swrMs: DEFAULT_SWR_MS, persist: false, refresh: false };
  }
  return {
    ttlMs: cache.ttlMs ?? DEFAULT_TTL_MS,
    swrMs: cache.swrMs ?? DEFAULT_SWR_MS,
    persist: cache.persist ?? false,
    refresh: cache.refresh ?? false,
  };
}

function mergeHeaders(items: readonly QueueItem[]): Record<string, string> {
  // Every item in a batch shares the client-level headers; per-call headers are
  // applied on the first item, which is the documented behaviour.
  return { ...(items[0]?.headers ?? {}) };
}

export class NaviClientError extends Error {
  override readonly name = "NaviClientError";
  readonly code: string;
  readonly tip: string | undefined;

  constructor(code: string, message: string, tip?: string) {
    super(message);
    this.code = code;
    this.tip = tip;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return { ok: false, error: { code: "MALFORMED_JSON", message: `HTTP ${response.status}: non-JSON response` } };
  }
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
