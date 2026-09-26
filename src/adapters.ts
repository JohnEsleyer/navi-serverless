/**
 * Platform adapters.
 *
 * Each adapter is a few lines: the engine needs only `Request`, `Response` and
 * a `waitUntil` hook, all of which every V8 edge runtime provides. Keeping this
 * surface thin is deliberate — a cold isolate pays for every module it imports,
 * so nothing here pulls in a runtime SDK or reaches for Node globals directly.
 */

import { NaviError } from "./errors.js";
import type { NaviServerless } from "./server.js";
import type { ActionMap } from "./types.js";

/** The `ExecutionContext` shape shared by workerd and Bun. */
export interface EdgeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export type EdgeEnv = Record<string, unknown>;

/** Drops a promise safely when the platform gives us no lifetime extension. */
const noopWaitUntil: EdgeExecutionContext["waitUntil"] = (promise) => {
  void promise.catch(() => undefined);
};

/* -------------------------------------------------------------------------- */
/*                            Cloudflare Workers                               */
/* -------------------------------------------------------------------------- */

export interface CloudflareWorker<M extends ActionMap = ActionMap> {
  fetch(request: Request, env: EdgeEnv, ctx: EdgeExecutionContext): Promise<Response>;
  /** Pair with `app.sweep()` so a warm isolate releases expired entries. */
  scheduled?(event: unknown, env: EdgeEnv, ctx: EdgeExecutionContext): Promise<void>;
}

/**
 * `export default createCloudflareWorker(app)`.
 *
 * Wires `scheduled()` to `app.sweep()` by default: a long-lived isolate that
 * never trims is a slow leak, and Cloudflare is the runtime most likely to keep
 * one alive.
 */
export function createCloudflareWorker<M extends ActionMap = ActionMap>(
  app: NaviServerless<M>,
  options?: { readonly autoSweep?: boolean },
): CloudflareWorker<M> {
  const worker: CloudflareWorker<M> = {
    fetch: (request, env, ctx) => app.handleRequest(request, env, ctx),
  };
  if (options?.autoSweep !== false) {
    worker.scheduled = async () => {
      app.sweep();
    };
  }
  return worker;
}

/* -------------------------------------------------------------------------- */
/*                          Vercel Edge / Next.js                              */
/* -------------------------------------------------------------------------- */

export interface VercelEdgeContext {
  waitUntil?(promise: Promise<unknown>): void;
}

function waitUntilOf(context: VercelEdgeContext | undefined): EdgeExecutionContext["waitUntil"] {
  return typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : noopWaitUntil;
}

/**
 * `export const GET = createVercelEdgeHandler(app)`.
 *
 * Vercel passes the platform context as the second argument; older Edge
 * runtimes pass only the request, in which case background work degrades to a
 * detached promise.
 */
export function createVercelEdgeHandler<M extends ActionMap = ActionMap>(
  app: NaviServerless<M>,
  env?: Record<string, unknown>,
): (request: Request, context?: VercelEdgeContext) => Promise<Response> {
  return async (request, context) =>
    app.handleRequest(request, env ?? processEnv(), { waitUntil: waitUntilOf(context) });
}

/** Next.js route handler — identical shape, explicit bindings. */
export function createNextRouteHandler<M extends ActionMap = ActionMap>(
  app: NaviServerless<M>,
  env?: Record<string, unknown>,
): (request: Request, context?: VercelEdgeContext) => Promise<Response> {
  return createVercelEdgeHandler(app, env);
}

/* -------------------------------------------------------------------------- */
/*                                   Deno                                      */
/* -------------------------------------------------------------------------- */

export interface DenoServeInfo {
  readonly remoteAddr: { readonly hostname: string };
}

export type DenoServeHandler = (request: Request, info: DenoServeInfo) => Response | Promise<Response>;

interface DenoGlobal {
  readonly env?: { toObject(): Record<string, string> };
}

/**
 * `Deno.serve(createDenoHandler(app))`.
 *
 * Deno has no `ExecutionContext`, so the returned handler tracks background
 * work itself and gives it a short grace window on the event loop.
 */
export function createDenoHandler<M extends ActionMap = ActionMap>(
  app: NaviServerless<M>,
  options?: { readonly backgroundGraceMs?: number },
): DenoServeHandler {
  const grace = options?.backgroundGraceMs ?? 5_000;

  return (request, info) => {
    const pending = new Set<Promise<unknown>>();
    const waitUntil: EdgeExecutionContext["waitUntil"] = (promise) => {
      const tracked = promise.catch(() => undefined);
      pending.add(tracked);
      void tracked.finally(() => {
        pending.delete(tracked);
      });
    };

    // `remoteAddr` has been an object, an optional field, and a bare string
    // across Deno versions. Treat every shape as "address unknown" rather than
    // throwing on a property access.
    const remote = info?.remoteAddr as { hostname?: string } | string | undefined;
    const hostname = typeof remote === "string" ? remote : remote?.hostname;
    const result = app.handleRequest(
      hostname === undefined ? request : withClientIp(request, hostname),
      denoEnv(),
      { waitUntil },
    );

    return result.finally(() => {
      if (pending.size === 0) return;
      // Keep the loop alive just long enough for the cache writes to land.
      setTimeout(() => {
        void Promise.race([Promise.allSettled([...pending]), delay(grace)]);
      }, 0);
    });
  };
}

/* -------------------------------------------------------------------------- */
/*                                    Bun                                      */
/* -------------------------------------------------------------------------- */

export interface BunServeOptions {
  readonly port?: number;
  readonly hostname?: string;
  /** Keep the process alive for background `waitUntil` work. */
  readonly development?: boolean;
}

