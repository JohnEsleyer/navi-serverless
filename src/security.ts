/**
 * Secret protection.
 *
 * Navi's hard rule: anything structurally sensitive (wholesale cost, API keys,
 * row hashes, PII) must never reach the wire. This module makes that rule
 * enforceable three ways, in increasing order of strength:
 *
 *  1. `@Secret` / `SecretFields([...])` — runtime strip driven by class metadata.
 *  2. `defineSecretSchema<T>()` — compile-time validated schema; the *type* of
 *     the response the client sees has the field removed.
 *  3. `secret(value)` — a branded box that survives being nested anywhere in a
 *     payload and is stripped recursively, including inside arrays and maps.
 *
 * The registry is a `WeakMap` rather than `Reflect.getMetadata`, because
 * `reflect-metadata` does not exist in workerd/Deno/Bun and pulling a polyfill
 * into a cold V8 isolate costs more than the entire dispatch path.
 */

/**
 * Registered on the global symbol table so two copies of Navi loaded in the
 * same isolate still recognize each other's boxes.
 */
export const SECRET_SYMBOL: unique symbol = Symbol.for("navi.secret");

/** A value that must never be serialized to a client. */
export interface SecretBox<V> {
  readonly [SECRET_SYMBOL]: true;
  readonly value: V;
}

/** Wrap a value so it is stripped wherever it appears in a response. */
export function secret<V>(value: V): SecretBox<V> {
  return { [SECRET_SYMBOL]: true, value };
}

export function isSecretBox(value: unknown): value is SecretBox<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [SECRET_SYMBOL]?: unknown })[SECRET_SYMBOL] === true
  );
}

export function unwrapSecret<V>(box: SecretBox<V>): V {
  return box.value;
}

/* -------------------------------------------------------------------------- */
/*                              Class-level metadata                           */
/* -------------------------------------------------------------------------- */

type Constructor = abstract new (...args: never[]) => unknown;

const SECRET_KEYS = new WeakMap<Constructor, ReadonlySet<string | symbol>>();

/** Declare `keys` as secret for a class. Usable as a decorator or a plain call. */
export function registerSecretKeys<T extends Constructor>(
  ctor: T,
  keys: Iterable<string | symbol>,
): T {
  const existing = SECRET_KEYS.get(ctor);
  const next = new Set<string | symbol>(existing);
  for (const key of keys) next.add(key);
  SECRET_KEYS.set(ctor, next);
  return ctor;
}

function ownerOf(target: unknown): Constructor | undefined {
  if (typeof target !== "function") return undefined;
  return target as unknown as Constructor;
}

/**
 * Secret keys for a value, including every ancestor class. Walking the
 * prototype chain is what makes `@Secret` inherited: `AdminProduct extends
 * Product` keeps `wholesaleCost` secret.
 */
export function getSecretKeys(input: unknown): ReadonlySet<string | symbol> {
  const out = new Set<string | symbol>();
  // For an instance the chain starts at the *prototype object*, so hop to its
  // constructor first; for a class, start at the class itself.
  let cursor: unknown =
    typeof input === "function" ? input : Object.getPrototypeOf(input as object)?.constructor;

  while (typeof cursor === "function") {
    const keys = SECRET_KEYS.get(cursor as Constructor);
    if (keys !== undefined) for (const key of keys) out.add(key);
    cursor = Object.getPrototypeOf(cursor);
  }
  return out;
}

interface StandardContext {
  readonly kind: string;
  readonly name: string | symbol;
  readonly static: boolean;
  readonly private: boolean;
  /** Present on field/accessor contexts in the standard convention. */
  readonly addInitializer?: ((initializer: (this: never) => void) => void) | undefined;
}

function isStandardContext(value: unknown): value is StandardContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    "name" in value &&
    "static" in value
  );
}

