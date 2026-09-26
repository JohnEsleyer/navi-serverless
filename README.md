# navi-serverless

An opinionated, strictly TypeScript framework for V8 edge runtimes — Cloudflare
Workers, Vercel Edge, Deno, and Bun — built around one goal: **drive paid
function invocations toward zero.**

Every serverless bill is roughly `requests × duration × memory`. This library
attacks all three, and the first one specifically, by layering four caches and
three deduplication layers between your handler and the network.

```
client L1  →  client inflight  →  batch  →  network  →  CDN  →  L2  →  L1  →  singleflight  →  handler
   (free)        (free)          (free)               (free)  (free)  (free)         (free)       (billed)
```

Types flow one way, with no schema file and no codegen: a handler's return type
is inferred through the client, after secret projection.

## Install

```sh
npm install navi-serverless
```

Requires TypeScript 5.x with standard decorators and `erasableSyntaxOnly`:

```jsonc
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "experimentalDecorators": false, // standard decorators, not legacy
    "erasableSyntaxOnly": true
  }
}
```

## Quick start

```ts
import { NaviServerless } from "navi-serverless";
import { createCloudflareWorker } from "navi-serverless/adapters";

const app = new NaviServerless().registerAction({
  name: "getArticle",
  cache: { ttl: 60, swr: 600, scope: "public" },
  handler: async (ctx, input: { slug: string }) => db.articles.find(input.slug),
});

export default { fetch: createCloudflareWorker(app) };
```

On the client:

```ts
import { NaviClient } from "navi-serverless/client";

const client = new NaviClient<typeof app>({ endpoint: "/_navi/action" });
const article = await client.call("getArticle", { slug: "hello" });
```

The result is fully typed, including the secret-stripped shape. Use
`callDetailed` when you want to know *which* layer answered:

## The four caches

| Tier | Where | Survives | Cost |
| --- | --- | --- | --- |
| Client L1 | browser memory / IndexedDB | reload (IndexedDB) | free |
| CDN | platform edge | until `s-maxage` | free |
| L2 | `caches.default` (Workers) | isolate eviction | free |
| L1 | isolate memory | until TTL/SWE | free |

Only the handler is billed. The three deduplication layers that never reach it:

- **Client inflight dedupe** — 40 components asking for the same action in the
  same frame produce **one** request.
- **Batching** — calls made in the same tick are coalesced into a single POST
  (`batchWindowMs: 0` by default; `immediate: true` on a call flushes it).
- **Singleflight** — concurrent *server-side* requests for identical work share
  one execution. Independent of the cache, so it also protects uncached actions.

```ts
const client = new NaviClient<typeof app>({
  endpoint: "/_navi/action",
  batchWindowMs: 8,            // collect calls spread across animation frames
  token: () => session.token,  // also seeds the private cache identity
});

// Per-call cache policy: fresh for 30s, served-stale for another 5 minutes
// while a refresh runs behind it, and mirrored into IndexedDB.
const cart = await client.call("getCart", { cartId }, {
  cache: { ttlMs: 30_000, swrMs: 300_000, persist: true },
});

const { data, tier, serverTier } = await client.callDetailed("getCart", { cartId });
// tier: "MEMORY" | "IDB" | "INFLIGHT" | "BATCH" | "CDN" | "L1" | "L2" | "NETWORK"
```

## Secrets never reach the wire

`@Secret` marks a field the handler may read but the client never receives. It
is stripped during serialization, so it cannot leak through a response body, a
cache entry, or a CDN copy.

```ts
import { NaviServerless, Secret, SecretModel } from "navi-serverless";

@SecretModel
class Order {
  id: string;
  total: number;

  @Secret
  cardLast4: string;

  constructor(row: DbOrder) {
    this.id = row.id;
    this.total = row.total_cents / 100;
    this.cardLast4 = row.card_last4;
  }
}
```

Three details that will otherwise cost you an afternoon:

1. **`@SecretModel` is required.** Decorators run per-field, so the engine
   cannot know which class a field belongs to until a class decorator claims
   it. A `@Secret` field that no `@SecretModel`, `@SecretFields`, or
   `defineSecretSchema` claims throws `CONFIG_ERROR` at registration time —
   loudly, at boot, rather than silently leaking at runtime.
2. **Use fields, not constructor parameter properties.** Parameter properties
   (`constructor(readonly x: string)`) compile to constructor assignments, which
   `erasableSyntaxOnly` forbids. Declare the field, then assign it.
3. **Order does not matter.** The class decorator runs after all field
   decorators, so `@Secret` may appear above or below the constructor.

Prefer a plain class? Claim the same fields with a schema:

```ts
const OrderSchema = defineSecretSchema<DbOrder>()({ card_last4: "secret" });
```

## Authentication

`verifyToken` runs **before** the request body is parsed, so a forged token never
costs a `JSON.parse`, let alone a handler run. It receives the request and a
preflight context — which carries `env`, so platform secrets are available on
Cloudflare and Deno:

If you mint your own tokens with this library, `bearerVerifier` covers the
common case, including a per-isolate cache of verified digests so a hot client
is not re-verified on every call:

