import { describe, expect, test } from "bun:test";
import { NaviServerless } from "../src/server.ts";
import {
  defineSecretSchema,
  Secret,
  SecretFields,
  SecretModel,
  secret,
  unwrapSecret,
  project,
} from "../src/security.ts";

/* -------------------------------------------------------------------------- */
/*                                   Models                                    */
/* -------------------------------------------------------------------------- */

@SecretModel
class Product {
  id: string;
  name: string;
  price: number;

  @Secret
  wholesaleCost: number;

  @Secret
  dbChecksum: string;

  constructor(id: string, name: string, price: number, cost: number, checksum: string) {
    this.id = id;
    this.name = name;
    this.price = price;
    this.wholesaleCost = cost;
    this.dbChecksum = checksum;
  }
}

@SecretModel
class Bundle extends Product {
  @Secret
  supplierContract: string = "nda-9911";
  items: string[] = ["sword", "shield"];
}

@SecretFields(["pin", "cvc"])
class Card {
  id = 7;
  last4 = "4242";
  pin = 1234;
  cvc = 999;
}

const ProductSchema = defineSecretSchema<Product>()({
  wholesaleCost: "secret",
  dbChecksum: "secret",
});

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                   */
/* -------------------------------------------------------------------------- */

const post = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("https://edge.test/_navi/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`https://edge.test/_navi${path}`, { headers });

const envelope = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

/* -------------------------------------------------------------------------- */
/*                                   Tests                                     */
/* -------------------------------------------------------------------------- */

describe("secret projection", () => {
  test("@Secret strips declared fields from a class instance", () => {
    const product = new Product("p1", "Sword", 299.99, 65, "sha256:x");
    const { clean, stripped } = project(product);

    expect(clean).toEqual({ id: "p1", name: "Sword", price: 299.99 });
    expect(stripped).toEqual(["wholesaleCost", "dbChecksum"]);
  });

  test("secret metadata is inherited by subclasses", () => {
    const bundle = new Bundle("b1", "Starter", 49, 12, "sha256:y");
    const { clean, stripped } = project(bundle);

    expect(clean).not.toHaveProperty("wholesaleCost");
    expect(clean).not.toHaveProperty("supplierContract");
    expect(clean).toEqual({ id: "b1", name: "Starter", price: 49, items: ["sword", "shield"] });
    expect(stripped).toContain("supplierContract");
  });

  test("SecretFields registers a class-level secret list", () => {
    const { clean } = project(new Card());
    expect(clean).toEqual({ id: 7, last4: "4242" });
  });

  test("a declared secret getter is never invoked", () => {
    let reads = 0;
    class Vault {
      id = 1;
      get apiKey(): string {
        reads++;
        return "sk-live-should-not-be-read";
      }
    }
    SecretFields(["apiKey"])(Vault);

    const { clean } = project(new Vault());
    expect(reads).toBe(0);
    expect(clean).toEqual({ id: 1 });
  });

  test("secret() boxes are stripped at any depth and can be unwrapped in-process", () => {
    const value = { ok: true, key: secret("sk-1"), nested: { deep: { token: secret("t") }, keep: 1 } };
    const { clean, stripped } = project(value);

    expect(clean).toEqual({ ok: true, nested: { deep: {}, keep: 1 } });
    expect(stripped).toEqual(["key", "nested.deep.token"]);
    expect(unwrapSecret(secret("kept"))).toBe("kept");
  });

  test("a schema strips nested secrets and reports dotted paths", () => {
    const schema = defineSecretSchema<{ id: number; inner: { keep: string; drop: string } }>()({
      inner: { drop: "secret" },
    });
    const { clean, stripped } = project({ id: 1, inner: { keep: "a", drop: "b" } }, { schema: schema.spec });

    expect(clean).toEqual({ id: 1, inner: { keep: "a" } });
    expect(stripped).toEqual(["inner.drop"]);
  });

  test("cycles, dates, maps, sets and typed arrays are handled", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const { clean } = project({
      when: new Date("2024-01-01T00:00:00.000Z"),
      set: new Set([1, 2]),
      map: new Map([["k", "v"]]),
      bytes: new Uint8Array([1, 2, 3]),
      cyclic,
    });

    expect((clean as any).when).toBeInstanceOf(Date);
    expect([...(clean as any).set]).toEqual([1, 2]);
    expect((clean as any).map.get("k")).toBe("v");
    expect((clean as any).bytes).toBeInstanceOf(Uint8Array);
    expect((clean as any).cyclic).toEqual({ name: "root" });
  });

  test("a throwing getter degrades to an omitted field instead of a 500", () => {
    class Fragile {
      id = 1;
      get broken(): string {
        throw new Error("nope");
      }
    }
    expect(project(new Fragile()).clean).toEqual({ id: 1 });
  });
});

