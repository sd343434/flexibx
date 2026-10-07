import { AUTH_COOKIE_PREFIX, type Auth } from "./auth-config";

// Pure (no `server-only`): used by the proxy and by tests.
//
// Why this exists: pages are rendered by Server Components, which cannot write cookies.
// Rolling a session therefore has to happen somewhere that can — the proxy, which runs
// for every page request before rendering. It asks Better Auth's own `get-session`
// endpoint (in-process, no HTTP) and forwards only the session cookie it sets. The proxy
// still makes no authorization decision: pages and handlers check access themselves.

const SESSION_COOKIE_NAMES = [
  `${AUTH_COOKIE_PREFIX}.session_token`,
  `__Secure-${AUTH_COOKIE_PREFIX}.session_token`,
];

function cookieName(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf("=")).trim();
}

/** True when the Cookie header carries a Flexibx session cookie (name check only). */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (cookieHeader === null) return false;
  return cookieHeader
    .split(";")
    .some((part) => SESSION_COOKIE_NAMES.includes(part.slice(0, part.indexOf("=")).trim()));
}

/**
 * Returns the `Set-Cookie` values Better Auth produces for this request's session:
 * a renewed session cookie once the session has rolled (at most once per day), a
 * clearing cookie for an expired or revoked session, and nothing otherwise. Only the
 * Cookie header is forwarded; only Flexibx session cookies are returned.
 */
export async function refreshSessionCookies(
  auth: Auth,
  cookieHeader: string | null,
  baseURL: string,
): Promise<string[]> {
  if (!hasSessionCookie(cookieHeader)) return [];
  const response = await auth.handler(
    new Request(new URL("/api/auth/get-session", baseURL), {
      headers: { cookie: cookieHeader ?? "" },
    }),
  );
  return response.headers
    .getSetCookie()
    .filter((setCookie) => SESSION_COOKIE_NAMES.includes(cookieName(setCookie)));
}