/**
 * Field names collected by `@Secret`, awaiting the class that owns them.
 *
 * Binding happens in `@SecretModel` (or `SecretFields`) rather than in a field
 * initializer on purpose. Bun's standard-decorator emit shares one initializer
 * table across every decorated class in a module and hardcodes the slot indices
 * into each synthesized constructor, so an `addInitializer` callback can end up
 * running the *wrong field's* initializer — silently attributing a secret to the
 * wrong class, or to none. Decoration-time collection has no such dependency:
 * the decorator context's `name` is correct, and class decorators are applied
 * after their own field decorators but before the next class is defined.
 */
const PENDING_SECRET_FIELDS: Array<string | symbol> = [];

/** Removes already-claimed names so an explicit list can satisfy `@Secret`. */
function claimPendingFields(claimed: Iterable<PropertyKey>): void {
  const set = new Set(claimed);
  for (let i = PENDING_SECRET_FIELDS.length - 1; i >= 0; i--) {
    if (set.has(PENDING_SECRET_FIELDS[i] as string | symbol)) PENDING_SECRET_FIELDS.splice(i, 1);
  }
}

/**
 * Field names that `@Secret` collected but no class ever claimed. A non-empty
 * result means a model would serialize a value the author marked as secret, so
 * the engine refuses to start rather than leak it.
 */
export function unclaimedSecretFields(): readonly (string | symbol)[] {
  return [...PENDING_SECRET_FIELDS];
}

/**
 * Marks a class field as secret. Requires `@SecretModel` (or an explicit
 * `SecretFields`) on the owning class to bind the marker — see
 * {@link unclaimedSecretFields}.
 *
 * Satisfies *both* decorator conventions: `tsc` and esbuild emit legacy
 * `(prototype, key)` calls when `experimentalDecorators` is on, Bun always
 * emits the standard `(value, context)` form. Under the standard convention the
 * field's value is still `undefined`, which is why the name is read from the
 * context rather than from the value.
 */
export function Secret<This, V>(value: V, context: ClassFieldDecoratorContext<This, V>): void;
export function Secret(target: object, propertyKey: string | symbol): void;
export function Secret(first: unknown, second: unknown): void {
  if (isStandardContext(second)) {
    if (second.kind === "field") {
      PENDING_SECRET_FIELDS.push(second.name);
    } else {
      // Accessor and method decorators can name their own target.
      PENDING_SECRET_FIELDS.push(second.name);
    }
    // Returning nothing keeps the field's own initializer, which is what we
    // want: the value must still exist on the instance, just never on the wire.
    return;
  }

  const ctor = ownerOf((first as { constructor?: unknown })?.constructor);
  if (ctor !== undefined) registerSecretKeys(ctor, [second as string | symbol]);
}

/**
 * Binds every `@Secret` field on the class it decorates:
 *
 * ```ts
 * @SecretModel
 * class Product {
 *   id: string;
 *   @Secret wholesaleCost: number;
 * }
 * ```
 *
 * Secrets are inherited: `PremiumProduct extends Product` keeps them.
 */
export function SecretModel<This extends Constructor>(
  target: This,
  context?: ClassDecoratorContext<This>,
): This {
  void context;
  return registerSecretKeys(target, PENDING_SECRET_FIELDS.splice(0, PENDING_SECRET_FIELDS.length));
}

/**
 * Class decorator form: `SecretFields(["cost", "hash"])(Product)`.
 * Prefer this when a model has many secrets, or when the field is a getter.
 */
export function SecretFields(keys: readonly (string | symbol)[]): {
  (target: Constructor): void;
  (value: Constructor, context: ClassDecoratorContext): Constructor;
} {
  const apply = (ctor: Constructor): Constructor => {
    claimPendingFields(keys);
    return registerSecretKeys(ctor, keys);
  };
  return ((first: unknown, second?: unknown): unknown =>
    second === undefined ? void apply(first as Constructor) : apply(first as Constructor)) as {
    (target: Constructor): void;
    (value: Constructor, context: ClassDecoratorContext): Constructor;
  };
}

/* -------------------------------------------------------------------------- */
/*                              Type-level schemas                            */
/* -------------------------------------------------------------------------- */

