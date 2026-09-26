/**
 * Cloudflare Workers.
 *
 *   wrangler.toml:
 *     name = "navi-api"
 *     main = "examples/cloudflare-worker.ts"
 *     compatibility_date = "2024-12-01"
 *
 * The adapter's only job is to hand the engine a `Request`, the env bindings,
 * and an `ExecutionContext`. Caching, batching, auth, and secret projection are
 * all declared next to the actions.
 */

import {
  NaviServerless,
  Secret,
  SecretModel,
  verifyToken,
  type Role,
  type TokenResult,
} from "../src/index.ts";
import { createCloudflareWorker } from "../src/adapters.ts";

/**
 * A `type`, not an `interface`: the engine types bindings as
 * `Record<string, unknown>`, and only type aliases get an implicit index
 * signature.
 */
type Env = {
  readonly DB: D1Database;
  readonly ARTICLES: KVNamespace;
  readonly SIGNING_SECRET: string;
};

/* --------------------------------- model ---------------------------------- */

/**
 * No constructor parameter properties anywhere: they compile to assignment
 * statements, and the whole point of this library is that models can be
 * emitted as plain, erasable JavaScript. Declare the fields, then assign.
 */
@SecretModel
class Article {
  slug: string;
  title: string;
  body: string;

  // `@Secret` marks a field for projection: the handler sees it, and it never
  // reaches the wire or a cache entry.
  @Secret
  authorEmail: string;

  @Secret
  internalNotes: string;

  constructor(row: ArticleRow) {
    this.slug = row.slug;
    this.title = row.title;
    this.body = row.body;
    this.authorEmail = row.author_email;
    this.internalNotes = row.internal_notes;
  }
}

interface ArticleRow {
  slug: string;
  title: string;
  body: string;
  author_email: string;
  internal_notes: string;
}

/* --------------------------------- engine --------------------------------- */

const app = new NaviServerless({
  /**
   * The verifier receives the request *and* the request's env, which is where
   * Cloudflare puts the signing secret. This runs before the body is even
   * parsed, so a forged token never costs a D1 query.
   */
  verifyToken: async (request, { env }): Promise<TokenResult> => {
    const header = request.headers.get("Authorization");
    const raw = header !== null && header.startsWith("Bearer ") ? header.slice(7) : "";
    const secret = env["SIGNING_SECRET"];
    if (raw === "" || typeof secret !== "string") {
      return { ok: true, role: "guest", userId: undefined, claims: {} };
    }
    const result = await verifyToken(raw, secret);
    // An unverifiable token is a guest, not a 401: a public read should not
    // fail because a stale cookie is attached to it.
    if (!result.ok) return { ok: true, role: "guest", userId: undefined, claims: {} };
    return {
      ok: true,
      role: (result.claims["role"] === "admin" ? "admin" : "user") as Role,
      userId: typeof result.claims["sub"] === "string" ? result.claims["sub"] : undefined,
      claims: result.claims,
    };
  },
  rateLimit: { limit: 200, windowSeconds: 60 },
})
  .registerAction({
    name: "getArticle",
    cache: {
      ttl: 60,
      swr: 600,
      scope: "public",
      tags: ["articles"],
      // `public` also publishes the action over
      // `GET /_navi/a/getArticle?slug=...`, which Cloudflare can answer from
      // its edge cache without waking this worker at all.
      cdn: true,
    },
    handler: async (ctx, input: { slug: string }) => {
      // `ctx.env` is a plain binding bag so the engine stays runtime-agnostic;
      // assert the shape you expect once, at the edge of your code.
      const db = ctx.env.DB as D1Database;
      const row = await db.prepare("SELECT * FROM articles WHERE slug = ?")
        .bind(input.slug)
        .first<ArticleRow>();
      if (row === null) throw new Error(`No article '${input.slug}'.`);
      // `@Secret` fields are stripped here, before serialization: the author's
      // email never reaches the client and never enters a cache entry.
      return new Article(row);
    },
  })
  .registerAction({
    name: "publishArticle",
    // A write is never cached and never reachable over GET.
    access: { roles: ["admin", "editor"] },
    handler: async (ctx, input: { slug: string }) => {
      const db = ctx.env.DB as D1Database;
      await db.prepare("UPDATE articles SET published = 1 WHERE slug = ?").bind(input.slug).run();
      // Everyone holding a stale copy gets the new one on their next read. The
      // promise is passed to `waitUntil`, so the write still lands if the
      // response is already on its way out.
      ctx.waitUntil(app.invalidate("articles"));
      return { published: input.slug };
    },
  });

const worker = createCloudflareWorker(app);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return worker.fetch(request, env, ctx);
  },
  /** Cron triggers reach the same engine, for warming caches on a schedule. */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await worker.scheduled?.(event, env, ctx);
  },
};
