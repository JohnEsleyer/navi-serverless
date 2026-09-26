/**
 * Navi Serverless — an opinionated, strictly TypeScript edge framework for V8
 * runtimes.
 *
 * Everything the engine exposes is re-exported here except the client runtime,
 * which lives behind `navi-serverless/client` so a browser bundle never pulls
 * in server code.
 */

export { NaviServerless } from "./server.js";
export type {
  ActionRegistration,
  CorsOptions,
  NaviMetrics,
  NaviOptions,
  PublicOutput,
  ActionSchemaInput,
} from "./server.js";

export {
  EdgeL2Cache,
  IsolateL1Cache,
  Singleflight,
  deriveCacheKey,
  type EdgeCache,
  type EdgeCacheStorage,
  type L1Entry,
  type L1Lookup,
  type L2Options,
} from "./cache.js";

export {
  SECRET_FIELD,
  SECRET_SYMBOL,
  Secret,
  SecretFields,
  SecretModel,
  SecretProjector,
  defineSecretSchema,
  getSecretKeys,
  isSecretBox,
  project,
  registerSecretKeys,
  secret,
  unclaimedSecretFields,
  unwrapSecret,
  type DirectSecretKeys,
  type IsSecret,
  type IsSecretField,
  type ProjectOptions,
  type ProjectionResult,
  type Public,
  type PublicBySchema,
  type RuntimeSecretSchema,
  type SecretBox,
  type SecretSchema,
  type SecretSchemaSpec,
} from "./security.js";

export {
  RateLimiter,
  allOf,
  allowAccess,
  anyOf,
  bearerVerifier,
  requireRole,
  signToken,
  verifyToken,
  type RateLimitOptions,
  type TokenClaims,
  type TokenResult,
  type TokenVerifier,
  type VerifyOptions,
} from "./policies.js";

export { NaviError, NaviValidationError, toActionError } from "./errors.js";

export { fnv1a64, stableStringify, fastHash } from "./internal/canonical.js";

export type {
  AccessRule,
  ActionDefinition,
  ActionEnvelope,
  ActionError,
  ActionInput,
  ActionMap,
  ActionName,
  ActionOutput,
  ActionPublic,
  ActionSpec,
  BatchEntry,
  BatchRequestPayload,
  CacheOptions,
  CacheScope,
  CacheTier,
  ClientTier,
  HttpMethod,
  NaviErrorCode,
  RegistryOf,
  RequestContext,
  Role,
  SecurityPolicy,
  WaitUntil,
} from "./types.js";