describe("engine: dispatch and caching", () => {
  test("a cold call executes the handler and reports no cache hit", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "getProduct",
      cache: { ttl: 30, scope: "public" },
      schema: ProductSchema,
      handler: (_ctx, input: { productId: string }) => {
        runs++;
        return new Product(input.productId, "Sword", 299.99, 65, "sha256:x");
      },
    });

    const response = await app.handleRequest(post({ action: "getProduct", payload: { productId: "p1" } }));
    const body = await envelope(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ id: "p1", name: "Sword", price: 299.99 });
    expect(body._meta.cacheHit).toBe("NONE");
    expect(body._meta.strippedKeys).toEqual(["wholesaleCost", "dbChecksum"]);
    expect(runs).toBe(1);
  });

  test("the second identical call is served from L1 without executing", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "getProduct",
      cache: { ttl: 30, scope: "public" },
      handler: (ctx, input: { productId: string }) => {
        runs++;
        return { id: input.productId, at: ctx.id };
      },
    });

    const first = await envelope(await app.handleRequest(post({ action: "getProduct", payload: { productId: "p1" } })));
    const second = await envelope(await app.handleRequest(post({ action: "getProduct", payload: { productId: "p1" } })));

    expect(runs).toBe(1);
    expect(second._meta.cacheHit).toBe("L1-HEAP");
    // A cache hit is still a distinct request: the correlation id must differ.
    expect(second.correlationId).not.toBe(first.correlationId);
    expect(second.data).toEqual(first.data);
  });

  test("key order in the payload does not affect the cache key", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "search",
      cache: { ttl: 30, scope: "public" },
      handler: (_ctx, input: Record<string, unknown>) => {
        runs++;
        return { ok: true, input };
      },
    });

    await app.handleRequest(post({ action: "search", payload: { a: 1, b: 2 } }));
    await app.handleRequest(post({ action: "search", payload: { b: 2, a: 1 } }));
    expect(runs).toBe(1);
  });

  test("private scope segregates callers", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "me",
      cache: { ttl: 30, scope: "private" },
      handler: (ctx) => {
        runs++;
        return { userId: ctx.userId };
      },
    });

    await app.handleRequest(post({ action: "me" }, { "X-Navi-User-Id": "u1" }));
    await app.handleRequest(post({ action: "me" }, { "X-Navi-User-Id": "u2" }));
    await app.handleRequest(post({ action: "me" }, { "X-Navi-User-Id": "u1" }));

    expect(runs).toBe(2);
  });

  test("an omitted payload reaches the handler as undefined, not {}", async () => {
    const seen: unknown[] = [];
    const app = new NaviServerless().registerAction({
      name: "probe",
      handler: (_ctx, input: unknown) => {
        seen.push(input);
        return { ok: true };
      },
    });

    await app.handleRequest(post({ action: "probe" }));
    await app.handleRequest(post({ action: "probe", payload: {} }));
    expect(seen).toEqual([undefined, {}]);
  });

  test("two concurrent identical uncached calls still collapse to one run", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "uncached",
      handler: async () => {
        runs++;
        await Bun.sleep(5);
        return { seq: runs };
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => app.handleRequest(post({ action: "uncached" }))),
    );
    const bodies = await Promise.all(responses.map(envelope));

    expect(runs).toBe(1);
    expect(bodies.every((b) => b.data.seq === 1)).toBe(true);
    // Nothing is retained, so the next call pays full price again.
    await app.handleRequest(post({ action: "uncached" }));
    expect(runs).toBe(2);
  });

  test("a stale entry is served immediately and refreshed in the background", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "ticker",
      cache: { ttl: 0.05, swr: 30, scope: "public" },
      handler: () => ({ seq: ++runs }),
    });

    const first = await envelope(await app.handleRequest(post({ action: "ticker" })));
    expect(first.data.seq).toBe(1);

    await Bun.sleep(70);

    // The stale value comes back now; the refresh is handed to `waitUntil`.
    const background: Array<Promise<unknown>> = [];
    const stale = await envelope(
      await app.handleRequest(post({ action: "ticker" }), {}, { waitUntil: (p) => background.push(p) }),
    );
    expect(stale.data.seq).toBe(1);
    expect(stale._meta.cacheHit).toBe("L1-HEAP");
    expect(background).toHaveLength(1);

    await Promise.all(background);
    expect(runs).toBe(2);

    const after = await envelope(await app.handleRequest(post({ action: "ticker" })));
    expect(after.data.seq).toBe(2);
  });
});

