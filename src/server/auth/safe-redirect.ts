import { isLocale, type Locale } from "@/i18n/config";

// Pure helper (no `server-only`): validates a user-supplied `next` value before any
// redirect after sign-in. Only internal, locale-prefixed paths are ever returned.

const PLACEHOLDER_ORIGIN = "http://flexibx.invalid";
const MAX_NEXT_LENGTH = 512;
// Backslashes (browsers treat `/\host` as `//host`) and control characters.
// eslint-disable-next-line no-control-regex -- intentionally rejects control characters
const UNSAFE_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/**
 * Returns `value` as an internal path (`/{locale}/…` with optional query and hash) when
 * it is safe to redirect to; otherwise `/{fallbackLocale}`. Rejects absolute and
 * protocol-relative URLs, backslash tricks, control characters, paths outside the
 * locale-prefixed app and anything that resolves to another origin.
 */
export function safeNextPath(value: unknown, fallbackLocale: Locale): string {
  const fallback = `/${fallbackLocale}`;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NEXT_LENGTH) {
    return fallback;
  }
  if (!value.startsWith("/") || value.startsWith("//") || UNSAFE_CHARACTERS.test(value)) {
    return fallback;
  }

  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN || url.pathname.includes("//")) return fallback;

  const firstSegment = url.pathname.split("/")[1];
  if (!isLocale(firstSegment)) return fallback;

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Where to go after signing in: the sanitized `next` path when one was given and is
 * safe, otherwise the workspace landing page `/{locale}/workspaces`.
 */
export function postSignInPath(next: unknown, locale: Locale): string {
  const fallback = `/${locale}/workspaces`;
  const safe = safeNextPath(next, locale);
  return safe === `/${locale}` && next !== safe ? fallback : safe;
}

/** The sign-in page for `locale`, carrying an internal `next` path to return to. */
export function signInPath(locale: Locale, next?: string): string {
  const base = `/${locale}/sign-in`;
  if (next === undefined) return base;
  const safe = safeNextPath(next, locale);
  return safe === next ? `${base}?next=${encodeURIComponent(safe)}` : base;
}
