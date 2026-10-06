// Error code registry — the single source of truth for HTTP status and the
// translation key shown to users (messages/{locale}.json → errors.<code>).
// Pure module: safe to import from client code for typing.

export const ERROR_CODES = {
  VALIDATION_FAILED: { httpStatus: 400 },
  UNAUTHENTICATED: { httpStatus: 401 },
  FORBIDDEN: { httpStatus: 403 },
  NOT_FOUND: { httpStatus: 404 },
  CONFLICT: { httpStatus: 409 },
  PAYLOAD_TOO_LARGE: { httpStatus: 413 },
  UNSUPPORTED_MEDIA_TYPE: { httpStatus: 415 },
  RATE_LIMITED: { httpStatus: 429 },
  TENANT_SCOPE_MISSING: { httpStatus: 500 },
  INTERNAL: { httpStatus: 500 },
  SERVICE_UNAVAILABLE: { httpStatus: 503 },
} as const satisfies Record<string, { httpStatus: number }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[];

/** Codes whose details must never be shown to clients (programming / infra errors). */
export const INTERNAL_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "TENANT_SCOPE_MISSING",
  "INTERNAL",
]);

export function errorMessageKey(code: ErrorCode): `errors.${ErrorCode}` {
  return `errors.${code}`;
}
