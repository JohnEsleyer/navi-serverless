/**
 * Edge cache engine.
 *
 * Three tiers, cheapest first, all sharing one key space:
 *
 *   L1  Isolate heap      ~0.02ms, survives requests in the same V8 isolate,
 *                          gone on evict/eviction. Optional SWR window.
 *   L2  `caches.default`  Web-standard Cache API (Cloudflare, Vercel Edge,
 *                          Fastly, Deno Deploy). Survives isolate eviction.
 *   CDN `s-maxage`        The only tier that removes a *billed invocation*
 *                          entirely, because the request never reaches a
 *                          worker at all. Enabled via `cache.cdn` for
 *                          public, GET-reachable actions.
 *
 * `Singleflight` is the piece that actually kills stampedes: 500 concurrent
 * requests for the same key inside one isolate produce exactly one handler run.
 */

import { fnv1a64, stableStringify } from "./internal/canonical.js";

/* -------------------------------------------------------------------------- */
/*                                 Singleflight                                */
/* -------------------------------------------------------------------------- */

interface InFlight<T> {
  promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
}

/**
 * Guarantees one execution per key per isolate. Waiters receive the leader's
 * result, including its rejection, so a failed stampede does not turn into N
 * retries (which would be strictly more expensive than the stampede).
 */
export class Singleflight {
  readonly #inFlight = new Map<string, InFlight<unknown>>();
  /** Observability: how many calls were served by somebody else's execution. */
  coalescedCount = 0;

  get size(): number {
    return this.#inFlight.size;
  }

  async do<T>(
    key: string,
    fn: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<{ result: T; shared: boolean; coalesced: number }> {
    const existing = this.#inFlight.get(key) as InFlight<T> | undefined;
    if (existing !== undefined) {
      existing.waiters++;
      this.coalescedCount++;
      const result = await existing.promise;
      return { result, shared: true, coalesced: existing.waiters };
    }

    const controller = new AbortController();
    // Build the shared promise before publishing the entry, so a waiter can
    // never observe a half-initialized record.
    const promise = (async () => fn(controller.signal))();
    const entry: InFlight<T> = { controller, waiters: 1, promise };
    this.#inFlight.set(key, entry as InFlight<unknown>);

    try {
      const result = await promise;
      return { result, shared: false, coalesced: entry.waiters };
    } finally {
      if (this.#inFlight.get(key) === (entry as InFlight<unknown>)) {
        this.#inFlight.delete(key);
      }
    }
  }

  /** Is anything running for this key right now? Used by the client-suppressor. */
  has(key: string): boolean {
    return this.#inFlight.has(key);
  }

  keys(): IterableIterator<string> {
    return this.#inFlight.keys();
  }
}

/* -------------------------------------------------------------------------- */
/*                                L1 heap cache                                */
/* -------------------------------------------------------------------------- */

export interface L1Entry<T = unknown> {
  readonly value: T;
  /** Fresh until this timestamp. */
  readonly freshUntil: number;
  /** Usable-but-stale until this timestamp (SWR). */
  readonly staleUntil: number;
  /** Content hash, exposed as an ETag so a stale hit can answer `304`. */
  readonly etag: string;
  readonly tags: readonly string[];
  /**
   * Whatever the caller needs to *rebuild* this entry later — Navi stores the
   * originating payload here so a background revalidation can replay the exact
   * request that filled the cache. Never serialized to L2.
   */
  readonly meta?: unknown;
  /** Last time the entry was read — drives LRU eviction. */
  touchedAt: number;
}

export type L1Lookup<T = unknown> =
  | { readonly state: "miss" }
  | { readonly state: "fresh"; readonly entry: L1Entry<T> }
  | { readonly state: "stale"; readonly entry: L1Entry<T> };

/**
 * Bounded LRU with per-entry TTL + SWR.
 *
 * Uses a `Map` (insertion-ordered) plus lazy promotion on read: touching an
 * entry deletes and re-inserts it, which costs one hash op and keeps eviction
 * O(1) without a doubly-linked list. Also tracks a tag → keys index so
 * `invalidate("product:1")` is O(matching entries) instead of O(store).
 */
export class IsolateL1Cache {
  readonly #store = new Map<string, L1Entry>();
  readonly #tags = new Map<string, Set<string>>();
  readonly #max: number;
  hits = 0;
  misses = 0;
  staleHits = 0;
  evictions = 0;

