import { APIError } from "better-auth/api";
import { z } from "zod";

import type { Locale } from "@/i18n/config";

import { AppError } from "../errors/app-error";
import { parseInput } from "../validation/parse";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type Auth } from "./auth-config";
import type { RateLimiter } from "./rate-limit";
import { ENUMERATION_SAFE_MIN_DURATION_MS, withMinimumDuration } from "./timing";

// Email verification, password reset and password change — Flexibx's only entry points
// for them (their Better Auth HTTP endpoints are disabled). Pure (no `server-only`), so
// integration tests drive the exact production code with a real Better Auth instance.
//
// Every function passes the rate-limit checkpoint before doing any work, and every
// response that could reveal whether an account exists is the same for all inputs
// (decision 9). Better Auth's error codes and texts never leave this module.

export interface AccountSecurityDeps {
  readonly auth: Auth;
  readonly limit: RateLimiter;
  /** Headers of the incoming request (client-IP header, session cookie). */
  readonly headers: Headers;
}

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** Better Auth reset tokens: 24 random alphanumeric characters (~143 bits). */
export const RESET_TOKEN_PATTERN = /^[A-Za-z0-9]{24}$/;
/** Better Auth email-verification tokens: compact JWS (three base64url parts). */
export const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_VERIFICATION_TOKEN_LENGTH = 2048;

export const emailRequestInputSchema = z.object({ email: emailSchema });
export const resetPasswordInputSchema = z.object({
  token: z.string(),
  newPassword: newPasswordSchema,
});
export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});

/** Same answer whether or not an account exists: "if it exists, we sent an email". */
export interface Accepted {
  readonly status: "ACCEPTED";
}

const ACCEPTED: Accepted = { status: "ACCEPTED" };

function isClientError(error: unknown): boolean {
  return error instanceof APIError && error.statusCode >= 400 && error.statusCode < 500;
}

/**
 * The email claimed by a verification token, WITHOUT checking its signature — only to
 * look up the account's current state. Better Auth verifies signature and expiry
 * afterwards; a forged token never gets that far.
 */
export function unverifiedTokenEmail(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof claims !== "object" || claims === null) return null;
    const { email, updateTo } = claims as { email?: unknown; updateTo?: unknown };
    // Email-change tokens are not part of Phase 2 and are never accepted here.
    if (updateTo !== undefined) return null;
    return typeof email === "string" ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Sends a new verification link if — and only if — an unverified account uses this
 * email. Always ACCEPTED (Better Auth also pads this path to a minimum duration).
 */
export async function resendVerificationEmail(
  deps: AccountSecurityDeps,
  input: { readonly email: unknown },
  locale: Locale,
): Promise<Accepted> {
  await deps.limit({ bucket: "verification-resend", requestHeaders: deps.headers });
  const { email } = parseInput(emailRequestInputSchema, { email: input.email }, "verification");
  await deps.limit({
    bucket: "verification-resend-account",
    requestHeaders: deps.headers,
    subject: email,
  });
  try {
    // No headers: always Better Auth's generic, session-less path.
    await deps.auth.api.sendVerificationEmail({ body: { email, callbackURL: `/${locale}` } });
  } catch (error) {
    if (!isClientError(error)) throw error;
  }
  return ACCEPTED;
}

/**
 * Verifies an email address with a link token. A token works once: it is accepted only
 * while its account is still unverified, so a replayed, already-used, expired, forged or
 * malformed token — and one for an unknown account — all get the same INVALID_TOKEN.
 */
export async function verifyEmailToken(
  deps: AccountSecurityDeps,
  input: { readonly token: unknown },
): Promise<{ readonly status: "VERIFIED" | "INVALID_TOKEN" }> {
  await deps.limit({ bucket: "verify-email", requestHeaders: deps.headers });
  const token = input.token;
  if (
    typeof token !== "string" ||
    token.length > MAX_VERIFICATION_TOKEN_LENGTH ||
    !VERIFICATION_TOKEN_PATTERN.test(token)
  ) {
    return { status: "INVALID_TOKEN" };
  }
  const email = unverifiedTokenEmail(token);
  if (email === null) return { status: "INVALID_TOKEN" };
  const context = await deps.auth.$context;
  const account = await context.internalAdapter.findUserByEmail(email);
  if (account === null || account.user.emailVerified) return { status: "INVALID_TOKEN" };

  try {
    await deps.auth.api.verifyEmail({ query: { token } });
  } catch (error) {
    if (isClientError(error)) return { status: "INVALID_TOKEN" };
    throw error;
  }
  return { status: "VERIFIED" };
}

/**
 * Starts a password reset. Always ACCEPTED, after at least
 * ENUMERATION_SAFE_MIN_DURATION_MS; an email goes out only for an account.
 */
export async function requestPasswordReset(
  deps: AccountSecurityDeps,
  input: { readonly email: unknown },
  locale: Locale,
): Promise<Accepted> {
  await deps.limit({ bucket: "password-reset-request", requestHeaders: deps.headers });
  const { email } = parseInput(emailRequestInputSchema, { email: input.email }, "password-reset");
  await deps.limit({
    bucket: "password-reset-request-account",
    requestHeaders: deps.headers,
    subject: email,
  });
  return withMinimumDuration(ENUMERATION_SAFE_MIN_DURATION_MS, async () => {
    try {
      await deps.auth.api.requestPasswordReset({ body: { email, redirectTo: `/${locale}` } });
    } catch (error) {
      if (!isClientError(error)) throw error;
    }
    return ACCEPTED;
  });
}

/**
 * Sets a new password with a reset token. The token is consumed atomically (single use);
 * the new password is hashed by Better Auth (scrypt) and every session of the account
 * is deleted (`revokeSessionsOnPasswordReset`). Unknown, used, expired and malformed
 * tokens are the same INVALID_TOKEN.
 */
export async function resetPasswordWithToken(
  deps: AccountSecurityDeps,
  input: { readonly token: unknown; readonly newPassword: unknown },
): Promise<{ readonly status: "RESET" | "INVALID_TOKEN" }> {
  await deps.limit({ bucket: "password-reset", requestHeaders: deps.headers });
  const { token, newPassword } = parseInput(resetPasswordInputSchema, input, "password-reset");
  if (!RESET_TOKEN_PATTERN.test(token)) return { status: "INVALID_TOKEN" };
  try {
    await deps.auth.api.resetPassword({ body: { token, newPassword } });
  } catch (error) {
    if (isClientError(error)) return { status: "INVALID_TOKEN" };
    throw error;
  }
  return { status: "RESET" };
}

/**
 * Changes the signed-in user's password (current password required). Every other
 * session of the account is deleted (decision C7); the current one is replaced and its
 * cookie rewritten by Better Auth (nextCookies).
 */
export async function changePassword(
  deps: AccountSecurityDeps,
  userId: string,
  input: { readonly currentPassword: unknown; readonly newPassword: unknown },
): Promise<{ readonly status: "CHANGED" | "INVALID_PASSWORD" }> {
  await deps.limit({ bucket: "change-password", requestHeaders: deps.headers, subject: userId });
  const body = parseInput(changePasswordInputSchema, input, "change-password");
  try {
    await deps.auth.api.changePassword({
      body: { ...body, revokeOtherSessions: true },
      headers: deps.headers,
    });
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 401) {
      throw new AppError("UNAUTHENTICATED");
    }
    if (isClientError(error)) return { status: "INVALID_PASSWORD" };
    throw error;
  }
  return { status: "CHANGED" };
}
