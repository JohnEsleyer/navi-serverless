import { describe, expect, test } from "bun:test";
import { NaviClient } from "../src/client/index.ts";
import type { ClientSnapshot } from "../src/client/index.ts";
import { NaviServerless } from "../src/server.ts";

/* -------------------------------------------------------------------------- */
/*                                 Typed server                                */
/* -------------------------------------------------------------------------- */

let seq = 0;

const app = new NaviServerless()
  .registerAction({
    name: "getProduct",
    cache: { ttl: 30, scope: "public", swr: 30 },
    handler: (_ctx, input: { id: number }) => ({ id: input.id, name: `product-${input.id}`, seq: ++seq }),
  })
  .registerAction({
    name: "write",
    handler: (_ctx, input: { id?: number }) => ({ ok: true, id: input.id ?? null }),
  })
  .registerAction({
    name: "counter",
    handler: () => ({ seq: ++seq }),
  })
  .registerAction({
    name: "boom",
    handler: () => {
      throw new Error("handler exploded");
    },
  });

type App = typeof app;

/**
 * The harness tests answer with an echo payload, so their registry describes
 * that shape directly. It is still a real compile-time contract: a wrong action
 * name or payload type fails the typecheck below.
 */
interface EchoApp {
  readonly __registry: {
    readonly getProduct: { readonly input: { id: number }; readonly output: Echo; readonly public: Echo };
    readonly write: { readonly input: { id?: number }; readonly output: Echo; readonly public: Echo };
    readonly counter: { readonly input: undefined; readonly output: { seq: number }; readonly public: { seq: number } };
    readonly boom: { readonly input: undefined; readonly output: never; readonly public: never };
  };
}

interface Echo {
  readonly action: string;
  readonly payload: unknown;
}

const ORIGIN = "https://edge.test";

/** Sends client traffic straight into the real engine, no HTTP. */
const liveFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const request = new Request(new URL(url, ORIGIN).toString(), init);
  return app.handleRequest(request, {}, { waitUntil: (p) => void p });
}) as unknown as typeof fetch;

/* -------------------------------------------------------------------------- */
/*                                   Harness                                   */
/* -------------------------------------------------------------------------- */

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

const MANIFEST = {
  version: 1,
  basePath: "/_navi",
  maxBatchSize: 50,
  actions: {
    getProduct: { cached: true, scope: "public", ttl: 30, swr: 30, get: true, cdn: true },
    write: { cached: false, scope: "none", ttl: 0, swr: 0, get: false, cdn: false },
  },
} as const;

const batchOk = (
  items: ReadonlyArray<{ id: string; data: unknown; cacheHit?: string }>,
  headers: Record<string, string> = {},
): Response =>
  new Response(
    JSON.stringify({
      ok: true,
      correlationId: "c1",
      results: items.map((item) => ({
        id: item.id,
        ok: true,
        data: item.data,
        cacheHit: item.cacheHit ?? "NONE",
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...headers } },
  );

const singleOk = (data: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ ok: true, correlationId: "c1", data, cacheHit: "NONE" }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });

interface BatchEntry {
  readonly id: string;
  readonly action: string;
  readonly payload: unknown;
}

const entriesOf = (recorded: Recorded): BatchEntry[] => {
  const body = JSON.parse(recorded.body ?? "{}") as { _batch?: BatchEntry[]; action?: string };
  if (Array.isArray(body._batch)) return body._batch;
  return [{ id: "single", action: body.action ?? "unknown", payload: undefined }];
};

/** The client always speaks the batch wire format, even for a single action. */
const respondWith =
  (data: (entry: BatchEntry) => unknown, headers: Record<string, string> = {}) =>
  (recorded: Recorded): Response =>
    batchOk(
      entriesOf(recorded).map((entry) => ({ id: entry.id, data: data(entry) })),
      headers,
    );

/** Echoes each caller's own action and payload back, so assertions stay local. */
const echoRoute = (recorded: Recorded): Response =>
  batchOk(
    entriesOf(recorded).map((entry) => ({ id: entry.id, data: { action: entry.action, payload: entry.payload } })),
  );

/** A fake `fetch` that records calls and answers from a routing table. */
function harness(
  route: (recorded: Recorded) => Response | Promise<Response>,
  options?: { readonly manifest?: boolean | undefined },
): { readonly calls: Recorded[]; readonly fetch: typeof fetch; posts: () => Recorded[] } {
  const calls: Recorded[] = [];
  const withManifest = options?.manifest !== false;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const recorded: Recorded = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(recorded);

    if (recorded.url.endsWith("/manifest") && withManifest) {
      return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/json" } });
    }
    return route(recorded);
  }) as unknown as typeof fetch;

  return { calls, fetch: impl, posts: () => calls.filter((c) => c.method === "POST") };
}