describe("engine: singleflight", () => {
  test("50 concurrent misses for one key execute the handler once", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "hot",
      handler: async () => {
        runs++;
        await Bun.sleep(5);
        return { ok: true };
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => app.handleRequest(post({ action: "hot" }))),
    );

    expect(runs).toBe(1);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(app.metrics().singleflightCoalesced).toBe(49);
  });

  test("a failed execution fails every waiter once, without leaking the message", async () => {
    let runs = 0;
    const reported: unknown[] = [];
    const app = new NaviServerless({ onError: (error) => reported.push(error) }).registerAction({
      name: "boom",
      handler: async () => {
        runs++;
        await Bun.sleep(5);
        // The kind of message that must not reach a client: it names a host.
        throw new Error("connect ECONNREFUSED 10.0.0.7:5432 (db-primary)");
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.handleRequest(post({ action: "boom" }))),
    );

    // One execution, and every waiter gets the same structured failure.
    expect(runs).toBe(1);
    expect(responses.every((r) => r.status === 500)).toBe(true);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<Record<string, any>>));
    expect(bodies.every((b) => b.ok === false && b.error.code === "EXECUTION_ERROR")).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain("10.0.0.7");
    expect(JSON.stringify(bodies)).not.toContain("db-primary");
    // ...but the real error is still available to the operator.
    expect(reported).toHaveLength(1);
    expect(String((reported[0] as Error).message)).toContain("db-primary");
  });

  test("a NaviError keeps its code, status, and message", async () => {
    const { NaviError } = await import("../src/errors.ts");
    const app = new NaviServerless().registerAction({
      name: "gone",
      handler: () => {
        throw new NaviError("NOT_FOUND", "That order was archived.", { tip: "Try order history." });
      },
    });

    const response = await app.handleRequest(post({ action: "gone" }));
    const body = (await response.json()) as Record<string, any>;
    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({ code: "NOT_FOUND", message: "That order was archived.", tip: "Try order history." });
  });

  test("a thrown string is treated as an author-supplied message", async () => {
    const app = new NaviServerless().registerAction({
      name: "odd",
      handler: () => {
        throw "plain refusal";
      },
    });

    const response = await app.handleRequest(post({ action: "odd" }));
    const body = (await response.json()) as Record<string, any>;
    expect(response.status).toBe(500);
    expect(body.error.message).toBe("plain refusal");
  });
});