  constructor(maxEntries = 1000) {
    this.#max = Math.max(16, maxEntries | 0);
  }

  get size(): number {
    return this.#store.size;
  }

  get stats(): { hits: number; misses: number; staleHits: number; evictions: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      staleHits: this.staleHits,
      evictions: this.evictions,
      size: this.#store.size,
    };
  }

  lookup<T>(key: string): L1Lookup<T> {
    const entry = this.#store.get(key) as L1Entry<T> | undefined;
    if (entry === undefined) {
      this.misses++;
      return { state: "miss" };
    }

    const now = Date.now();
    if (now <= entry.freshUntil) {
      entry.touchedAt = now;
      this.#store.delete(key);
      this.#store.set(key, entry as L1Entry);
      this.hits++;
      return { state: "fresh", entry };
    }

    if (now <= entry.staleUntil) {
      entry.touchedAt = now;
      this.staleHits++;
      return { state: "stale", entry };
    }

    this.misses++;
    this.#miss(key);
    return { state: "miss" };
  }

  /** Read an entry without touching LRU order or the hit/miss counters. */
  peek<T>(key: string): L1Entry<T> | undefined {
    return this.#store.get(key) as L1Entry<T> | undefined;
  }

  set<T>(
    key: string,
    value: T,
    opts: {
      ttlSeconds: number;
      swrSeconds?: number | undefined;
      etag?: string | undefined;
      tags?: readonly string[] | undefined;
      meta?: unknown;
    },
  ): L1Entry<T> {
    const now = Date.now();
    const entry: L1Entry<T> = {
      value,
      freshUntil: now + Math.max(0, opts.ttlSeconds) * 1000,
      staleUntil: now + (Math.max(0, opts.ttlSeconds) + Math.max(0, opts.swrSeconds ?? 0)) * 1000,
      etag: opts.etag ?? `"${fnv1a64(key)}"`,
      tags: opts.tags ?? [],
      meta: opts.meta,
      touchedAt: now,
    };

    const previous = this.#store.get(key);
    if (previous !== undefined) this.#untag(key, previous.tags);

    this.#store.delete(key);
    this.#store.set(key, entry as L1Entry);
    for (const tag of entry.tags) this.#tag(tag, key);

    this.#evictIfNeeded();
    return entry;
  }

  delete(key: string): boolean {
    const entry = this.#store.get(key);
    if (entry === undefined) return false;
    this.#untag(key, entry.tags);
    this.#store.delete(key);
    return true;
  }

  /** Drop every entry carrying `tag`. Returns how many were dropped. */
  invalidateTag(tag: string): number {
    const keys = this.#tags.get(tag);
    if (keys === undefined) return 0;
    let dropped = 0;
    for (const key of [...keys]) {
      if (this.delete(key)) dropped++;
    }
    this.#tags.delete(tag);
    return dropped;
  }

  /** Drop keys matching a prefix — used by `app.invalidate("getProduct:")`. */
  invalidatePrefix(prefix: string): number {
    let dropped = 0;
    for (const key of [...this.#store.keys()]) {
      if (key.startsWith(prefix) && this.delete(key)) dropped++;
    }
    return dropped;
  }

  clear(): void {
    this.#store.clear();
    this.#tags.clear();
  }

  /** Remove without the boolean return; used by the expiry path. */
  #miss(key: string): void {
    const entry = this.#store.get(key);
    if (entry === undefined) return;
    this.#untag(key, entry.tags);
    this.#store.delete(key);
  }

