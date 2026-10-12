import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { Locale } from "@/i18n/config";

import { AppError } from "../errors/app-error";
import { isUuid } from "../tenancy/context";

import { getAuth } from "./auth";
import type { Auth } from "./auth-config";
import { signInPath } from "./safe-redirect";

/**
 * The signed-in user as application code sees it. Deliberately small: no session
 * token, no session row and no Better Auth types leak past the auth boundary, and
 * `isPlatformAdmin` is not exposed until a feature needs it.
 */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly image: string | null;
  readonly locale: "ar" | "en";
  readonly emailVerified: boolean;
}

/**
 * The current session's security facts, for checks that need more than the user (the
 * platform-admin gate). Never carries the session token.
 */
export interface AuthSession {
  readonly user: AuthUser;
  /** When this session passed a second factor; null when it did not. */
  readonly mfaVerifiedAt: Date | null;
}

/**
 * Resolves the session from the request's signed session cookie through Better Auth's
 * own `getSession` (database lookup, expiry and rolling refresh included), or null.
 * Exported for tests; application code uses `getCurrentSession`.
 */
export async function resolveCurrentSession(
  auth: Auth,
  requestHeaders: Headers,
): Promise<AuthSession | null> {
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (result === null) return null;
  const { user, session } = result;
  if (!isUuid(user.id)) return null;
  const marker: unknown = session.mfaVerifiedAt;
  return Object.freeze({
    user: Object.freeze({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image ?? null,
      locale: user.locale === "en" ? ("en" as const) : ("ar" as const),
      emailVerified: user.emailVerified,
    }),
    mfaVerifiedAt: marker instanceof Date ? marker : null,
  });
}

/**
 * Resolves the user from the request's signed session cookie through Better Auth's
 * own `getSession` (database lookup, expiry and 7-day rolling refresh included).
 * Returns null when there is no valid session. An unverified account is a signed-in
 * user like any other (decision C1); operations that need a verified address check
 * `emailVerified` themselves (`requireVerifiedEmail`, decision C6).
 * Exported for tests; application code uses `getCurrentUser` / `requireUser`.
 */
export async function resolveCurrentUser(
  auth: Auth,
  requestHeaders: Headers,
): Promise<AuthUser | null> {
  return (await resolveCurrentSession(auth, requestHeaders))?.user ?? null;
}

/**
 * The current request's user, or null. Resolved once per server request (React `cache`
 * deduplicates within a single render; it is not a cross-request session cache).
 */
export const getCurrentSession = cache(async (): Promise<AuthSession | null> =>
  resolveCurrentSession(getAuth(), await headers()),
);

/** The current request's user, or null (same per-request resolution). */
export const getCurrentUser = cache(
  async (): Promise<AuthUser | null> => (await getCurrentSession())?.user ?? null,
);

/** The current request's user; throws UNAUTHENTICATED (401) when there is none. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (user === null) throw new AppError("UNAUTHENTICATED");
  return user;
}

/**
 * For protected pages: the current user, or a redirect to the sign-in page that returns
 * to `path` (an internal `/{locale}/…` path) afterwards.
 */
export async function requirePageUser(locale: Locale, path: string): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (user === null) redirect(signInPath(locale, path));
  return user;
}