/**
 * Options to spread into `Bun.serve(...)`:
 * `Bun.serve({ ...createBunServeOptions({ port }), fetch: createBunFetch(app) })`.
 */
export function createBunServeOptions(options?: BunServeOptions): BunServeOptions {
  return { development: false, ...options };
}

/**
 * The `fetch` half of a `Bun.serve` call:
 * `Bun.serve({ ...createBunServeOptions(), fetch: createBunFetch(app) })`.
 *
 * Bun's `Server` object has no `waitUntil`, so background cache writes are
 * detached rather than tracked. The singleflight and L1 tiers — the ones that
 * matter for invocation count — are unaffected.
 */
export function createBunFetch<M extends ActionMap = ActionMap>(
  app: NaviServerless<M>,
): (request: Request, server?: unknown) => Promise<Response> {
  return (request) => app.handleRequest(request, processEnv(), { waitUntil: noopWaitUntil });
}

/* -------------------------------------------------------------------------- */
/*                                  Node 18+                                   */
/* -------------------------------------------------------------------------- */

export interface NodeRequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | readonly string[] | undefined>;
  /** Pre-read body, for tests and middleware that already buffered it. */
  readonly body?: string | undefined;
  /**
   * The unconsumed request stream, as on Node's `IncomingMessage`. A
   * `Request` cannot be constructed from a Node stream, so the adapter reads
   * this first; without it every POST arrives empty.
   */
  readonly on?: ((event: string, listener: (...args: never[]) => void) => unknown) | undefined;
  readonly removeListener?: ((event: string, listener: (...args: never[]) => void) => unknown) | undefined;
}

export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** Express/Node-style handler, built on the runtime's Web globals. */
export function createNodeHandler<M extends ActionMap = ActionMap>(
  app: NaviServerless<M>,
  env?: Record<string, unknown>,
): (req: NodeRequestLike, res: NodeResponseLike) => Promise<void> {
  return async (req, res) => {
    let response: Response;
    try {
      const request = toWebRequest(req, await readBody(req));
      response = await app.handleRequest(request, env ?? processEnv(), { waitUntil: noopWaitUntil });
    } catch (error) {
      // A rejected promise here would be an unhandled rejection, which takes the
      // whole process down instead of one request. Even an engine bug must
      // answer with a 500.
      response = new Response(
        JSON.stringify({
          ok: false,
          error: { code: "INTERNAL", message: "The request could not be handled." },
        }),
        { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
      // Log, never rethrow: an async rethrow on Node is an unhandled exception
      // and would take the process down instead of failing one request.
      console.error("[navi] unhandled adapter failure", error);
    }
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.end(await response.text());
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

interface ProcessLike {
  readonly env?: Record<string, string | undefined>;
}

function processEnv(): Record<string, unknown> {
  const proc = (globalThis as { process?: ProcessLike }).process;
  return (proc?.env ?? {}) as Record<string, unknown>;
}

function denoEnv(): Record<string, unknown> {
  const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
  if (deno?.env === undefined) return {};
  try {
    return deno.env.toObject();
  } catch {
    return {};
  }
}

/**
 * `req.url` is origin-relative (`/_navi/action`), and `new Request()` rejects a
 * relative URL outright — so the origin has to be reconstructed from the
 * `Host` header. `x-forwarded-proto` wins when a proxy terminated TLS.
 */
function requestUrl(req: NodeRequestLike, headers: Headers): string {
  if (/^https?:\/\//i.test(req.url)) return req.url;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host === null || host.length === 0) {
    throw new NaviError("CONFIG_ERROR", "Cannot build a Request: the Node request has no Host header.");
  }
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
  const scheme = proto === "https" || proto === "wss" ? "https" : "http";
  return `${scheme}://${host}${req.url.startsWith("/") ? req.url : `/${req.url}`}`;
}

/**
 * Drain the request stream into a string.
 *
 * `GET`/`HEAD` bodies are skipped, and a body that was already buffered by
 * upstream middleware is passed straight through.
 */
async function readBody(req: NodeRequestLike): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (req.body !== undefined) return req.body;
  if (req.on === undefined) return undefined;

  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const on = req.on as (event: string, listener: (arg: unknown) => void) => unknown;
    const off =
      req.removeListener as unknown as
        | ((event: string, listener: (arg: unknown) => void) => unknown)
        | undefined;

    const cleanup = (): void => {
      if (off === undefined) return;
      off.call(req, "data", onData);
      off.call(req, "end", onEnd);
      off.call(req, "error", onError);
      off.call(req, "aborted", onAborted);
    };
    const onData = (chunk: unknown): void => {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array));
    };
    const onEnd = (): void => {
      cleanup();
      resolve(new TextDecoder().decode(concat(chunks)));
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    const onAborted = (): void => {
      cleanup();
      resolve("");
    };

    // `on` must keep its receiver: Node's EventEmitter mixin reads `this`.
    on.call(req, "data", onData);
    on.call(req, "end", onEnd);
    on.call(req, "error", onError);
    on.call(req, "aborted", onAborted);
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toWebRequest(req: NodeRequestLike, body: string | undefined): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, typeof value === "string" ? value : value.join(", "));
  }
  const init: RequestInit = { method: req.method, headers };
  const url = requestUrl(req, headers);
  if (body !== undefined && body.length > 0) {
    return new Request(url, { ...init, body });
  }
  return new Request(url, init);
}

function withClientIp(request: Request, ip: string): Request {
  if (request.headers.has("x-forwarded-for") || request.headers.has("cf-connecting-ip")) return request;
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-for", ip);
  return new Request(request, { headers });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
