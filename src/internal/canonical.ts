/**
 * Deterministic serialization + hashing.
 *
 * Two jobs:
 *  1. `stableStringify` produces a *canonical* representation of an arbitrary
 *     payload. Cache keys must not depend on object key insertion order, or two
 *     logically identical requests would miss the cache and cost an invocation.
 *  2. `fnv1a64` collapses that representation into a fixed-width, URL-safe id
 *     so cache keys stay small enough to sit in a `Cache-Control`/ETag header.
 *
 * Both are hand-rolled rather than pulled from a dependency: this code runs on
 * the hottest path of every request, and every byte of module graph matters in a
 * cold V8 isolate.
 */

const textEncoder = /* @__PURE__ */ new TextEncoder();

/** Marker for values JSON cannot round-trip (they must not reach a cache key). */
export const UNSERIALIZABLE = Symbol("navi.unserializable");

export type CanonicalResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

export function stableStringify(value: unknown, seen?: Set<object>): CanonicalResult {
  const out = write(value, seen ?? new Set<object>(), 0);
  if (out === UNSERIALIZABLE) {
    return { ok: false, reason: "value is not JSON-serializable" };
  }
  return { ok: true, value: out };
}

const MAX_DEPTH = 12;

function write(value: unknown, seen: Set<object>, depth: number): string | typeof UNSERIALIZABLE {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return "u"; // distinguishes `undefined` from absent in strict canonical form
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? (Object.is(value, -0) ? "-0" : String(value)) : UNSERIALIZABLE;
    case "bigint":
      return `"${value.toString()}n"`;
    case "string":
      return JSON.stringify(value);
    case "function":
    case "symbol":
      return UNSERIALIZABLE;
    default:
      break;
  }

  if (value instanceof Date) return `d${value.getTime()}`;
  if (value instanceof URL) return `u${value.href}`;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => [k, v] as const);
    return mapLike(entries, seen, depth);
  }
  if (value instanceof Set) return setLike([...value.values()], seen, depth);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return bytesLike(value, seen, depth);

  if (depth >= MAX_DEPTH) return UNSERIALIZABLE;

  const obj = value as object;
  if (seen.has(obj)) return UNSERIALIZABLE; // cycles are un-cacheable, not fatal
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      let acc = "[";
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) acc += ",";
        const part = write(obj[i], seen, depth + 1);
        if (part === UNSERIALIZABLE) return UNSERIALIZABLE;
        acc += part;
      }
      return `${acc}]`;
    }

    // Only own enumerable string keys, sorted — matches JSON.stringify semantics
    // for plain data while being order-independent.
    const keys = Object.keys(obj).sort();
    let acc = "{";
    let first = true;
    for (const key of keys) {
      const part = write((obj as Record<string, unknown>)[key], seen, depth + 1);
      if (part === UNSERIALIZABLE) return UNSERIALIZABLE;
      if (part === "u") continue; // drop undefined values entirely
      if (!first) acc += ",";
      first = false;
      acc += `${JSON.stringify(key)}:${part}`;
    }
    return `${acc}}`;
  } finally {
    seen.delete(obj);
  }
}

function mapLike(entries: readonly (readonly [unknown, unknown])[], seen: Set<object>, depth: number): string | typeof UNSERIALIZABLE {
  if (depth >= MAX_DEPTH) return UNSERIALIZABLE;
  const encoded: string[] = [];
  for (const [k, v] of entries) {
    const ks = write(k, seen, depth + 1);
    const vs = write(v, seen, depth + 1);
    if (ks === UNSERIALIZABLE || vs === UNSERIALIZABLE) return UNSERIALIZABLE;
    encoded.push(`${ks}\u0000${vs}`);
  }
  encoded.sort();
  return `m[${encoded.join(",")}]`;
}

function setLike(values: readonly unknown[], seen: Set<object>, depth: number): string | typeof UNSERIALIZABLE {
  if (depth >= MAX_DEPTH) return UNSERIALIZABLE;
  const encoded: string[] = [];
  for (const v of values) {
    const vs = write(v, seen, depth + 1);
    if (vs === UNSERIALIZABLE) return UNSERIALIZABLE;
    encoded.push(vs);
  }
  encoded.sort();
  return `s[${encoded.join(",")}]`;
}

function bytesLike(value: ArrayBuffer | ArrayBufferView, seen: Set<object>, depth: number): string | typeof UNSERIALIZABLE {
  if (depth >= MAX_DEPTH) return UNSERIALIZABLE;
  const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    const code = view[i] as number;
    hash = Math.imul(hash ^ code, 0x01000193) >>> 0;
  }
  void seen;
  return `b${view.length}:${hash.toString(16)}`;
}

/**
 * FNV-1a 64-bit over UTF-8 bytes, emitted as 16 lowercase hex chars.
 *
 * JavaScript bitwise operators are 32-bit, so the 64-bit accumulator is held in
 * four 16-bit limbs and the FNV prime (`0x100000001b3`) is applied as a
 * schoolbook limb multiply. Every partial product is < 2^32 and the largest
 * intermediate sum is < 2^53, so the whole thing stays in exact double
 * arithmetic — no BigInt allocation on the cache-key hot path.
 */
export function fnv1a64(input: string): string {
  const bytes = textEncoder.encode(input);

  // offset basis 0xcbf29ce484222325
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;

  for (let i = 0; i < bytes.length; i++) {
    h0 = (h0 ^ (bytes[i] as number)) & 0xffff;

    // prime 0x0000_0100_0000_01b3 as little-endian 16-bit limbs
    const r0 = h0 * 0x01b3;
    const r1 = h1 * 0x01b3;
    const r2 = h2 * 0x01b3 + h0 * 0x0100; // h0 * P2
    const r3 = h3 * 0x01b3 + h1 * 0x0100; // h1 * P2 + h3 * P0

    let carry = r0;
    h0 = carry & 0xffff;
    carry = Math.floor(carry / 0x10000) + r1;
    h1 = carry & 0xffff;
    carry = Math.floor(carry / 0x10000) + r2;
    h2 = carry & 0xffff;
    carry = Math.floor(carry / 0x10000) + r3;
    h3 = carry & 0xffff;
  }

  return (
    h3.toString(16).padStart(4, "0") +
    h2.toString(16).padStart(4, "0") +
    h1.toString(16).padStart(4, "0") +
    h0.toString(16).padStart(4, "0")
  );
}

/**
 * Fast non-cryptographic string hash (djb2-xor) for hot in-memory maps where
 * collisions only cost a redundant execution, never a security property.
 */
export function fastHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function utf8(input: string): Uint8Array {
  return textEncoder.encode(input);
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
