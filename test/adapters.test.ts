import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  createBunFetch,
  createBunServeOptions,
  createCloudflareWorker,
  createDenoHandler,
  createNextRouteHandler,
  createNodeHandler,
  createVercelEdgeHandler,
  type NodeRequestLike,
  type NodeResponseLike,
} from "../src/adapters.ts";
import { NaviServerless } from "../src/server.ts";

const makeApp = (): NaviServerless<any> =>
  new NaviServerless()
    .registerAction({ name: "add", handler: (_c, input: { a: number; b: number }) => ({ sum: input.a + input.b }) })
    .registerAction({
      name: "boom",
      handler: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.7:5432 (db-primary)");
      },
    })
    .registerAction({
      name: "doc",
      cache: { ttl: 30, scope: "public" },
      handler: () => ({ title: "hello" }),
    });

const body = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

/* -------------------------------------------------------------------------- */
/*                              Request-only adapters                          */
/* -------------------------------------------------------------------------- */

describe("adapters: Request in, Response out", () => {
  const app = makeApp();
  const post = (payload: unknown): Request =>
    new Request("https://edge.test/_navi/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const cases: readonly [string, (request: Request, env?: any, ctx?: any) => Promise<Response> | Response][] = [
    ["cloudflare", (r, e = {}, c = { waitUntil: () => undefined }) => createCloudflareWorker(app).fetch(r, e, c)],
    ["vercel edge", (r) => createVercelEdgeHandler(app)(r)],
    ["next route", (r) => createNextRouteHandler(app)(r)],
    ["deno", (r, e = {}) => createDenoHandler(app)(r, e)],
  ];

  for (const [name, handle] of cases) {
    test(`${name} executes a single action`, async () => {
      const response = await handle(post({ action: "add", payload: { a: 2, b: 3 } }));
      const envelope = await body(response);
      expect(response.status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ sum: 5 });
    });

    test(`${name} executes a batch`, async () => {
      const response = await handle(
        post({
          _batch: [
            { id: "r1", action: "add", payload: { a: 1, b: 1 } },
            { id: "r2", action: "add", payload: { a: 10, b: 5 } },
          ],
        }),
      );
      const envelope = await body(response);
      expect(envelope.results).toHaveLength(2);
      expect(envelope.results[1].data).toEqual({ sum: 15 });
    });

    test(`${name} maps a handler failure to an envelope instead of rejecting`, async () => {
      const response = await handle(post({ action: "boom" }));
      const envelope = await body(response);
      expect(response.status).toBe(500);
      expect(envelope.error.code).toBe("EXECUTION_ERROR");
      // The connection string in the original message must not survive.
      expect(JSON.stringify(envelope)).not.toContain("10.0.0.7");
    });

    test(`${name} answers CORS preflight`, async () => {
      const response = await handle(
        new Request("https://edge.test/_navi/action", {
          method: "OPTIONS",
          headers: { Origin: "https://app.test", "Access-Control-Request-Method": "POST" },
        }),
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).not.toBeNull();
    });
  }

  test("env bindings reach the handler", async () => {
    const withEnv = new NaviServerless().registerAction({
      name: "peek",
      handler: (ctx) => ({ greeting: String((ctx.env as Record<string, unknown>)["GREETING"]) }),
    });
    const response = await createCloudflareWorker(withEnv).fetch(
      post({ action: "peek" }),
      { GREETING: "hello" },
      { waitUntil: () => undefined },
    );
    expect((await body(response)).data).toEqual({ greeting: "hello" });
  });

  test("waitUntil work is forwarded to the platform context", async () => {
    let waited = 0;
    const waiting = new NaviServerless().registerAction({
      name: "poke",
      handler: (ctx) => {
        ctx.waitUntil(Promise.resolve());
        return { ok: true };
      },
    });
    await createCloudflareWorker(waiting).fetch(
      post({ action: "poke" }),
      {},
      {
        waitUntil: (promise: Promise<unknown>) => {
          waited++;
          void promise;
        },
      },
    );
    expect(waited).toBe(1);
  });

  test("Bun helpers produce a fetch handler and serve options", async () => {
    const bunApp = makeApp();
    const fetchHandler = createBunFetch(bunApp);
    const response = await fetchHandler(post({ action: "add", payload: { a: 1, b: 1 } }));
    expect((await body(response)).data).toEqual({ sum: 2 });

    const options = createBunServeOptions({ port: 0 });
    expect(options.development).toBe(false);
    expect(options.port).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 Node adapter                                */
/* -------------------------------------------------------------------------- */

describe("adapters: Node", () => {
  let server: Server | undefined;
  let origin = "";

  afterAll(() => {
    server?.close();
  });

  const listen = async (handler: (req: NodeRequestLike, res: NodeResponseLike) => Promise<void>): Promise<string> => {
    const created = createServer((req, res) => {
      void handler(req as unknown as NodeRequestLike, res as unknown as NodeResponseLike);
    });
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    server = created;
    const address = created.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    return origin;
  };

  test("a POST body survives the Node stream round trip", async () => {
    const base = await listen(createNodeHandler(makeApp()));
    const response = await fetch(`${base}/_navi/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", payload: { a: 20, b: 22 } }),
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toEqual({ sum: 42 });
  });

  test("a Node batch arrives as a batch", async () => {
    const base = await listen(createNodeHandler(makeApp()));
    const response = await fetch(`${base}/_navi/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _batch: [
          { id: "a", action: "add", payload: { a: 1, b: 2 } },
          { id: "b", action: "add", payload: { a: 3, b: 4 } },
        ],
      }),
    });
    expect((await body(response)).results).toHaveLength(2);
  });

  test("a throwing handler answers 500 rather than killing the process", async () => {
    const base = await listen(createNodeHandler(makeApp()));
    const response = await fetch(`${base}/_navi/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "boom" }),
    });
    const envelope = await body(response);
    expect(response.status).toBe(500);
    expect(envelope.error.code).toBe("EXECUTION_ERROR");
    expect(JSON.stringify(envelope)).not.toContain("10.0.0.7");

    // The server is still alive and serving.
    const health = await fetch(`${base}/_navi/health`);
    expect(health.status).toBe(200);
  });

  test("query strings and the CDN route survive URL reconstruction", async () => {
    const base = await listen(createNodeHandler(makeApp()));
    const first = await fetch(`${base}/_navi/a/doc`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag).not.toBeNull();
    expect(first.headers.get("CDN-Cache-Control")).toContain("s-maxage");

    const conditional = await fetch(`${base}/_navi/a/doc`, { headers: { "If-None-Match": etag as string } });
    expect(conditional.status).toBe(304);
  });

  test("a request with no Host header fails cleanly instead of throwing", async () => {
    // The adapter logs this one on purpose; keep it out of the test log.
    const logged = console.error;
    console.error = () => undefined;
    try {
      await assertNoHostHeader();
    } finally {
      console.error = logged;
    }
  });

  const assertNoHostHeader = async (): Promise<void> => {
    const handler = createNodeHandler(makeApp());
    const chunks: string[] = [];
    const res: NodeResponseLike = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (value?: string) => {
        chunks.push(value ?? "");
      },
    };
    await handler(
      { method: "GET", url: "/_navi/health", headers: {} },
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(chunks.join("")).error.code).toBe("INTERNAL");
  };
});