  /** Keep memory bounded in long-lived isolates (Vercel Edge reuses one). */
  trim(now = Date.now()): number {
    let dropped = 0;
    for (const [key, entry] of [...this.#store]) {
      if (now > entry.staleUntil) {
        this.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  #evictIfNeeded(): void {    while (this.#store.size > this.#max) {
      // Map iteration is insertion-ordered and `set` re-inserts on touch, so the
      // first key is the least-recently-used one.
      const oldest = this.#store.keys().next();
      if (oldest.done === true) return;
      this.delete(oldest.value);
      this.evictions++;
    }
  }

  #tag(tag: string, key: string): void {
    const set = this.#tags.get(tag) ?? new Set<string>();
    set.add(key);
    this.#tags.set(tag, set);
  }

  #untag(key: string, tags: readonly string[]): void {
    for (const tag of tags) {
      const set = this.#tags.get(tag);
      if (set === undefined) continue;
      set.delete(key);
      if (set.size === 0) this.#tags.delete(tag);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                             L2 — Cache API                                  */
/* -------------------------------------------------------------------------- */

/**
 * Structural subset of the Cache API. Declared locally so the package does not
 * depend on `lib.webworker` being present in the consumer's tsconfig — Cloudflare,
 * Vercel, Deno Deploy and Bun all expose `caches.default` at runtime.
 */
export interface EdgeCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

export interface EdgeCacheStorage {
  readonly default: EdgeCache;
}

function edgeCache(): EdgeCache | undefined {
  const storage = (globalThis as { caches?: Partial<EdgeCacheStorage> }).caches;
  const cache = storage?.default;
  return cache !== undefined && typeof cache.match === "function" ? cache : undefined;
}

/** Synthetic origin used as the Cache API key. Never leaves the isolate. */
const EDGE_ORIGIN = "https://navi.internal";

export interface L2Options {
  /** Wall-clock lifetime written into the cached `Response`. */
  readonly ttlSeconds: number;
  readonly swrSeconds?: number | undefined;
  readonly tags?: readonly string[] | undefined;
}

/**
 * L2 wrapper.
 *
 * Two deliberate deviations from the naive implementation:
 *  - reads never throw (an unavailable Cache API must degrade to a miss, not a
 *    500), and
 *  - entries are stored with `stale-while-revalidate` so a *second* request can
 *    still be served while the first refreshes.
 */
export class EdgeL2Cache {
  static keyUrl(key: string): string {
    return `${EDGE_ORIGIN}/_navi/cache/${encodeURIComponent(key)}`;
  }

  static async match<T = unknown>(key: string): Promise<{ value: T; etag: string | undefined } | undefined> {
    const cache = edgeCache();
    if (cache === undefined) return undefined;
    try {
      const hit = await cache.match(EdgeL2Cache.keyUrl(key));
      if (hit === undefined || hit === null) return undefined;
      const value = (await hit.json()) as T;
      return { value, etag: hit.headers.get("ETag") ?? undefined };
    } catch {
      return undefined;
    }
  }

  static async put(key: string, value: unknown, opts: L2Options): Promise<void> {
    const cache = edgeCache();
    if (cache === undefined) return;
    const body = JSON.stringify(value);
    const ttl = Math.max(1, Math.floor(opts.ttlSeconds));
    const swr = Math.max(0, Math.floor(opts.swrSeconds ?? 0));
    const etag = `"${fnv1a64(body)}"`;

    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      // The Cache API honours the response's own freshness, so encode the full
      // fresh+stale window here. Callers get the sub-windows from `_navi.cache`.
      "Cache-Control": swr > 0 ? `public, max-age=${ttl + swr}, stale-while-revalidate=${swr}` : `public, max-age=${ttl}`,
      ETag: etag,
    });
    if (opts.tags !== undefined && opts.tags.length > 0) {
      headers.set("Cache-Tag", opts.tags.join(" "));
    }

    try {
      await cache.put(EdgeL2Cache.keyUrl(key), new Response(body, { headers }));
    } catch {
      // Quota, unsupported method, or a platform that forbids synthetic origins.
      // Caching is an optimization; never let it fail a request.
    }
  }

  static async delete(key: string): Promise<boolean> {
    const cache = edgeCache();
    if (cache === undefined) return false;
    try {
      return await cache.delete(EdgeL2Cache.keyUrl(key));
    } catch {
      return false;
    }
  }

  /** Availability probe, surfaced through `/__navi/health`. */
  static get available(): boolean {
    return edgeCache() !== undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Key derivation                                 */
/* -------------------------------------------------------------------------- */

export interface CacheKeyInput {
  readonly action: string;
  readonly identity: string;
  readonly payload: unknown;
}

/**
 * Derives a bounded, collision-resistant cache key.
 *
 * Payloads that cannot be canonically serialized (functions, cycles, NaN) are
 * *not* cacheable — hashing them would silently alias different inputs onto the
 * same key, which is a correctness bug that shows up as wrong data under load.
 */
export function deriveCacheKey(input: CacheKeyInput): string | undefined {
  const canonical = stableStringify(input.payload);
  if (!canonical.ok) return undefined;
  const suffix = input.payload === undefined ? "" : fnv1a64(canonical.value);
  return `${input.action}|${input.identity}|${suffix}`;
}