/** Declarative schema shape; keys are checked against `T` at compile time. */
export type SecretSchemaSpec<T> = {
  readonly [K in keyof T]?: T[K] extends SecretBox<unknown>
    ? "secret" | "public"
    : NonNullable<T[K]> extends object
      ? "public" | "secret" | SecretSchemaSpec<NonNullable<T[K]>>
      : "public" | "secret";
};

export type DirectSecretKeys<S> = {
  [K in keyof S]: S[K] extends "secret" ? K : never;
}[keyof S];

/**
 * The erased runtime schema: plain nested records of markers.
 */
export type RuntimeSecretSchema = Readonly<Record<string, unknown>>;

/**
 * A compiled secret schema.
 *
 * `spec` keeps the *literal* shape of the schema the caller wrote, so the
 * compiler can follow it into the client's view of the response; `keys` is the
 * pre-flattened set the projector needs at runtime. `__model` is phantom and
 * binds the model type, which is otherwise unrepresentable in an object literal.
 */
export interface SecretSchema<T, Sp extends SecretSchemaSpec<T> = SecretSchemaSpec<T>> {
  readonly __model?: T;
  readonly spec: Sp;
  readonly keys: ReadonlySet<keyof T>;
}

/**
 * Structural view used for inference, free of the model-type phantom.
 *
 * `keys` is `ReadonlySet<PropertyKey>` rather than `ReadonlySet<never>` so that
 * a real `SecretSchema<T, Sp>` actually satisfies this marker. Widening the set
 * to `never` made the marker unsatisfiable, so `PublicOutput`'s first branch
 * never matched and every `defineSecretSchema` result silently degraded to the
 * brand-only projection. The `spec` property is what `infer Sp` reads; `keys` is
 * only here to keep the two shapes related.
 */
export interface SecretSchemaMarker<Sp> {
  readonly spec: Sp;
  readonly keys: ReadonlySet<PropertyKey>;
}

export function defineSecretSchema<T>(): <const S extends SecretSchemaSpec<T>>(
  schema: S,
) => SecretSchema<T, S> {
  return function define<S extends SecretSchemaSpec<T>>(schema: S) {
    const keys = new Set<keyof T>();
    for (const key of Object.keys(schema) as (keyof T & string)[]) {
      if (schema[key] === "secret") keys.add(key);
    }
    // A schema is a complete, explicit statement about a model's top-level
    // secrets, so it also satisfies any `@Secret` marker on those same fields.
    claimPendingFields(keys);
    return { spec: schema, keys } as SecretSchema<T, S>;
  };
}

/* -------------------------------------------------------------------------- */
/*                        Type-level public projection                        */
/* -------------------------------------------------------------------------- */

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/** `true` when `T` is a `secret()` box. */
export type IsSecret<T> = T extends SecretBox<unknown> ? true : false;

/**
 * Phantom brand carried by a `@Secret` field's *declared type*.
 *
 * `@Secret` runs at runtime, so it can strip the value on the wire but it
 * cannot change the field's type — a field decorator has no way to rewrite the
 * property it decorates. Without a brand in the type, `Public<T>` had no way to
 * know which keys were secret, and the public projection kept them: the client
 * type said `out.apiKey` existed while the server never sent it. That is the
 * worst kind of bug, because it type-checks and then reads `undefined`.
 *
 * The brand property is optional, so `Secret<string>` still accepts a plain
 * string and the ergonomics cost is the annotation alone.
 */
export const SECRET_FIELD: unique symbol = Symbol.for("navi.secret.field");

/** Marks a value as secret for the type-level projection. See {@link SECRET_FIELD}. */
export type Secret<V> = V & { readonly [SECRET_FIELD]?: true };

/** `true` when `T` carries the {@link SECRET_FIELD} brand. */
export type IsSecretField<T> = typeof SECRET_FIELD extends keyof T ? true : false;

/**
 * The type a client is allowed to observe. Secret boxes vanish, branded
 * (`Secret<...>`) and declared (`S`) secret keys are removed, methods are
 * dropped (they cannot cross the wire), and everything else is walked
 * structurally.
 *
 * Both routes to secrecy are honoured: a `Secret<V>` brand, which is what
 * `@Secret` asks for, and an explicit key list, which is what
 * `defineSecretSchema` produces. Either one is enough on its own.
 */