describe("engine: conditional requests", () => {
  test("a matching If-None-Match answers 304 with no handler run", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "doc",
      cache: { ttl: 30, scope: "public" },
      handler: () => {
        runs++;
        return { body: "stable" };
      },
    });

    const first = await app.handleRequest(post({ action: "doc" }));
    const etag = first.headers.get("ETag") as string;
    expect(etag).toBeTruthy();

    const revalidated = await app.handleRequest(post({ action: "doc" }, { "If-None-Match": etag }));
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("ETag")).toBe(etag);
    expect(runs).toBe(1);
    expect(app.metrics().conditionalNotModified).toBe(1);
  });

  test("a stale If-None-Match falls through to a real response", async () => {
    const app = new NaviServerless().registerAction({
      name: "doc",
      cache: { ttl: 30, scope: "public" },
      handler: () => ({ body: "stable" }),
    });

    await app.handleRequest(post({ action: "doc" }));
    const response = await app.handleRequest(post({ action: "doc" }, { "If-None-Match": '"not-the-etag"' }));
    expect(response.status).toBe(200);
  });

  test("weak tags and lists are matched", async () => {
    const app = new NaviServerless().registerAction({
      name: "doc",
      cache: { ttl: 30, scope: "public" },
      handler: () => ({ body: "stable" }),
    });
    const first = await app.handleRequest(post({ action: "doc" }));
    const etag = first.headers.get("ETag") as string;

    expect((await app.handleRequest(post({ action: "doc" }, { "If-None-Match": `W/${etag}` }))).status).toBe(304);
    expect((await app.handleRequest(post({ action: "doc" }, { "If-None-Match": `"other", ${etag}` }))).status).toBe(304);
    expect((await app.handleRequest(post({ action: "doc" }, { "If-None-Match": "*" }))).status).toBe(304);
  });
});

describe("engine: batching", () => {
  test("a batch costs one invocation and collapses duplicate entries", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "getProduct",
      cache: { ttl: 30, scope: "public" },
      handler: (_ctx, input: { productId: string }) => {
        runs++;
        return { id: input.productId };
      },
    });

    const response = await app.handleRequest(
      post({
        _batch: [
          { id: "a", action: "getProduct", payload: { productId: "p1" } },
          { id: "b", action: "getProduct", payload: { productId: "p1" } },
          { id: "c", action: "getProduct", payload: { productId: "p2" } },
        ],
      }),
    );
    const body = await envelope(response);

    expect(runs).toBe(2);
    expect(body.results.map((r: any) => [r.id, r.ok, r.data])).toEqual([
      ["a", true, { id: "p1" }],
      ["b", true, { id: "p1" }],
      ["c", true, { id: "p2" }],
    ]);
    expect(body.results[1].cacheHit).toBe("SINGLEFLIGHT");
    expect(app.metrics().batchSubrequestsCollapsed).toBe(1);
  });

  test("one failing entry does not fail the batch", async () => {
    const app = new NaviServerless()
      .registerAction({ name: "ok", handler: () => ({ fine: true }) })
      .registerAction({
        name: "bad",
        handler: () => {
          throw new Error("nope");
        },
      });

    const response = await app.handleRequest(
      post({
        _batch: [
          { id: "1", action: "ok" },
          { id: "2", action: "bad" },
          { id: "3", action: "missing" },
        ],
      }),
    );
    const body = await envelope(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(false);
    expect(body.results[1].error.code).toBe("EXECUTION_ERROR");
    expect(body.results[2].error.code).toBe("ACTION_NOT_FOUND");
  });

  test("an oversized batch is rejected before any handler runs", async () => {
    let runs = 0;
    const app = new NaviServerless({ maxBatchSize: 3 }).registerAction({
      name: "x",
      handler: () => {
        runs++;
        return {};
      },
    });

    const response = await app.handleRequest(
      post({ _batch: Array.from({ length: 4 }, (_, i) => ({ id: String(i), action: "x" })) }),
    );
    expect(response.status).toBe(413);
    expect((await envelope(response)).error.code).toBe("BATCH_TOO_LARGE");
    expect(runs).toBe(0);
  });
});

