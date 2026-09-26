/**
 * A complete, runnable demo: `bun run examples/local-bun.ts`.
 *
 * It mounts the engine on a real Bun server, then drives it with the real
 * client over real HTTP, printing what each layer saved. Nothing here is
 * mocked, so the numbers are the ones you would see in production.
 */

import {
  NaviServerless,
  Secret,
  SecretModel,
  defineSecretSchema,
  signToken,
  verifyToken,
} from "../src/index.ts";
import { createBunFetch, createBunServeOptions } from "../src/adapters.ts";
import { NaviClient } from "../src/client/index.ts";
import type { Role, TokenResult } from "../src/index.ts";

/* ------------------------------- the model -------------------------------- */

@SecretModel
class Order {
  id: string;
  customer: string;
  total: number;

  @Secret
  cardLast4: string;

  @Secret
  fraudScore: number;

  constructor(id: string, customer: string, total: number, cardLast4: string, fraudScore: number) {
    this.id = id;
    this.customer = customer;
    this.total = total;
    this.cardLast4 = cardLast4;
    this.fraudScore = fraudScore;
  }
}

const OrderSchema = defineSecretSchema<Order>()({
  cardLast4: "secret",
  fraudScore: "secret",
});

/* ------------------------------ fake datastore ----------------------------- */

const db = new Map<string, Order>();
let lookupCount = 0;

/**
 * Stands in for a real database call: async, and slow enough that a burst of
 * requests genuinely overlaps. That overlap is the entire reason singleflight
 * exists — a fast handler would be masked by the L1 cache instead.
 */
const loadOrder = async (id: string): Promise<Order> => {
  lookupCount++;
  await Bun.sleep(25);
  const existing = db.get(id);
  if (existing !== undefined) return existing;
  const created = new Order(id, `cus_${id}`, 129.5 + Number(id), "4242", 0.07);
  db.set(id, created);
  return created;
};

/* -------------------------------- the engine ------------------------------ */

const SECRET = "demo-signing-secret-please-rotate";
const app = new NaviServerless({
  verifyToken: async (request): Promise<TokenResult> => {
    const header = request.headers.get("Authorization");
    if (header === null || !header.startsWith("Bearer ")) {
      return { ok: true, role: "guest", userId: undefined, claims: {} };
    }
    return verifyBearer(header.slice("Bearer ".length));
  },
  rateLimit: { limit: 120, windowSeconds: 60 },
})
  .registerAction({
    name: "getOrder",
    cache: { ttl: 30, swr: 120, scope: "public", tags: ["orders"] },
    schema: OrderSchema,
    handler: async (_ctx, input: { orderId: string }) => loadOrder(input.orderId),
  })
  .registerAction({
    name: "listOrders",
    cache: { ttl: 10, scope: "private" },
    handler: (ctx) => ({ userId: ctx.userId, orders: [...db.keys()] }),
  })
  .registerAction({
    name: "cancelOrder",
    access: { roles: ["admin", "support"], allowGuest: false },
    handler: async (ctx, input: { orderId: string }) => {
      await loadOrder(input.orderId);
      db.delete(input.orderId);
      await app.invalidate("orders");
      return { cancelled: input.orderId, by: ctx.userId ?? ctx.role };
    },
  });

/** Verifies a token minted by `signToken` and maps its claims onto a role. */
async function verifyBearer(token: string): Promise<TokenResult> {
  const verified = await verifyToken(token, SECRET);
  // An invalid token is simply a guest. Rejecting it outright is a policy
  // choice, and the cheaper one for an edge function.
  if (!verified.ok) return { ok: true, role: "guest", userId: undefined, claims: {} };
  const role: Role = verified.claims["role"] === "admin" ? "admin" : "user";
  return {
    ok: true,
    role,
    userId: typeof verified.claims["sub"] === "string" ? verified.claims["sub"] : undefined,
    claims: verified.claims,
  };
}

/* ------------------------------- the server ------------------------------- */

const port = Number(process.env["PORT"] ?? 8787);
const server = Bun.serve({ ...createBunServeOptions({ port }), fetch: createBunFetch(app) });
const origin = `http://localhost:${server.port}`;

/* --------------------------------- the demo ------------------------------- */

const line = (label: string, value: string): void => console.log(`  ${label.padEnd(34)} ${value}`);
const heading = (text: string): void => console.log(`\n\x1b[1m${text}\x1b[0m`);

