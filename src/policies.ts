/**
 * Authorization and request preflight.
 *
 * The economics: an unauthorized request that reaches a database is billed
 * compute twice (the handler *and* the query). So Navi gates in the cheapest
 * possible order —
 *
 *   1. token preflight  (HMAC over ~60 bytes, no I/O)  → drops junk before the
 *      request body is even parsed;
 *   2. declarative access rule (synchronous, zero await) → drops probes;
 *   3. functional policy (only if the app needs real logic).
 *
 * Declarative rules are intentionally synchronous: an `async` gate costs a
 * microtask hop and prevents the isolate from answering from cache in a single
 * tick, which matters when the same isolate is serving thousands of requests.
 */

import type { AccessRule, RequestContext, Role, SecurityPolicy } from "./types.js";
import { fnv1a64, utf8 } from "./internal/canonical.js";

/* -------------------------------------------------------------------------- */
/*                              Access rules                                   */
/* -------------------------------------------------------------------------- */

const GUEST: Role = "guest";

/** Normalize a `Vary`/IP list entry. Cheap, prefix-based matching only. */
function ipMatches(clientIp: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern.endsWith("/")) {
      if (clientIp.startsWith(pattern)) return true;
      continue;
    }
    if (pattern.includes("/")) {
      // CIDR-lite: compare the network prefix only (a /64 or a /24 in practice).
      const [rawNet, rawBits] = pattern.split("/") as [string, string];
      const bits = Number.parseInt(rawBits, 10);
      if (Number.isNaN(bits) || bits <= 0 || bits > 32) continue;
      const toBits = (ip: string): number | undefined => {
        const parts = ip.split(".");
        if (parts.length !== 4) return undefined;
        let acc = 0;
        for (const part of parts) {
          const octet = Number.parseInt(part, 10);
          if (Number.isNaN(octet) || octet < 0 || octet > 255) return undefined;
          acc = (acc << 8) | octet;
        }
        return acc >>> 0;
      };
      const ipBits = toBits(clientIp);
      const netBits = toBits(rawNet);
      if (ipBits === undefined || netBits === undefined) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((ipBits & mask) === (netBits & mask)) return true;
      continue;
    }
    if (clientIp === pattern) return true;
  }
  return false;
}

/**
 * Turn a declarative `AccessRule` into a synchronous policy.
 * Returns a policy that never awaits, so the engine can keep it on the
 * cache-hit fast path.
 */
export function allowAccess(rule: AccessRule): SecurityPolicy {
  const roles = rule.roles;
  const allowGuest = rule.allowGuest ?? roles === undefined;
  return (ctx: RequestContext): boolean => {
    if (rule.denyIps !== undefined && ipMatches(ctx.clientIp, rule.denyIps)) return false;
    if (rule.allowIps !== undefined && !ipMatches(ctx.clientIp, rule.allowIps)) return false;
    if (rule.requireUser === true && ctx.userId === undefined) return false;
    if (roles !== undefined) {
      if (ctx.role === GUEST) return allowGuest && !roles.includes(GUEST);
      return roles.includes(ctx.role);
    }
    return true;
  };
}

/** Shorthand: caller must hold one of `roles`. */
export function requireRole(...roles: readonly Role[]): SecurityPolicy {
  return allowAccess({ roles, allowGuest: false });
}

/** Combine policies: every one must pass. */
export function allOf(...policies: readonly SecurityPolicy[]): SecurityPolicy {
  if (policies.length === 1) return policies[0] as SecurityPolicy;
  return async (ctx) => {
    for (const policy of policies) {
      if (!(await policy(ctx))) return false;
    }
    return true;
  };
}

/** Combine policies: at least one must pass. */
export function anyOf(...policies: readonly SecurityPolicy[]): SecurityPolicy {
  return async (ctx) => {
    for (const policy of policies) {
      if (await policy(ctx)) return true;
    }
    return false;
  };
}

/* -------------------------------------------------------------------------- */
/*                            Cost-control policies                            */
/* -------------------------------------------------------------------------- */

export interface RateLimitOptions {
  /** Sustained requests per window per key. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Identity source; defaults to userId, then client IP. */
  readonly keyBy?: ((ctx: RequestContext) => string) | undefined;
}

/**
 * Isolate-local token bucket. Not a distributed rate limiter — it is a *load
 * shedder* that stops one hot client from burning the isolate's CPU budget, and
 * it costs a single Map lookup on the request path.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();
  readonly #options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.#options = options;
  }

  check(ctx: RequestContext): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    const key = this.#key(ctx);
    const bucket = this.#buckets.get(key);

    if (bucket === undefined || now > bucket.resetAt) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.#options.windowSeconds * 1000 });
      if (this.#buckets.size > 10_000) this.#sweep(now);
      return { allowed: true, remaining: this.#options.limit - 1, retryAfterSeconds: 0 };
    }

    bucket.count++;
    const allowed = bucket.count <= this.#options.limit;
    return {
      allowed,
      remaining: Math.max(0, this.#options.limit - bucket.count),
      retryAfterSeconds: allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.#buckets.clear();
    else this.#buckets.delete(key);
  }

  #key(ctx: RequestContext): string {
    if (this.#options.keyBy !== undefined) return this.#options.keyBy(ctx);
    return ctx.userId ?? `ip:${ctx.clientIp}`;
  }

  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now > bucket.resetAt) this.#buckets.delete(key);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                             Signed capability token                          */
/* -------------------------------------------------------------------------- */