describe("engine: authorization", () => {
  test("a declarative rule rejects before any handler work", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "adminOnly",
      access: { roles: ["admin"], allowGuest: false },
      handler: () => {
        runs++;
        return { ok: true };
      },
    });

    const denied = await app.handleRequest(post({ action: "adminOnly" }, { "X-Navi-Role": "guest" }));
    expect(denied.status).toBe(403);
    expect((await envelope(denied)).error.code).toBe("POLICY_VIOLATION");

    const allowed = await app.handleRequest(post({ action: "adminOnly" }, { "X-Navi-Role": "admin" }));
    expect(allowed.status).toBe(200);
    expect(runs).toBe(1);
  });

  test("a private cache cannot be poisoned through a self-declared user header", async () => {
    const app = new NaviServerless({
      verifyToken: async (request) => {
        const auth = request.headers.get("Authorization") ?? "";
        return auth.startsWith("Bearer ")
          ? { ok: true as const, role: "user" as const, userId: "verified", claims: {} }
          : { ok: true as const, role: "guest" as const, userId: undefined, claims: {} };
      },
    }).registerAction({
      name: "me",
      cache: { ttl: 30, scope: "private" },
      handler: (ctx) => ({ userId: ctx.userId }),
    });

    const spoofed = await envelope(
      await app.handleRequest(post({ action: "me" }, { "X-Navi-User-Id": "victim" })),
    );
    expect(spoofed.data.userId).toBeUndefined();

    const real = await envelope(
      await app.handleRequest(post({ action: "me" }, { Authorization: "Bearer real-token" })),
    );
    expect(real.data.userId).toBe("verified");
  });

  test("rate limiting sheds load with a Retry-After and runs no handler", async () => {
    let runs = 0;
    const app = new NaviServerless({
      rateLimit: { limit: 2, windowSeconds: 60, keyBy: (ctx) => ctx.clientIp },
    }).registerAction({
      name: "x",
      handler: () => {
        runs++;
        return {};
      },
    });

    const make = (): Promise<Response> =>
      app.handleRequest(post({ action: "x" }, { "cf-connecting-ip": "9.9.9.9" }));

    expect((await make()).status).toBe(200);
    expect((await make()).status).toBe(200);
    const limited = await make();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(runs).toBe(2);
  });
});

