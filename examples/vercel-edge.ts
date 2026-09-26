/**
 * Vercel Edge Functions.
 *
 *   app/api/navi/route.ts:
 *     export { handler as GET, handler as POST, handler as OPTIONS }
 *     export const runtime = "edge";
 *
 * The Edge runtime has no `caches` global, so the L2 tier is skipped
 * automatically; L1 still works, and `Cache-Control` still lets Vercel's CDN
 * answer repeat reads without invoking the function.
 */

import {
  NaviServerless,
  Secret,
  SecretModel,
  verifyToken,
  type Role,
  type TokenResult,
} from "../src/index.ts";
import { createVercelEdgeHandler } from "../src/adapters.ts";

/* --------------------------------- model ---------------------------------- */

interface CartRow {
  id: string;
  customer_email: string;
  total_cents: number;
  /** Billing details that must never leave the server. */
  card_last4: string;
  fraud_score: number;
}

/**
 * `@SecretModel` claims every `@Secret` field declared in the class body, so
 * they are stripped during projection. Declaration order does not matter.
 */
@SecretModel
class Cart {
  id: string;
  customer: string;
  total: number;

  @Secret
  cardLast4: string;

  @Secret
  fraudScore: number;

  constructor(row: CartRow) {
    this.id = row.id;
    this.customer = row.customer_email;
    this.total = row.total_cents / 100;
    this.cardLast4 = row.card_last4;
    this.fraudScore = row.fraud_score;
  }
}

/* --------------------------------- engine --------------------------------- */

const SECRET = process.env["CART_SIGNING_SECRET"] ?? "replace-me-in-production";

const app = new NaviServerless({
  verifyToken: async (request): Promise<TokenResult> => {
    const header = request.headers.get("Authorization");
    if (header === null || !header.startsWith("Bearer ")) {
      return { ok: true, role: "guest", userId: undefined, claims: {} };
    }
    const result = await verifyToken(header.slice(7), SECRET);
    if (!result.ok) return { ok: true, role: "guest", userId: undefined, claims: {} };
    return {
      ok: true,
      role: (result.claims["role"] === "admin" ? "admin" : "user") as Role,
      userId: typeof result.claims["sub"] === "string" ? result.claims["sub"] : undefined,
      claims: result.claims,
    };
  },
  rateLimit: { limit: 120, windowSeconds: 60 },
})
  .registerAction({
    name: "getCart",
    // Per-user L1 with a 30s window, revalidated in the background for another
    // 5 minutes. A cart read is the single most repeated call in most apps,
    // which makes it the most obvious place to stop paying for it.
    cache: { ttl: 30, swr: 300, scope: "private", keyGenerator: (_ctx, payload) => {
      const id = (payload as { cartId: string }).cartId;
      return `cart:${id}`;
    } },
    handler: async (_ctx, input: { cartId: string }) => {
      // `ctx.env` is empty on Vercel: platform env vars are inlined at build
      // time, so read them directly and keep them in the function bundle only.
      const row = await db.carts.findUnique({ where: { id: input.cartId } });
      return row === null ? new Cart(emptyCart(input.cartId)) : new Cart(row);
    },
  })
  .registerAction({
    name: "emptyCart",
    // A write is not cacheable.
    access: { roles: ["user", "admin"] },
    handler: async (ctx, input: { cartId: string }) => {
      await db.carts.delete({ where: { id: input.cartId } });
      // Drop this user's cached copy. Private entries are keyed by user, so the
      // tag is what keeps one user's mutation from invalidating everyone's.
      ctx.waitUntil(app.invalidate(`cart:${input.cartId}`));
      return { emptied: input.cartId };
    },
  });

/* --------------------------------- export --------------------------------- */

export const handler = createVercelEdgeHandler(app);

declare const db: {
  carts: {
    findUnique(args: { where: { id: string } }): Promise<CartRow | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
};

function emptyCart(id: string): CartRow {
  return { id, customer_email: "", total_cents: 0, card_last4: "", fraud_score: 0 };
}
