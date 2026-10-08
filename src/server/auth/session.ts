import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { Locale } from "@/i18n/config";

import { AppError } from "../errors/app-error";
import { isUuid } from "../tenancy/context";

import { getAuth, isEmailVerificationRequired } from "./auth";
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
 * Resolves the user from the request's signed session cookie through Better Auth's
 * own `getSession` (database lookup, expiry and 7-day rolling refresh included).
 * Returns null when there is no valid session — and, when email verification is
 * required (decision C6), for an unverified account: every page, action and route that
 * needs a user therefore needs a verified one. Sign-in already refuses unverified
 * accounts; this also covers sessions created before the policy applied.
 * Exported for tests; application code uses `getCurrentUser` / `requireUser`.
 */
export async function resolveCurrentUser(
  auth: Auth,
  requestHeaders: Headers,
  options: { readonly requireEmailVerification: boolean },
): Promise<AuthUser | null> {
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (result === null) return null;
  const { user } = result;
  if (!isUuid(user.id)) return null;
  if (options.requireEmailVerification && !user.emailVerified) return null;
  return Object.freeze({
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
    locale: user.locale === "en" ? "en" : "ar",
    emailVerified: user.emailVerified,
  });
}

/**
 * The current request's user, or null. Resolved once per server request (React `cache`
 * deduplicates within a single render; it is not a cross-request session cache).
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> =>
  resolveCurrentUser(getAuth(), await headers(), {
    requireEmailVerification: isEmailVerificationRequired(),
  }),
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
