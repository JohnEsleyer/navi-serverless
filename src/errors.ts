import type { ActionError, NaviErrorCode } from "./types.js";

/**
 * Errors thrown inside handlers are normalized into `{ ok: false }` envelopes.
 * `NaviError` is the escape hatch for handlers that want a specific code/tip.
 */
export class NaviError extends Error {
  override readonly name: string = "NaviError";
  readonly code: NaviErrorCode;
  readonly tip: string | undefined;
  readonly status: number;

  constructor(code: NaviErrorCode, message: string, options?: { tip?: string; status?: number }) {
    super(message);
    this.code = code;
    this.tip = options?.tip;
    this.status = options?.status ?? defaultStatusFor(code);
  }

  toEnvelope(): ActionError {
    return this.tip === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, tip: this.tip };
  }
}

export function defaultStatusFor(code: NaviErrorCode): number {
  switch (code) {
    case "MALFORMED_JSON":
    case "VALIDATION_ERROR":
      return 400;
    case "TOKEN_MISSING":
    case "TOKEN_INVALID":
    case "TOKEN_EXPIRED":
    case "UNAUTHORIZED":
    case "POLICY_VIOLATION":
      return 403;
    case "ACTION_NOT_FOUND":
    case "NOT_FOUND":
      return 404;
    case "METHOD_NOT_ALLOWED":
      return 405;
    case "RATE_LIMITED":
      return 429;
    case "BATCH_TOO_LARGE":
      return 413;
    case "EXECUTION_ERROR":
    case "INTERNAL":
      return 500;
    default:
      return 500;
  }
}

export function toActionError(err: unknown): ActionError {
  // A `NaviError` is the author saying "this message is safe to show".
  if (err instanceof NaviError) return err.toEnvelope();
  // Anything else is a bug or a failed dependency, and its message routinely
  // carries connection strings, SQL, or file paths. Report it through
  // `onError` and tell the client only that it failed.
  if (typeof err === "string" && err.length > 0 && err.length <= 120) {
    // A thrown string is a deliberate, already-sanitized message.
    return { code: "EXECUTION_ERROR", message: err };
  }
  return { code: "EXECUTION_ERROR", message: "The action failed. Check server logs for details." };
}

export class NaviValidationError extends NaviError {
  override readonly name = "NaviValidationError";
  constructor(message: string, tip?: string) {
    super("VALIDATION_ERROR", message, tip === undefined ? undefined : { tip });
  }
}