export interface TokenClaims {
  /** Subject (user id). */
  readonly sub?: string;
  readonly role?: Role;
  /** Expiry, seconds since epoch. */
  readonly exp?: number;
  readonly iat?: number;
  /** Arbitrary app claims (tenant, plan, ab-test...). */
  readonly [claim: string]: unknown;
}

export type TokenResult =
  | { readonly ok: true; readonly claims: TokenClaims; readonly role: Role; readonly userId: string | undefined }
  | { readonly ok: false; readonly code: "TOKEN_MISSING" | "TOKEN_INVALID" | "TOKEN_EXPIRED" };

const TOKEN_VERSION = "v1";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array | undefined {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Sign a compact capability token: `v1.<base64url(json)>.<base64url(hmac)>`.
 * 60-ish bytes, no round trip to a session store — which is the entire point:
 * verification is pure CPU, so auth stops being a billed dependency.
 */
export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  const body = `${TOKEN_VERSION}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, utf8(body) as unknown as BufferSource),
  );
  return `${body}.${base64UrlEncode(signature)}`;
}

export interface VerifyOptions {
  /** Leeway for clock skew, seconds. */
  readonly leewaySeconds?: number;
  /** Reject tokens whose `exp` is missing. */
  readonly requireExpiry?: boolean;
}

export async function verifyToken(
  token: string,
  secret: string,
  options?: VerifyOptions,
): Promise<TokenResult> {
  if (typeof token !== "string" || token.length === 0) return { ok: false, code: "TOKEN_MISSING" };

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, code: "TOKEN_INVALID" };

  const [, payload, signature] = parts as [string, string, string];
  const signatureBytes = base64UrlDecode(signature);
  if (signatureBytes === undefined) return { ok: false, code: "TOKEN_INVALID" };

  const key = await hmacKey(secret);
  // `crypto.subtle.verify` is constant-time inside the platform; never hand-roll
  // a byte comparison for MACs.
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as unknown as BufferSource,
    utf8(`${TOKEN_VERSION}.${payload}`) as unknown as BufferSource,
  );
  if (!valid) return { ok: false, code: "TOKEN_INVALID" };

  const claimsBytes = base64UrlDecode(payload);
  if (claimsBytes === undefined) return { ok: false, code: "TOKEN_INVALID" };

  let claims: TokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(claimsBytes)) as TokenClaims;
  } catch {
    return { ok: false, code: "TOKEN_INVALID" };
  }

  const now = Math.floor(Date.now() / 1000);
  const leeway = options?.leewaySeconds ?? 5;
  if (typeof claims.exp === "number") {
    if (claims.exp + leeway < now) return { ok: false, code: "TOKEN_EXPIRED" };
  } else if (options?.requireExpiry === true) {
    return { ok: false, code: "TOKEN_INVALID" };
  }

  const role = (typeof claims.role === "string" ? claims.role : "guest") as Role;
  const userId = typeof claims.sub === "string" ? claims.sub : undefined;
  return { ok: true, claims, role, userId };
}

/**
 * What a token verifier gets besides the request.
 *
 * The full `RequestContext` cannot exist yet — role and user id come *out of*
 * the token — so this is the subset that is knowable before verification. The
 * important one is `env`: on Cloudflare, Deno, and Workers the signing secret
 * lives in a binding, and a verifier that cannot see it has no way to check a
 * signature.
 */
export interface TokenVerifierContext {
  readonly request: Request;
  /** Platform bindings for this request (`ctx.env` on a handler). */
  readonly env: Readonly<Record<string, unknown>>;
  /** Resolved caller IP, for IP-keyed lookup tables. */
  readonly clientIp: string;
  /** Extend the isolate's lifetime, e.g. to finish a cache write. */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** Parsed query string, present for GET reads. */
  readonly query: Readonly<Record<string, string>>;
}

export type TokenVerifier = (request: Request, context: TokenVerifierContext) => Promise<TokenResult>;

/**
 * Build a verifier for the `Authorization: Bearer` convention, with a cache of
 * verified tokens.
 *
 * The cache matters: browsers reuse a token across dozens of actions, and
 * `crypto.subtle.verify` is ~50µs. A bounded LRU of verified digests (keyed by
 * the token's own hash — never the raw token) removes that cost from the
 * hot path while staying stateless.
 */
export function bearerVerifier(
  secret: string,
  options?: VerifyOptions & { maxEntries?: number },
): TokenVerifier {
  const maxEntries = options?.maxEntries ?? 512;
  const verified = new Map<string, { role: Role; userId: string | undefined; claims: TokenClaims }>();

  return async (request: Request): Promise<TokenResult> => {
    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (token.length === 0) {
      return { ok: true, role: "guest", userId: undefined, claims: {} };
    }

    const digest = fnv1a64(token);
    const cached = verified.get(digest);
    if (cached !== undefined) {
      if (typeof cached.claims.exp === "number" && cached.claims.exp + 5 < Date.now() / 1000) {
        verified.delete(digest);
      } else {
        // Refresh LRU position.
        verified.delete(digest);
        verified.set(digest, cached);
        return { ok: true, role: cached.role, userId: cached.userId, claims: cached.claims };
      }
    }

    const result = await verifyToken(token, secret, options);
    if (!result.ok) return result;

    if (verified.size >= maxEntries) {
      const oldest = verified.keys().next();
      if (!oldest.done) verified.delete(oldest.value);
    }
    verified.set(digest, { role: result.role, userId: result.userId, claims: result.claims });
    return result;
  };
}
