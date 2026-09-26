/**
 * Development API server for Navi Serverless.
 *
 *   bun run dev
 *
 * Runs a local Navi RPC engine, exposing `/_navi/*` endpoints with terminal
 * logging for incoming actions, batching, and cache hits.
 *
 * This is an API server, not a demo site: there is no UI and nothing spawns a
 * browser. `GET /` returns a JSON description of the surface so you can confirm
 * the server is up from a terminal or a health check.
 */

import { NaviServerless } from "../src/index.ts";
import { createBunFetch } from "../src/adapters.ts";

let pageViews = 1042;
let totalInteractions = 358;

const app = new NaviServerless()
  .registerAction({
    name: "getStats",
    cache: { ttl: 5, swr: 10, scope: "public" },
    handler: () => ({
      views: pageViews,
      interactions: totalInteractions,
      serverTime: new Date().toISOString(),
    }),
  })
  .registerAction({
    name: "recordVisit",
    handler: () => {
      pageViews++;
      return { views: pageViews, interactions: totalInteractions };
    },
  })
  .registerAction({
    name: "increment",
    handler: (_ctx, input: { amount?: number } | undefined) => {
      const step = typeof input?.amount === "number" && Number.isFinite(input.amount) ? input.amount : 1;
      totalInteractions += step;
      pageViews += step;
      return { views: pageViews, interactions: totalInteractions };
    },
  })
  .registerAction({
    name: "reset",
    handler: () => {
      pageViews = 0;
      totalInteractions = 0;
      return { views: 0, interactions: 0 };
    },
  });

const bunFetch = createBunFetch(app);

interface TierReport {
  /** Distinct tiers seen, e.g. `L1-HEAP` or `L1-HEAP,MEMORY` for a batch. */
  readonly tiers: string;
  /** True when the response was served without invoking the handler. */
  readonly avoided: boolean;
}

/**
 * Pull the cache tier out of a response body.
 *
 * The tier is not a header. A single action reports it as `_meta.cacheHit`, a
 * batch reports one `cacheHit` per entry in `results`, and `_meta` is omitted
 * when the client opts out with `X-Navi-Meta: 0` — so every read here is
 * defensive and falls back to `NONE` rather than throwing.
 *
 * The body is read from a clone: the caller still has to return the original
 * response, and consuming it here would hand back an empty stream.
 */
async function readTier(response: Response): Promise<TierReport> {
  if (response.headers.get("content-type")?.includes("application/json") !== true) {
    return { tiers: "NONE", avoided: false };
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return { tiers: "NONE", avoided: false };
  }
  if (typeof body !== "object" || body === null) return { tiers: "NONE", avoided: false };

  const meta = (body as { readonly _meta?: { cacheHit?: unknown; avoidedInvocation?: unknown } })._meta;
  const results = (body as { readonly results?: readonly { cacheHit?: unknown }[] }).results;

  const tiers = new Set<string>();
  if (typeof meta?.cacheHit === "string") tiers.add(meta.cacheHit);
  if (Array.isArray(results)) {
    for (const item of results) {
      if (typeof item?.cacheHit === "string") tiers.add(item.cacheHit);
    }
  }

  const avoided =
    meta?.avoidedInvocation === true || (Array.isArray(results) && results.length > 1 && tiers.size > 0 && !tiers.has("NONE"));

  return { tiers: tiers.size === 0 ? "NONE" : [...tiers].join(","), avoided };
}

const port = Number(process.env["PORT"] ?? 3000);
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    // Root endpoint: return API info and registered actions
    if (url.pathname === "/") {
      return Response.json({
        name: "navi-serverless-dev",
        status: "healthy",
        endpoints: {
          action: "/_navi/action",
          manifest: "/_navi/manifest",
          health: "/_navi/health",
          publicRead: "/_navi/a/:actionName",
        },
        actions: app.actionNames,
      });
    }

    if (url.pathname.startsWith("/_navi")) {
      const start = performance.now();
      const res = await bunFetch(request);
      const elapsed = (performance.now() - start).toFixed(1);
      const { tiers, avoided } = await readTier(res);

      const label = url.pathname === "/_navi/action" ? "POST /_navi/action" : `${request.method} ${url.pathname}`;
      const code = res.status >= 400 ? `\x1b[31m${res.status}\x1b[0m` : `\x1b[32m${res.status}\x1b[0m`;
      const tier = tiers === "NONE" ? "\x1b[2mNONE\x1b[0m" : `\x1b[35m${tiers}\x1b[0m`;

      console.log(
        `\x1b[2m${new Date().toLocaleTimeString()}\x1b[0m ` +
          `${label.padEnd(22)} ${code} \x1b[2m${elapsed.padStart(6)}ms\x1b[0m ` +
          `tier:${tier}${avoided ? " \x1b[32m[AVOIDED]\x1b[0m" : ""}`,
      );

      return res;
    }

    return new Response(JSON.stringify({ ok: false, error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(
  `\n\x1b[36m⚡ Navi Serverless RPC dev server listening on:\x1b[0m \x1b[1mhttp://localhost:${server.port}\x1b[0m`,
);
console.log(`\x1b[2m   Registered actions: ${app.actionNames.join(", ")}\x1b[0m`);
console.log(`\x1b[2m   Try: curl -s localhost:${server.port}/_navi/a/getStats | jq\x1b[0m\n`);