export type Public<T, S extends PropertyKey = never> = T extends SecretBox<unknown>
  ? never
  : T extends Primitive
    ? T
    : T extends Date
      ? Date
      : T extends URL
        ? string
        : T extends (...args: never[]) => unknown
          ? never
          : T extends ReadonlyArray<infer E>
            ? ReadonlyArray<Public<E>>
            : T extends ArrayBuffer
              ? ArrayBuffer
              : T extends object
                ? {
                    readonly [K in keyof T as K extends S
                      ? never
                      : IsSecretField<T[K]> extends true
                        ? never
                        : K]: T[K] extends (...args: never[]) => unknown
                          ? never
                          : Public<T[K]>;
                  }
                : T;

/** Schema-aware variant: honors nested `SecretSchemaSpec` records and brands. */
export type PublicBySchema<T, S> = T extends Primitive
  ? T
  : T extends ReadonlyArray<infer E>
    ? ReadonlyArray<S extends object ? PublicBySchema<E, S> : Public<E>>
    : T extends object
      ? {
          readonly [K in keyof T as K extends keyof S
            ? S[K] extends "secret"
              ? never
              : K
            : IsSecretField<T[K]> extends true
              ? never
              : K]: K extends keyof S
            ? S[K] extends "public" | "secret"
              ? T[K]
              : S[K] extends object
                ? PublicBySchema<T[K], S[K]>
                : T[K]
            : Public<T[K]>;
        }
      : T;

/* -------------------------------------------------------------------------- */
/*                                 Projection                                  */
/* -------------------------------------------------------------------------- */

export interface ProjectionResult {
  readonly clean: unknown;
  /** Dotted paths of every stripped field, e.g. `variants[0].wholesaleCost`. */
  readonly stripped: readonly string[];
}

export interface ProjectOptions {
  readonly schema?: RuntimeSecretSchema | undefined;
  readonly modelKeys?: ReadonlySet<string | symbol> | undefined;
  readonly maxDepth?: number | undefined;
}

const DEFAULT_MAX_DEPTH = 10;

/** Values JSON already handles (or already mangles) — never walked. */
function isPassthrough(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof URL ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Error
  );
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}

interface WalkState {
  readonly stripped: string[];
  readonly seen: Set<object>;
  readonly maxDepth: number;
}

/** Per-level schema, threaded down the tree. */
type SchemaLevel = RuntimeSecretSchema | undefined;

function childSchema(schema: SchemaLevel, key: string): SchemaLevel {
  if (schema === undefined) return undefined;
  const next = schema[key];
  return typeof next === "object" && next !== null ? (next as RuntimeSecretSchema) : undefined;
}

function note(state: WalkState, path: string): void {
  state.stripped.push(path);
}

function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * Recursively removes secrets from an arbitrary value.
 *
 * Cost notes (this runs on every cache-miss response):
 *  - plain objects take the `Object.entries` fast path;
 *  - class instances take a descriptor walk so declared secrets are never even
 *    *read* — a secret getter cannot leak by being invoked during projection;
 *  - `toJSON()` is honoured, matching `JSON.stringify`;
 *  - cycles, over-deep trees, functions and symbols are dropped, never thrown.
 */
