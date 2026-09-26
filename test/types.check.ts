/**
 * Type-level regression tests.
 *
 * `bun test` does not pick this file up (its name is not `*.test.ts`); it is
 * checked by `tsc` as part of `bun run typecheck`. Every assertion here is a
 * compile-time one, so a regression fails the typecheck rather than a test run.
 *
 * The bug these exist to prevent: `Public<T>` used to drop only keys named in an
 * explicit schema, and the schema branch never matched in practice, so a secret
 * field stayed in the public type. The client type promised `out.apiKey` while
 * the server never sent it — code that type-checked and then read `undefined`.
 * That is why these assertions use `@ts-expect-error`: a *missing* error there
 * is itself the failure.
 */

import { NaviServerless } from "../src/index.js";
import { Secret, SecretModel, defineSecretSchema } from "../src/index.js";
import type { IsSecretField, Public, SecretBox } from "../src/security.js";
import { NaviClient } from "../src/client/index.js";

/* ------------------------------- primitives ------------------------------- */

// The brand is a `unique symbol` property, so detection must key off presence,
// not assignability — every type satisfies an all-optional object.
type _DetectString = IsSecretField<string> extends false ? true : never;
type _DetectNumber = IsSecretField<number> extends false ? true : never;
type _DetectBranded = IsSecretField<Secret<string>> extends true ? true : never;
type _DetectNested = IsSecretField<Secret<Secret<number>>> extends true ? true : never;
type _DetectBox = IsSecretField<SecretBox<string>> extends false ? true : never;
const detects: [_DetectString, _DetectNumber, _DetectBranded, _DetectNested, _DetectBox] = [
  true,
  true,
  true,
  true,
  true,
];

/* ---------------------------- decorator branding --------------------------- */

@SecretModel
class Nested {
  keep!: string;
  @Secret drop!: Secret<string>;
  constructor() {
    this.keep = "y";
    this.drop = "z";
  }
}

@SecretModel
class Branded {
  id!: string;
  count!: number;
  @Secret apiKey!: Secret<string>;
  @Secret cost!: Secret<number>;
  nested!: Nested;

  constructor() {
    this.id = "a";
    this.count = 1;
    // Ergonomics: the brand is optional, so a plain value still assigns.
    this.apiKey = "sk-live-123";
    this.cost = 42;
    this.nested = new Nested();
  }
}

type BrandedPublic = Public<Branded>;
const brandedSurface: BrandedPublic = { id: "a", count: 1, nested: { keep: "y" } };
// @ts-expect-error apiKey is secret and must not appear on the public type
const brandedApiKey: BrandedPublic["apiKey"] = "sk-live-123";
// @ts-expect-error cost is secret too
const brandedCost: BrandedPublic["cost"] = 42;
// @ts-expect-error nested.drop is secret
const nestedDrop: BrandedPublic["nested"]["drop"] = "z";
const nestedKeep: string | undefined = brandedSurface.nested.keep;

/* ----------------------------- end-to-end types ---------------------------- */

@SecretModel
class DecoratedOnly {
  views!: number;
  @Secret token!: Secret<string>;
  constructor() {
    this.views = 7;
    this.token = "t";
  }
}

const viaBrand = new NaviServerless().registerAction({
  name: "getStats",
  cache: { ttl: 60, swr: 600, scope: "public" },
  handler: async (): Promise<DecoratedOnly> => new DecoratedOnly(),
});

const brandResult = await new NaviClient<typeof viaBrand>({ endpoint: "/_navi/action" }).call("getStats");
const brandViews: number = brandResult.views;
// @ts-expect-error the whole point: the secret is absent from the client type
const brandToken = brandResult.token;

@SecretModel
class SchemaOnly {
  views!: number;
  cardLast4!: string;
  constructor() {
    this.views = 3;
    this.cardLast4 = "4242";
  }
}

const viaSchema = new NaviServerless().registerAction({
  name: "getOrder",
  schema: defineSecretSchema<SchemaOnly>()({ cardLast4: "secret" }),
  handler: async (): Promise<SchemaOnly> => new SchemaOnly(),
});

const schemaResult = await new NaviClient<typeof viaSchema>({ endpoint: "/_navi/action" }).call("getOrder");
const schemaViews: number = schemaResult.views;
// @ts-expect-error the schema route must strip as well
const schemaCard = schemaResult.cardLast4;

const nonEmpty = [detects, brandedSurface, brandedApiKey, brandedCost, nestedDrop, nestedKeep] as const;
const alsoNonEmpty = [brandViews, brandToken, schemaViews, schemaCard] as const;
export { alsoNonEmpty, nonEmpty };