describe("engine: transports and routes", () => {
  test("a public action is readable over GET and emits CDN cache headers", async () => {
    const app = new NaviServerless().registerAction({
      name: "getProduct",
      cache: { ttl: 60, swr: 30, scope: "public" },
      handler: (_ctx, input: { productId: string }) => ({ id: input.productId }),
    });

    const response = await app.handleRequest(get("/a/getProduct?productId=p1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: "p1" } });

    // `max-age=0` keeps browsers revalidating; `s-maxage` is what the CDN uses.
    const cacheControl = response.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toContain("s-maxage=90");
    expect(cacheControl).toContain("stale-while-revalidate=30");
    expect(cacheControl).toContain("max-age=0");
    expect(response.headers.get("CDN-Cache-Control")).toContain("s-maxage=90");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toContain("s-maxage=90");
  });

  test("GET accepts a packed JSON payload and array params", async () => {
    const app = new NaviServerless().registerAction({
      name: "lookup",
      cache: { ttl: 30, scope: "public" },
      handler: (_ctx, input: { ids?: string[]; q?: string }) => input,
    });

    const packed = await app.handleRequest(get(`/a/lookup?p=${encodeURIComponent('{"ids":["a","b"]}')}`));
    expect((await envelope(packed)).data).toEqual({ ids: ["a", "b"] });

    const listed = await app.handleRequest(get("/a/lookup?ids[]=a&ids[]=b&q=hello"));
    expect((await envelope(listed)).data).toEqual({ ids: ["a", "b"], q: "hello" });
  });

  test("a private action is not exposed over GET", async () => {
    const app = new NaviServerless().registerAction({
      name: "secretive",
      cache: { ttl: 30, scope: "private" },
      handler: () => ({ nope: true }),
    });

    const response = await app.handleRequest(get("/a/secretive"));
    expect(response.status).toBe(404);
    expect((await envelope(response)).error.code).toBe("ACTION_NOT_FOUND");
  });

  test("readonlyTransport exposes a private action over GET for the owner", async () => {
    const app = new NaviServerless().registerAction({
      name: "mine",
      cache: { ttl: 30, scope: "private" },
      readonlyTransport: true,
      handler: (ctx) => ({ userId: ctx.userId }),
    });

    const response = await app.handleRequest(get("/a/mine", { "X-Navi-User-Id": "u1" }));
    expect(response.status).toBe(200);
    expect((await envelope(response)).data).toEqual({ userId: "u1" });
  });

  test("HEAD returns headers without a body", async () => {
    const app = new NaviServerless().registerAction({
      name: "doc",
      cache: { ttl: 30, scope: "public" },
      handler: () => ({ body: "x".repeat(500) }),
    });

    const response = await app.handleRequest(new Request("https://edge.test/_navi/a/doc", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(Number(response.headers.get("Content-Length"))).toBeGreaterThan(0);
  });

  test("the preflight is cacheable for a year", async () => {
    const app = new NaviServerless();
    const response = await app.handleRequest(new Request("https://edge.test/_navi/action", { method: "OPTIONS" }));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Max-Age")).toBe("31536000");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("If-None-Match");
  });

  test("the manifest describes every action and is CDN cacheable", async () => {
    const app = new NaviServerless()
      .registerAction({ name: "readable", cache: { ttl: 60, scope: "public" }, handler: () => ({}) })
      .registerAction({ name: "write", handler: () => ({}) });

    const response = await app.handleRequest(get("/manifest"));
    const body = await envelope(response);

    expect(body.actions.readable).toMatchObject({ scope: "public", get: true, cdn: true });
    expect(body.actions.write).toMatchObject({ cached: false, get: false, cdn: false });
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=86400");
  });

  test("unknown routes and methods are rejected cheaply", async () => {
    const app = new NaviServerless().registerAction({ name: "x", handler: () => ({}) });

    expect((await app.handleRequest(new Request("https://edge.test/nope"))).status).toBe(404);
    expect((await app.handleRequest(get("/action"))).status).toBe(405);
    expect((await app.handleRequest(post("not json at all"))).status).toBe(400);
    expect((await app.handleRequest(post({ payload: {} }))).status).toBe(400);
    expect((await app.handleRequest(post({ action: "x", v: 99 }))).status).toBe(200);
  });

  test("X-Navi-Meta: 0 drops metadata from the body but keeps the payload", async () => {
    const app = new NaviServerless().registerAction({
      name: "slim",
      cache: { ttl: 30, scope: "public" },
      schema: ProductSchema,
      handler: () => new Product("p1", "Sword", 1, 2, "h"),
    });

    const response = await app.handleRequest(post({ action: "slim" }, { "X-Navi-Meta": "0" }));
    const body = await envelope(response);

    expect(response.headers.get("X-Navi-Meta")).toBe("0");
    expect(body._meta.strippedKeys).toEqual([]);
    expect(body.data).toEqual({ id: "p1", name: "Sword", price: 1 });
  });
});

describe("engine: invalidation and metrics", () => {
  test("tag invalidation drops matching entries", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "doc",
      cache: { ttl: 60, scope: "public", tags: ["doc:1"] },
      handler: () => ({ seq: ++runs }),
    });

    await app.handleRequest(post({ action: "doc" }));
    await app.handleRequest(post({ action: "doc" }));
    expect(runs).toBe(1);

    await app.invalidate("doc:1");
    await app.handleRequest(post({ action: "doc" }));
    expect(runs).toBe(2);
  });

  test("metrics account for avoided invocations", async () => {
    const app = new NaviServerless().registerAction({
      name: "hot",
      cache: { ttl: 30, scope: "public" },
      handler: async () => {
        await Bun.sleep(2);
        return { ok: true };
      },
    });

    await Promise.all(Array.from({ length: 5 }, () => app.handleRequest(post({ action: "hot" }))));
    const metrics = app.metrics();

    expect(metrics.handlerRuns).toBe(1);
    expect(metrics.singleflightCoalesced).toBe(4);
    expect(metrics.avoidedInvocations).toBe(4);

    app.resetMetrics();
    expect(app.metrics().requests).toBe(0);
    expect(app.metrics().handlerRuns).toBe(0);
  });

  test("sweep drops expired entries", async () => {
    const app = new NaviServerless().registerAction({
      name: "brief",
      cache: { ttl: 0.02, scope: "public" },
      handler: () => ({ ok: true }),
    });

    await app.handleRequest(post({ action: "brief" }));
    expect(app.sweep().l1Dropped).toBe(0);
    await Bun.sleep(40);
    expect(app.sweep().l1Dropped).toBe(1);
  });
});

describe("cache identity partitioning", () => {
  test("a custom keyGenerator cannot leak a private entry across users", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "cart",
      cache: {
        ttl: 60,
        scope: "private",
        // The obvious shape: key by resource id and let the scope handle the
        // rest. The scope *must* still partition by caller, or user B reads
        // user A's cart straight out of the cache.
        keyGenerator: (_ctx, payload) => `cart:${(payload as { cartId: string }).cartId}`,
      },
      handler: (ctx) => {
        runs++;
        return { owner: ctx.userId, runs };
      },
    });

    const a1 = await envelope(
      await app.handleRequest(post({ action: "cart", payload: { cartId: "c1" } }, { "X-Navi-User-Id": "alice" })),
    );
    const b1 = await envelope(
      await app.handleRequest(post({ action: "cart", payload: { cartId: "c1" } }, { "X-Navi-User-Id": "bob" })),
    );

    expect(a1.data.owner).toBe("alice");
    expect(b1.data.owner).toBe("bob");
    expect(runs).toBe(2);

    // Both now read from their own entry, and the handler does not run again.
    const a2 = await envelope(
      await app.handleRequest(post({ action: "cart", payload: { cartId: "c1" } }, { "X-Navi-User-Id": "alice" })),
    );
    const b2 = await envelope(
      await app.handleRequest(post({ action: "cart", payload: { cartId: "c1" } }, { "X-Navi-User-Id": "bob" })),
    );
    expect(a2.data).toEqual(a1.data);
    expect(b2.data).toEqual(b1.data);
    expect(runs).toBe(2);
  });

  test("a public keyGenerator still shares one entry across callers", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "shared",
      cache: { ttl: 60, scope: "public", keyGenerator: (_ctx, payload) => `s:${JSON.stringify(payload)}` },
      handler: () => ({ runs: ++runs }),
    });

    const a = await envelope(await app.handleRequest(post({ action: "shared", payload: { k: 1 } }, { "X-Navi-User-Id": "alice" })));
    const b = await envelope(await app.handleRequest(post({ action: "shared", payload: { k: 1 } }, { "X-Navi-User-Id": "bob" })));

    expect(runs).toBe(1);
    expect(b.data).toEqual(a.data);
  });

  test("a keyGenerator returning null opts out of caching", async () => {
    let runs = 0;
    const app = new NaviServerless().registerAction({
      name: "sometimes",
      cache: { ttl: 60, scope: "public", keyGenerator: (_ctx, payload) => (payload as { cache: boolean }).cache ? "k" : null },
      handler: () => ({ runs: ++runs }),
    });

    await app.handleRequest(post({ action: "sometimes", payload: { cache: true } }));
    await app.handleRequest(post({ action: "sometimes", payload: { cache: true } }));
    expect(runs).toBe(1);

    await app.handleRequest(post({ action: "sometimes", payload: { cache: false } }));
    await app.handleRequest(post({ action: "sometimes", payload: { cache: false } }));
    expect(runs).toBe(3);
  });
});