```ts
import { bearerVerifier } from "navi-serverless";

const app = new NaviServerless({ verifyToken: bearerVerifier(env.SIGNING_SECRET) });
```

To verify tokens yourself (JWT, an external IdP), read `env` off the preflight
context:

```ts
const app = new NaviServerless({
  verifyToken: async (request, { env }) => {
    const header = request.headers.get("Authorization") ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (raw === "" || typeof env.SIGNING_SECRET !== "string") {
      return { ok: true, role: "guest", userId: undefined, claims: {} };
    }
    const result = await verifyToken(raw, env.SIGNING_SECRET);
    if (!result.ok) return { ok: true, role: "guest", userId: undefined, claims: {} };
    return {
      ok: true,
      role: result.claims["role"] === "admin" ? "admin" : "user",
      userId: typeof result.claims["sub"] === "string" ? result.claims["sub"] : undefined,
      claims: result.claims,
    };
  },
});
```

`bearerVerifier` is a `TokenVerifier`, and a `TokenVerifier` may be async, so a
remote JWKS lookup fits here too.

Once a verifier is configured it is the **only** source of identity: the
`X-Navi-User-Id` and `X-Navi-Role` headers are ignored, because a private cache
keyed on a self-declared user id is a data leak waiting to happen.

Authorization is colocated with the action and evaluated after the cache key is
known but before any handler work:

```ts
.registerAction({
  name: "cancelOrder",
  access: { roles: ["admin", "support"] },
  handler: (ctx, input) => orders.cancel(input.id),
})
```

## Errors

A handler that throws produces a structured envelope with the right status, not
a rejected promise and not a platform error page:

```ts
throw new NaviError("NOT_FOUND", "That order was archived.");
// → 404 { "ok": false, "error": { "code": "NOT_FOUND", "message": "…" } }

throw new Error("connect ECONNREFUSED 10.0.0.7:5432 (db-primary)");
// → 500 { "ok": false, "error": { "code": "EXECUTION_ERROR",
//                                   "message": "The action failed. …" } }
```

An unexpected `Error` message is **not** forwarded to the client: those messages
routinely carry hostnames, connection strings, and query fragments. It goes to
`onError` instead, once per failure even when singleflight fans it out to
several waiters. Use `NaviError` when a message is genuinely safe to show.

## Conditional requests and the CDN

A `public` action is automatically reachable over `GET /_navi/a/:name`, and the
engine emits `ETag`, `Cache-Control: s-maxage`, and `stale-while-revalidate`.
Repeat reads are then answered by the platform's own cache — the invocation
never happens at all, which is the only tier that removes the charge rather than
just making it cheaper.

```
GET /_navi/a/getArticle?slug=hello
→ 200, ETag: "2fcadea…", CDN-Cache-Control: public, s-maxage=600
→ 304 Not Modified   (no body, no invocation)
```

`Vary` is emitted for private scopes so a shared proxy cannot mix users up.

## Invalidation

```ts
await app.invalidate("articles");   // drop every entry tagged "articles"
```

`ctx.waitUntil(app.invalidate(...))` is the idiomatic form: the response is
already on its way, and `waitUntil` keeps the isolate alive long enough to finish
the sweep.

## Adapters

| Export | Runtime |
| --- | --- |
| `createCloudflareWorker(app)` | Cloudflare Workers |
| `createVercelEdgeHandler(app)` | Vercel Edge Functions |
| `createNextRouteHandler(app)` | Next.js route handlers |
| `createDenoHandler(app)` | Deno Deploy |
| `createBunServeOptions` + `createBunFetch` | Bun |
| `createNodeHandler(app)` | Node (L2 tier is skipped) |

Adapters take a `Request` and return a `Response`; there is no Node-specific
code path in the library, and the Node adapter is a shim over the same engine.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /_navi/action` | one or more actions, batched |
| `GET\|HEAD /_navi/a/:name` | CDN-cacheable read for `public` actions |
| `GET /_navi/manifest` | action metadata, one fetch per deploy |
| `GET /_navi/health` | liveness |
| `OPTIONS /_navi/*` | CORS preflight |

## Examples

- [`examples/local-bun.ts`](examples/local-bun.ts) — runnable end to end:
  `bun run demo` prints real measured numbers over real HTTP.
- [`examples/cloudflare-worker.ts`](examples/cloudflare-worker.ts) — Workers +
  D1 + KV, with the token verifier reading a binding.
- [`examples/vercel-edge.ts`](examples/vercel-edge.ts) — Vercel Edge, private
  per-user caching.

## Development

```sh
bun run typecheck   # library, tests, and the Workers example (3 configs)
bun test            # 94 tests
bun run build       # dist/ with .d.ts
bun run check       # all of the above
bun run demo        # the local Bun example
```

The three typecheck configs exist because the examples target different
runtimes: `tsconfig.build.json` (edge-only, no ambient types),
`tsconfig.test.json` (Bun), and `tsconfig.cloudflare.json`
(`@cloudflare/workers-types`). Mixing Workers globals into the Bun program
produces conflicting `Request`/`fetch` declarations, so they are kept apart.

## License

MIT