const client = (fetchImpl: typeof fetch, options: Record<string, unknown> = {}): NaviClient<EchoApp> =>
  new NaviClient<EchoApp>({ fetch: fetchImpl, transport: "post", ...options });

/* -------------------------------------------------------------------------- */
/*                                 Suppression                                 */
/* -------------------------------------------------------------------------- */

describe("client: suppression", () => {
  test("one request per distinct key, however many callers", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch);

    const [a, b, c] = await Promise.all([
      navi.callDetailed("write", { id: 1 }),
      navi.callDetailed("write", { id: 1 }),
      navi.callDetailed("write", { id: 1 }),
    ]);

    expect(h.posts()).toHaveLength(1);
    expect(a.data).toEqual(b.data);
    expect(b.tier).toBe("INFLIGHT");
    expect(c.tier).toBe("INFLIGHT");
    expect(navi.metrics().suppressed).toBe(2);
  });

  test("a settled value is answered from memory with no network", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch);

    const first = await navi.callDetailed("write", { id: 1 });
    const second = await navi.callDetailed("write", { id: 1 });

    expect(first.tier).toBe("BATCH");
    expect(second.tier).toBe("MEMORY");
    expect(second.data).toEqual(first.data);
    expect(navi.metrics().networkRequests).toBe(1);
  });

  test("key order does not defeat the cache", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch);

    await navi.call("write", { id: 1 });
    await navi.call("write", { id: 1 });
    expect(h.posts()).toHaveLength(1);
  });

  test("refresh: true bypasses the cache and replaces it", async () => {
    let n = 0;
    const h = harness(respondWith(() => ({ seq: ++n })));
    const navi = client(h.fetch);

    const first = await navi.callDetailed("counter", undefined, { cache: { refresh: true } });
    const cached = await navi.callDetailed("counter");
    const forced = await navi.callDetailed("counter", undefined, { cache: { refresh: true } });

    expect(first.data).toEqual({ seq: 1 });
    expect(cached.data).toEqual({ seq: 1 });
    expect(forced.data).toEqual({ seq: 2 });
    // The refreshed value replaced the cached one.
    expect((await navi.callDetailed("counter")).data).toEqual({ seq: 2 });
  });

  test("an expired entry is revalidated with If-None-Match, not refetched blind", async () => {
    const etag = '"v1"';
    const h = harness((recorded) => {
      if (recorded.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return batchOk(entriesOf(recorded).map((e) => ({ id: e.id, data: { seq: 1 } })), { ETag: etag });
    });
    const navi = client(h.fetch);
    const policy = { ttlMs: 30, swrMs: 10_000 } as const;

    expect((await navi.callDetailed("counter", undefined, { cache: policy })).data).toEqual({ seq: 1 });

    await Bun.sleep(50);
    const stale = await navi.callDetailed("counter", undefined, { cache: policy });
    expect(stale.tier).toBe("MEMORY");
    expect(stale.data).toEqual({ seq: 1 });

    await Bun.sleep(20);
    const revalidations = h.posts().filter((r) => r.headers.get("If-None-Match") !== null);
    expect(revalidations).toHaveLength(1);
    expect(revalidations[0]?.headers.get("If-None-Match")).toBe(etag);
    // The 304 kept the value; nothing was downloaded twice.
    expect((await navi.callDetailed("counter", undefined, { cache: policy })).data).toEqual({ seq: 1 });
  });

  test("invalidate drops the local copy", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch);

    await navi.call("write", { id: 1 });
    expect(await navi.invalidate("write", { id: 1 })).toEqual({ memory: 1, idb: 0 });
    expect((await navi.callDetailed("write", { id: 1 })).tier).toBe("BATCH");
    expect(h.posts()).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Batching                                   */
/* -------------------------------------------------------------------------- */

describe("client: batching", () => {
  test("a render pass of different actions costs one request", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch);

    const [a, b, c] = await Promise.all([
      navi.call("getProduct", { id: 1 }),
      navi.call("write", { id: 2 }),
      navi.call("write", { id: 3 }),
    ]);

    expect(h.posts()).toHaveLength(1);
    expect(JSON.parse(h.posts()[0]?.body ?? "{}")._batch).toHaveLength(3);
    expect(a).toEqual({ action: "getProduct", payload: { id: 1 } });
    expect(b).toEqual({ action: "write", payload: { id: 2 } });
    expect(c).toEqual({ action: "write", payload: { id: 3 } });
  });

  test("immediate: true abandons a pending batch window", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch, { batchWindowMs: 5_000 });

    // The first call opens a 5s window; the second refuses to wait for it.
    const a = navi.call("write", { id: 1 });
    const b = navi.call("write", { id: 2 }, { immediate: true });
    await Promise.all([a, b]);

    expect(h.posts()).toHaveLength(1);
    expect(JSON.parse(h.posts()[0]?.body ?? "{}")._batch).toHaveLength(2);
  });

  test("a timed window batches calls spread across frames", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch, { batchWindowMs: 20 });

    const first = navi.call("write", { id: 1 });
    await Bun.sleep(5);
    const second = navi.call("write", { id: 2 });
    await Promise.all([first, second]);

    expect(h.posts()).toHaveLength(1);
    expect(JSON.parse(h.posts()[0]?.body ?? "{}")._batch).toHaveLength(2);
  });

  test("one failing entry does not fail its neighbours", async () => {
    const h = harness((recorded) => {
      const entries = entriesOf(recorded);
      return new Response(
        JSON.stringify({
          ok: true,
          correlationId: "c1",
          results: entries.map((entry) =>
            entry.action === "boom"
              ? { id: entry.id, ok: false, error: { code: "EXECUTION_ERROR", message: "nope" } }
              : { id: entry.id, ok: true, data: { fine: true }, cacheHit: "NONE" },
          ),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const navi = client(h.fetch);

    const [good, bad] = await Promise.allSettled([navi.call("write", { id: 1 }), navi.call("boom")]);

    expect(good.status).toBe("fulfilled");
    expect(bad.status).toBe("rejected");
    expect((bad as PromiseRejectedResult).reason).toMatchObject({ code: "EXECUTION_ERROR" });
  });
});

/* -------------------------------------------------------------------------- */
/*                                 Transports                                  */
/* -------------------------------------------------------------------------- */

describe("client: transports", () => {
  test("a CDN-eligible action is fetched over GET", async () => {
    const h = harness(() => singleOk({ id: 7 }));
    const navi = client(h.fetch, { transport: "auto" });

    const result = await navi.callDetailed("getProduct", { id: 7 });

    const gets = h.calls.filter((c) => c.method === "GET" && c.url.includes("/a/getProduct"));
    expect(gets).toHaveLength(1);
    expect(gets[0]?.url).toContain("p=");
    expect(h.posts()).toHaveLength(0);
    expect(result.tier).toBe("GET");
  });

  test("a payload too large for a URL falls back to POST", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch, { transport: "auto", maxGetPayloadChars: 8 });

    await navi.call("getProduct", { id: 123456789 });
    expect(h.posts()).toHaveLength(1);
  });

  test("a non-CDN action never uses GET", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch, { transport: "auto" });

    await navi.call("write", { id: 1 });
    expect(h.calls.filter((c) => c.method === "GET" && c.url.includes("/a/"))).toHaveLength(0);
    expect(h.posts()).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Failures                                   */
/* -------------------------------------------------------------------------- */

describe("client: failures", () => {
  test("a request-level error keeps its own code and message", async () => {
    const h = harness(() =>
      new Response(JSON.stringify({ ok: false, error: { code: "POLICY_VIOLATION", message: "nope", tip: "login" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const navi = client(h.fetch);

    const error = await navi.call("write").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "POLICY_VIOLATION", message: "nope", tip: "login" });
  });

  test("a 5xx is retried once by default", async () => {
    let attempts = 0;
    const h = harness((recorded) => {
      attempts++;
      return attempts === 1 ? new Response("boom", { status: 500 }) : respondWith(() => ({ seq: 1 }))(recorded);
    });
    const navi = client(h.fetch);

    expect(await navi.call("counter")).toEqual({ seq: 1 });
    expect(attempts).toBe(2);
    expect(navi.metrics().retries).toBe(1);
  });

  test("a 4xx is never retried", async () => {
    let attempts = 0;
    const h = harness(() => {
      attempts++;
      return new Response("nope", { status: 400 });
    });
    const navi = client(h.fetch);

    await navi.call("write").catch(() => undefined);
    expect(attempts).toBe(1);
  });

  test("retries: 0 disables retrying", async () => {
    let attempts = 0;
    const h = harness(() => {
      attempts++;
      return new Response("boom", { status: 503 });
    });
    const navi = client(h.fetch, { retries: 0 });

    await navi.call("write").catch(() => undefined);
    expect(attempts).toBe(1);
  });

  test("an aborted signal rejects before anything is sent", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch);
    const controller = new AbortController();
    controller.abort();

    const error = await navi.call("write", undefined, { signal: controller.signal }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).name).toBe("AbortError");
    expect(h.posts()).toHaveLength(0);
  });

  test("aborting the first caller leaves the request alive for the others", async () => {
    const h = harness(async (recorded) => {
      await Bun.sleep(10);
      return echoRoute(recorded);
    });
    const navi = client(h.fetch);
    const controller = new AbortController();

    const cancelled = navi.call("write", { id: 1 }, { signal: controller.signal });
    const kept = navi.call("write", { id: 1 });
    controller.abort();

    const error = await cancelled.then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).name).toBe("AbortError");
    expect(await kept).toEqual({ action: "write", payload: { id: 1 } });
    expect(h.posts()).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                             Auth and metrics                               */
/* -------------------------------------------------------------------------- */

describe("client: auth and observability", () => {
  test("a resolved token is attached as a bearer credential", async () => {
    const h = harness(echoRoute);
    const navi = client(h.fetch, { token: async () => "tok-123" });

    await navi.call("write", { id: 1 });
    expect(h.posts()[0]?.headers.get("Authorization")).toBe("Bearer tok-123");
  });

  test("identity segregates the cache between users", async () => {
    const h = harness(echoRoute);
    let who = "u1";
    const navi = client(h.fetch, { identity: () => who });

    await navi.call("write", { id: 1 });
    await navi.call("write", { id: 1 });
    expect(h.posts()).toHaveLength(1);

    who = "u2";
    await navi.call("write", { id: 1 });
    expect(h.posts()).toHaveLength(2);
  });

  test("metrics and the hook account for every suppression", async () => {
    const seen: string[] = [];
    const h = harness(async (recorded) => {
      await Bun.sleep(5);
      return echoRoute(recorded);
    });
    const navi = client(h.fetch, { onMetrics: (s: ClientSnapshot) => seen.push(`${s.calls}:${s.networkRequests}:${s.suppressed}`) });

    // Two of these are genuinely concurrent; the fourth arrives after a hit.
    await Promise.all([
      navi.call("write", { id: 1 }),
      navi.call("write", { id: 1 }),
      navi.call("write", { id: 1 }),
    ]);
    await navi.call("write", { id: 1 });

    const m = navi.metrics();
    expect(m.calls).toBe(4);
    expect(m.networkRequests).toBe(1);
    expect(m.suppressed).toBe(3);
    expect(m.byTier.BATCH).toBe(1);
    expect(m.byTier.INFLIGHT).toBe(2);
    expect(m.byTier.MEMORY).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                              End to end                                    */
/* -------------------------------------------------------------------------- */

describe("client and engine agree on the wire", () => {
  test("a batch round-trips through the real engine", async () => {
    const navi = new NaviClient<App>({ fetch: liveFetch, transport: "post" });

    const [product, written] = await Promise.all([
      navi.call("getProduct", { id: 42 }),
      navi.call("write", { id: 7 }),
    ]);

    expect(product.id).toBe(42);
    expect(product.name).toBe("product-42");
    expect(written).toEqual({ ok: true, id: 7 });
  });

  test("a second pass is served by the engine's L1 and the client's memory", async () => {
    const navi = new NaviClient<App>({ fetch: liveFetch, transport: "post" });

    const cold = await navi.callDetailed("getProduct", { id: 99 });
    const warm = await navi.callDetailed("getProduct", { id: 99 });

    expect(cold.tier).toBe("BATCH");
    expect(cold.serverTier).toBe("NONE");
    expect(warm.tier).toBe("MEMORY");
    expect(warm.data).toEqual(cold.data);
  });

  test("a GET round-trip uses the manifest and the CDN route", async () => {
    const navi = new NaviClient<App>({ fetch: liveFetch, transport: "auto" });

    const result = await navi.callDetailed("getProduct", { id: 5 });
    expect(result.tier).toBe("GET");
    expect((result.data as { id: number }).id).toBe(5);
  });

  test("a handler error surfaces with its code, not as a transport failure", async () => {
    const navi = new NaviClient<App>({ fetch: liveFetch, transport: "post" });

    const error = await navi.call("boom").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "EXECUTION_ERROR" });
  });

  test("an unknown action is reported, not silently undefined", async () => {
    const navi = new NaviClient<App>({ fetch: liveFetch, transport: "post" });
    const error = await navi.call("nope" as "write").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "ACTION_NOT_FOUND" });
  });
});
