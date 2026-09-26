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

> **Status: unreleased.** This package is not on npm yet — the name is
> unclaimed and `0.1.0` is a pre-release. Install from GitHub for now; see
> [Install](#install). Publishing steps are in [Release](#release).

## Install

Not on npm yet, so `npm install navi-serverless` does not resolve. Install from
GitHub in the meantime:

```sh
# Bun
bun add github:JohnEsleyer/navi-serverless

# pnpm
pnpm add github:JohnEsleyer/navi-serverless

# npm
npm install github:JohnEsleyer/navi-serverless
```

A GitHub install compiles the package from source via `prepare`, so you get a
built `dist/` without any extra steps. To work on it directly:

```sh
git clone https://github.com/JohnEsleyer/navi-serverless.git
cd navi-serverless
bun install
bun run build
```

Once it is published, this is the whole install:

```sh
npm install navi-serverless
```

The package is ESM-only and ships type declarations. Requires TypeScript 5.x
with standard decorators and `erasableSyntaxOnly`:

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
  cardLast4: Secret<string>;

  constructor(row: DbOrder) {
    this.id = row.id;
    this.total = row.total_cents / 100;
    this.cardLast4 = row.card_last4;
  }
}
```

The client type drops `cardLast4` entirely, so `out.cardLast4` is a compile
error rather than a silent `undefined`:

```ts
const out = await client.call("getOrder", { id });
out.total;      // number
out.cardLast4;   // ✗ Property 'cardLast4' does not exist
```

Four details that will otherwise cost you an afternoon:

1. **Wrap the type in `Secret<>`, not just the value.** `@Secret` alone strips
   the field on the wire but leaves it in the type, because a decorator runs at
   runtime and cannot rewrite the property it decorates — the type checker never
   learns the field was secret. `Secret<string>` is a branded `string`: it still
   accepts a plain string, so the annotation is the only cost. Either the brand
   or a `schema:` (below) is enough on its own.
2. **`@SecretModel` is required.** Decorators run per-field, so the engine
   cannot know which class a field belongs to until a class decorator claims
   it. A `@Secret` field that no `@SecretModel`, `@SecretFields`, or
   `defineSecretSchema` claims throws `CONFIG_ERROR` at registration time —
   loudly, at boot, rather than silently leaking at runtime.
3. **Use fields, not constructor parameter properties.** Parameter properties
   (`constructor(readonly x: string)`) compile to constructor assignments, which
   `erasableSyntaxOnly` forbids. Declare the field, then assign it.
4. **Order does not matter.** The class decorator runs after all field
   decorators, so `@Secret` may appear above or below the constructor.

Prefer a plain class, or a type you do not control? Claim the same fields with a
schema, which drives the type instead of the brand:

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

## Development

```sh
bun install
bun run dev
```

That starts a headless API server — no UI, nothing spawns a browser — and
registers four actions (`getStats`, `recordVisit`, `increment`, `reset`) so the
caching and batching layers have something to act on. `PORT` overrides 3000.

`GET /` returns JSON describing the surface; the RPC routes are the four the
engine already exposes:

```sh
curl -s localhost:3000/_navi/health | jq
curl -s localhost:3000/_navi/a/getStats | jq          # cached GET transport
curl -s localhost:3000/_navi/manifest | jq

curl -s localhost:3000/_navi/action -H 'Content-Type: application/json' \
  -d '{"action":"increment","payload":{"amount":5}}' | jq

# Batch: entries collapse through singleflight, so a repeated action is invoked once
curl -s localhost:3000/_navi/action -H 'Content-Type: application/json' \
  -d '{"_batch":[{"id":"1","action":"getStats"},{"id":"2","action":"getStats"}]}' | jq
```

Every request is logged with the tier that answered it, so the caching layers
are visible while you work:

```
20:16:08 PM  POST /_navi/action     200    7.7ms tier:NONE,SINGLEFLIGHT [AVOIDED]
20:16:08 PM  GET  /_navi/a/getStats  200    0.3ms tier:L1-HEAP        [AVOIDED]
```

`[AVOIDED]` means the response was served without invoking the handler — the
number that matters. The tier is read from the response envelope, not a header:
a single action reports `_meta.cacheHit`, a batch reports one `cacheHit` per
entry in `results`.

Other scripts: `bun run check` (typecheck, tests, build), `bun test`,
`bun run demo`, `bun run build`.

## Release

The name `navi-serverless` is unclaimed on npm. To publish:

```sh
npm login                  # not authenticated on this machine yet
npm run check              # typecheck, 94 tests, build
npm publish                # runs `prepare`, then packs dist/ + README.md
```

`files` limits the tarball to `dist` and `README.md` (46 files, ~83 kB), so
tests, examples, and configs stay out of the registry.

Notes for the first release:

- **Ship as a prerelease** while the API settles. `npm publish --tag next`
  installs with `npm i navi-serverless@next` and leaves `@latest` untouched.
- **`TokenVerifierContext` is a breaking type change** from an earlier
  two-parameter verifier shape. Worth a `CHANGELOG.md` entry before `0.1.0`.
- **`prepare` builds from source on install.** Anyone installing from GitHub
  needs `typescript` available, which npm provides as a devDependency, so this
  holds for npm and pnpm; a Bun-only install of the git URL also works.
- **`@SecretModel` is required** wherever `@Secret` is used. A field claimed by
  nothing throws `CONFIG_ERROR` at registration rather than leaking at runtime.
- **`Secret<T>` is required for type-level stripping.** A bare `@Secret` on a
  `string` field still strips on the wire but stayed in the public type, so
  `out.apiKey` type-checked and read `undefined`. That was a bug, not a
  limitation, and it is fixed; the annotation is new, so call it out in the
  changelog if you published before this.

## License

MIT
