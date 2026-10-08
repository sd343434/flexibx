// Secret redaction for logs and audit metadata. Pure and dependency-free.

export const REDACTED = "[REDACTED]";

/**
 * Keys whose values are always secret (case-insensitive). `token` only matches as a
 * suffix (`accessToken`, `refresh_token`) so usage counters like `inputTokens` or
 * `tokenUsage` stay visible for AI cost tracking.
 */
const SECRET_KEY_PATTERN =
  /pass(word|wd|phrase)?|secret|token$|authorization|cookie|api[-_]?key|private[-_]?key|credential|database[-_]?url|connection[-_]?string|signature|encryption[-_]?key/i;

/** `scheme://user:password@host` → `scheme://user:[REDACTED]@host` */
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]+):([^@/\s]+)@/gi;

/** `Bearer abc…` → `Bearer [REDACTED]` */
const BEARER_PATTERN = /\b(bearer)\s+[a-z0-9._~+/=-]+/gi;

/**
 * Any URL that can carry a one-time invitation token: the invite page itself
 * (`/ar/invite/<token>`) and pages whose `next` parameter points at it
 * (`/ar/sign-in?next=%2Far%2Finvite%2F<token>`). next.config.ts uses this to keep such
 * URLs out of the development request log.
 */
export const INVITATION_URL_PATTERN = /(?:\/|%2F)invite(?:\/|%2F)/i;

/** `/ar/invite/<one-time token>` → `/ar/invite/[REDACTED]`, also URL-encoded. */
const INVITE_TOKEN_PATTERN = /((?:\/|%2F)invite(?:\/|%2F))[A-Za-z0-9_-]+/gi;

const MAX_DEPTH = 8;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactString(value: string): string {
  return value
    .replace(URL_CREDENTIALS_PATTERN, `$1:${REDACTED}@`)
    .replace(BEARER_PATTERN, `$1 ${REDACTED}`)
    .replace(INVITE_TOKEN_PATTERN, `$1${REDACTED}`);
}

/** Returns a deep copy with secret-looking keys and embedded credentials redacted. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (value instanceof Date) return value;

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? REDACTED : redactSecrets(entry, depth + 1);
  }
  return output;
}