async function main(): Promise<void> {
  const adminToken = await signToken({ sub: "admin-1", role: "admin" }, SECRET);
  const userToken = await signToken({ sub: "user-1", role: "user" }, SECRET);

  const client = new NaviClient<typeof app>({
    endpoint: `${origin}/_navi/action`,
    token: () => userToken,
    identity: () => "user-1",
  });

  heading("1. A cold read runs the handler exactly once");
  const cold = await client.callDetailed("getOrder", { orderId: "1001" });
  line("datastore lookups", String(lookupCount));
  line("client tier", cold.tier);
  line("server tier", cold.serverTier ?? "NONE");
  line("payload", JSON.stringify(cold.data));

  heading("2. The next ten reads are free");
  const repeated = await Promise.all(
    Array.from({ length: 10 }, () => client.callDetailed("getOrder", { orderId: "1001" })),
  );
  line("datastore lookups", String(lookupCount));
  line("distinct client tiers", [...new Set(repeated.map((r) => r.tier))].join(", "));
  line("suppressed by the client", String(client.metrics().suppressed));
  line("network requests", String(client.metrics().networkRequests));

  heading("3. A render pass of mixed actions costs one invocation");
  const requestsBefore = app.metrics().requests;
  await Promise.all([
    client.call("getOrder", { orderId: "1002" }),
    client.call("listOrders"),
    client.call("getOrder", { orderId: "1002" }),
  ]);
  line("engine requests", String(app.metrics().requests - requestsBefore));
  line("handler runs", String(app.metrics().handlerRuns));

  heading("4. Secrets never reach the wire");
  const raw = await fetch(`${origin}/_navi/a/getOrder?orderId=1001`);
  const envelope = (await raw.json()) as { data: Record<string, unknown>; _meta: { strippedKeys: string[] } };
  line("response keys", Object.keys(envelope.data).join(", "));
  line("stripped", envelope._meta.strippedKeys.join(", "));
  line("contains cardLast4?", String(JSON.stringify(envelope.data).includes("cardLast4")));

  heading("5. Authorization is decided before any work");
  const guest = await fetch(`${origin}/_navi/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cancelOrder", payload: { orderId: "1001" } }),
  });
  line("guest status", String(guest.status));
  line("guest body", JSON.stringify(await guest.json()));

  const denied = await client.call("cancelOrder", { orderId: "1001" }).catch((e: { code: string }) => e.code);
  line("user role", String(denied));

  const asAdmin = new NaviClient<typeof app>({
    endpoint: `${origin}/_navi/action`,
    token: () => adminToken,
    identity: () => "admin-1",
  });
  const allowed = await asAdmin.call("cancelOrder", { orderId: "1001" });
  line("admin result", JSON.stringify(allowed));

  heading("6. The CDN route serves public data without an invocation");
  const cdn = await fetch(`${origin}/_navi/a/getOrder?orderId=1002`);
  line("status", String(cdn.status));
  line("cache-control", cdn.headers.get("cache-control") ?? "");
  line("cdn-cache-control", cdn.headers.get("cdn-cache-control") ?? "");
  line("etag", cdn.headers.get("etag") ?? "");

  const etag = cdn.headers.get("etag") ?? "";
  const revalidated = await fetch(`${origin}/_navi/a/getOrder?orderId=1002`, {
    headers: { "If-None-Match": etag },
  });
  line("conditional status", `${revalidated.status} (304 = no body, no invocation)`);

  heading("7. A cache-bypassing stampede still costs one execution");
  // Raw fetches, deliberately bypassing the client: the client would dedupe
  // these before they ever reached the engine, which would prove nothing about
  // the server. This is the case singleflight exists for — 40 separate callers,
  // no shared client, every one of them missing.
  const before = { lookups: lookupCount, coalesced: app.metrics().singleflightCoalesced };
  const stampede = await Promise.all(
    Array.from({ length: 40 }, () =>
      fetch(`${origin}/_navi/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getOrder", payload: { orderId: "777" } }),
      }).then((r) => r.json() as Promise<{ ok: boolean }>),
    ),
  );
  line("concurrent requests", "40");
  line("all succeeded", String(stampede.every((r) => r.ok)));
  line("datastore lookups", String(lookupCount - before.lookups));
  line("engine singleflight coalesced", String(app.metrics().singleflightCoalesced - before.coalesced));

  heading("Totals");
  const m = app.metrics();
  line("engine requests", String(m.requests));
  line("handler runs", String(m.handlerRuns));
  line("avoided invocations", String(m.avoidedInvocations));
  line("L1 hits", String(m.l1Hits));
  line("batch collapse", String(m.batchSubrequestsCollapsed));
  line("conditional 304s", String(m.conditionalNotModified));
  line("CDN-eligible responses", String(m.cdnEligibleResponses));

  server.stop();
  console.log("\nDone. The numbers above came from a real HTTP round trip.\n");
}

await main();