export function project<T>(
  input: T,
  options?: ProjectOptions,
): ProjectionResult {
  const state: WalkState = {
    stripped: [],
    seen: new Set<object>(),
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  const clean = walk(
    input,
    options?.modelKeys ?? null,
    options?.schema,
    "",
    0,
    state,
  );
  return { clean, stripped: state.stripped };
}

function walk(
  value: unknown,
  modelKeys: ReadonlySet<string | symbol> | null,
  schema: SchemaLevel,
  path: string,
  depth: number,
  state: WalkState,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isSecretBox(value)) {
    note(state, path === "" ? "secret" : path);
    return undefined;
  }
  if (depth >= state.maxDepth) return undefined;
  if (state.seen.has(value)) return undefined; // cycle guard
  if (isPassthrough(value)) return value;

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = new Array(value.length);
      const itemSchema = schema; // an array schema describes its elements
      for (let i = 0; i < value.length; i++) {
        const item = walk(value[i], null, itemSchema, `${path}[${i}]`, depth + 1, state);
        out[i] = item === undefined ? null : item;
      }
      return out;
    }

    if (value instanceof Map) {
      return projectEntries([...value.entries()], false, path, depth, state);
    }
    if (value instanceof Set) {
      return projectEntries([...value.values()], true, path, depth, state);
    }

    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function" && !isPlainObject(value)) {
      return walk(toJSON.call(value), null, schema, path, depth + 1, state);
    }

    return isPlainObject(value)
      ? projectPlain(value, schema, path, depth, state)
      : projectInstance(value, modelKeys, schema, path, depth, state);
  } finally {
    state.seen.delete(value);
  }
}

function projectPlain(
  obj: object,
  schema: SchemaLevel,
  path: string,
  depth: number,
  state: WalkState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(obj);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as [string, unknown];
    const key = entry[0];
    const fieldPath = childPath(path, key);

    if (schema !== undefined && schema[key] === "secret") {
      note(state, fieldPath);
      continue;
    }
    if (isSecretBox(entry[1])) {
      note(state, fieldPath);
      continue;
    }

    out[key] = walk(entry[1], null, childSchema(schema, key), fieldPath, depth + 1, state);
  }
  return out;
}

function projectInstance(
  obj: object,
  modelKeys: ReadonlySet<string | symbol> | null,
  schema: SchemaLevel,
  path: string,
  depth: number,
  state: WalkState,
): Record<string, unknown> {
  const secrets = modelKeys ?? getSecretKeys(obj);
  const out: Record<string, unknown> = {};

  // Declared secrets are recorded without being read.
  for (const key of secrets) note(state, childPath(path, String(key)));

  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (secrets.has(key)) continue;
    const fieldPath = childPath(path, key);
    if (schema !== undefined && schema[key] === "secret") {
      note(state, fieldPath);
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor === undefined) continue;

    if (descriptor.get !== undefined) {
      let value: unknown;
      try {
        value = descriptor.get.call(obj);
      } catch {
        continue; // a throwing getter must not fail the whole response
      }
      if (isSecretBox(value)) {
        note(state, fieldPath);
        continue;
      }
      out[key] = walk(value, null, childSchema(schema, key), fieldPath, depth + 1, state);
      continue;
    }

    const value = descriptor.value;
    if (value === SECRET_SYMBOL || isSecretBox(value)) {
      note(state, fieldPath);
      continue;
    }
    out[key] = walk(value, null, childSchema(schema, key), fieldPath, depth + 1, state);
  }
  return out;
}

function projectEntries(
  entries: readonly unknown[],
  isSet: boolean,
  path: string,
  depth: number,
  state: WalkState,
): unknown {
  if (isSet) {
    const out = new Set<unknown>();
    for (let i = 0; i < entries.length; i++) {
      const projected = walk(entries[i], null, undefined, `${path}[${i}]`, depth + 1, state);
      if (projected !== undefined) out.add(projected);
    }
    return out;
  }
  const out = new Map<unknown, unknown>();
  for (let i = 0; i < entries.length; i++) {
    const pair = entries[i] as readonly [unknown, unknown];
    const key = walk(pair[0], null, undefined, `${path}.key(${i})`, depth + 1, state);
    if (key === undefined) continue;
    out.set(key, walk(pair[1], null, undefined, `${path}.value(${i})`, depth + 1, state));
  }
  return out;
}

/**
 * Object-oriented wrapper. Kept because it reads better in handler code and
 * because it mirrors the framework's original published surface.
 */
export class SecretProjector {
  static project<T>(input: T, options?: ProjectOptions): ProjectionResult {
    return project(input, options);
  }
}
