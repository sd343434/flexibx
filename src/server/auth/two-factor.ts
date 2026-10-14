import { APIError } from "better-auth/api";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";

import { AppError } from "../errors/app-error";

import type { Auth } from "./auth-config";
import type { RateLimiter } from "./rate-limit";
import { claimTotpCode } from "./totp-replay";

export { claimTotpCode, USED_TOTP_CODE_TTL_MS } from "./totp-replay";

// Two-factor authentication (TOTP + single-use backup codes) through Better Auth's
// two-factor plugin. These functions are Flexibx's only entry points: the plugin's HTTP
// endpoints are disabled (DISABLED_HTTP_PATHS). Pure (no `server-only`), so integration
// tests drive the exact production code against a real Better Auth instance.
//
// - Sign-in: a correct password for an account with two-factor creates NO session; it
//   leaves a signed, 10-minute challenge cookie. `verifySignInChallenge` turns it into a
//   session (5 attempts per challenge, 10 consecutive failures lock the factor for 15
//   minutes — Better Auth). That session carries `mfaVerifiedAt` (auth-config.ts). Each
//   TOTP code is accepted once: the code is claimed (totp-replay.ts) inside the session
//   creation itself (auth-config.ts, `session.create.before`), BEFORE the session row and
//   cookie exist — a replay or a database error leaves no session behind.
// - Enrollment: password → secret + backup codes shown once → first valid code enables
//   two-factor and replaces the session with one that carries `mfaVerifiedAt`.
// - Disable / regenerate backup codes: password required; disabling clears the marker
//   from every session of the account, so no older session keeps admin access.
// Secrets, codes and Better Auth error texts never reach logs or audit metadata.

export interface TwoFactorDeps {
  readonly auth: Auth;
  /** System client: sessions and two_factors are global auth tables. */
  readonly db: PrismaClient;
  readonly limit: RateLimiter;
  /** Headers of the incoming request (client-IP header, session or challenge cookie). */
  readonly headers: Headers;
}

const TOTP_CODE = /^\d{6}$/;
const BACKUP_CODE = /^([A-Za-z0-9]{5})-?([A-Za-z0-9]{5})$/;

const challengeInputSchema = z.object({
  method: z.enum(["totp", "backup"]),
  code: z.string().max(64),
});
const passwordInputSchema = z.object({ password: z.string().min(1).max(128) });
const codeInputSchema = z.object({ code: z.string().max(64) });

/** A TOTP code without spaces, or null when it cannot be one. */
export function normalizeTotpCode(code: string): string | null {
  const compact = code.replace(/\s+/g, "");
  return TOTP_CODE.test(compact) ? compact : null;
}

/** A backup code in Better Auth's `xxxxx-xxxxx` form, or null when it cannot be one. */
export function normalizeBackupCode(code: string): string | null {
  const match = BACKUP_CODE.exec(code.replace(/\s+/g, ""));
  return match === null ? null : `${match[1] ?? ""}-${match[2] ?? ""}`;
}

/** The base32 key inside an `otpauth://` URI, for manual entry in an authenticator. */
export function manualEntryKey(totpUri: string): string {
  try {
    return new URL(totpUri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

function apiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof APIError)) return undefined;
  const body: unknown = error.body;
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const isClientError = (error: unknown) =>
  error instanceof APIError && error.statusCode >= 400 && error.statusCode < 500;

export type ChallengeResult =
  | { readonly status: "SIGNED_IN"; readonly userId: string }
  | { readonly status: "INVALID_CODE" }
  /** No (valid) challenge: expired, used up, or never started. Sign in again. */
  | { readonly status: "CHALLENGE_EXPIRED" }
  /** Too many consecutive failures on this account: try again later. */
  | { readonly status: "LOCKED" };

/** Second step of sign-in: a TOTP or backup code against the challenge cookie. */
export async function verifySignInChallenge(
  deps: TwoFactorDeps,
  input: { readonly method: unknown; readonly code: unknown },
): Promise<ChallengeResult> {
  await deps.limit({ bucket: "two-factor-verify", requestHeaders: deps.headers });
  const parsed = challengeInputSchema.safeParse(input);
  if (!parsed.success) return { status: "INVALID_CODE" };
  // A browser that already has a session is not in a challenge; the plugin would treat
  // the call as a session check (and could consume a backup code for nothing).
  if ((await deps.auth.api.getSession({ headers: deps.headers })) !== null) {
    return { status: "CHALLENGE_EXPIRED" };
  }
  const { method, code } = parsed.data;
  const normalized = method === "totp" ? normalizeTotpCode(code) : normalizeBackupCode(code);
  if (normalized === null) return { status: "INVALID_CODE" };

  let result: { readonly token?: string | undefined; readonly user: { readonly id: string } };
  try {
    // `trustDevice` is never forwarded: every admin sign-in asks for the second factor.
    result =
      method === "totp"
        ? await deps.auth.api.verifyTOTP({ body: { code: normalized }, headers: deps.headers })
        : await deps.auth.api.verifyBackupCode({
            body: { code: normalized },
            headers: deps.headers,
          });
  } catch (error) {
    const code = apiErrorCode(error);
    if (code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE")
      return { status: "INVALID_CODE" };
    // The session hook refused the session: this TOTP code was already used (replay).
    if (code === "FAILED_TO_CREATE_SESSION") return { status: "INVALID_CODE" };
    if (code === "ACCOUNT_TEMPORARILY_LOCKED") return { status: "LOCKED" };
    if (isClientError(error)) return { status: "CHALLENGE_EXPIRED" };
    throw error;
  }
  return { status: "SIGNED_IN", userId: result.user.id };
}

export type EnrollmentStart =
  | {
      readonly status: "STARTED";
      /** `otpauth://` URI for authenticator apps (contains the secret: show once). */
      readonly totpUri: string;
      /** The same secret, for typing into an authenticator by hand. */
      readonly manualKey: string;
      /** Single-use recovery codes (show once; only their encrypted form is stored). */
      readonly backupCodes: readonly string[];
    }
  | { readonly status: "INVALID_PASSWORD" }
  | { readonly status: "ALREADY_ENABLED" };

async function twoFactorRow(db: PrismaClient, userId: string) {
  return db.twoFactor.findUnique({ where: { userId }, select: { verified: true } });
}

/** Enrollment, step 1: password check, then a new secret and backup codes. */
export async function startEnrollment(
  deps: TwoFactorDeps,
  userId: string,
  input: { readonly password: unknown },
): Promise<EnrollmentStart> {
  await deps.limit({ bucket: "two-factor-manage", requestHeaders: deps.headers, subject: userId });
  const parsed = passwordInputSchema.safeParse(input);
  if (!parsed.success) return { status: "INVALID_PASSWORD" };
  if ((await twoFactorRow(deps.db, userId))?.verified === true) {
    return { status: "ALREADY_ENABLED" };
  }
  try {
    const result = await deps.auth.api.enableTwoFactor({
      body: { password: parsed.data.password, method: "totp" },
      headers: deps.headers,
    });
    if (!("totpURI" in result)) {
      throw new AppError("INTERNAL", { message: "Two-factor enrollment returned no secret" });
    }
    return {
      status: "STARTED",
      totpUri: result.totpURI,
      manualKey: manualEntryKey(result.totpURI),
      backupCodes: result.backupCodes,
    };
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 401) {
      throw new AppError("UNAUTHENTICATED");
    }
    const code = apiErrorCode(error);
    if (code === "TOTP_ALREADY_ENABLED") return { status: "ALREADY_ENABLED" };
    if (isClientError(error)) return { status: "INVALID_PASSWORD" };
    throw error;
  }
}

/** Enrollment, step 2: the first valid code enables two-factor for the account. */
export async function confirmEnrollment(
  deps: TwoFactorDeps,
  userId: string,
  input: { readonly code: unknown },
): Promise<{ readonly status: "ENABLED" | "INVALID_CODE" | "NOT_STARTED" }> {
  await deps.limit({ bucket: "two-factor-manage", requestHeaders: deps.headers, subject: userId });
  const parsed = codeInputSchema.safeParse(input);
  const code = parsed.success ? normalizeTotpCode(parsed.data.code) : null;
  if (code === null) return { status: "INVALID_CODE" };
  // Only a pending enrollment is confirmed here. For an account that already has
  // two-factor, the plugin would accept any valid code as a no-op.
  if ((await twoFactorRow(deps.db, userId))?.verified !== false) return { status: "NOT_STARTED" };
  try {
    await deps.auth.api.verifyTOTP({ body: { code }, headers: deps.headers });
    // The enrollment code counts as used: it cannot also serve for a sign-in.
    await claimTotpCode(deps.db, userId, code);
    return { status: "ENABLED" };
  } catch (error) {
    if (
      error instanceof APIError &&
      error.statusCode === 401 &&
      apiErrorCode(error) !== "INVALID_CODE"
    ) {
      throw new AppError("UNAUTHENTICATED");
    }
    if (isClientError(error)) return { status: "INVALID_CODE" };
    throw error;
  }
}

/** Removes the second-factor marker from every session of the account. */
export async function clearSessionMfaMarkers(db: PrismaClient, userId: string): Promise<void> {
  await db.session.updateMany({
    where: { userId, mfaVerifiedAt: { not: null } },
    data: { mfaVerifiedAt: null },
  });
}

/**
 * Turns two-factor off (password required; Better Auth also wants a session younger
 * than a day — REAUTHENTICATE otherwise). Platform administrators lose admin access
 * until they enroll again.
 */
export async function disableTwoFactor(
  deps: TwoFactorDeps,
  userId: string,
  input: { readonly password: unknown },
): Promise<{
  readonly status: "DISABLED" | "INVALID_PASSWORD" | "NOT_ENABLED" | "REAUTHENTICATE";
}> {
  await deps.limit({ bucket: "two-factor-manage", requestHeaders: deps.headers, subject: userId });
  const parsed = passwordInputSchema.safeParse(input);
  if (!parsed.success) return { status: "INVALID_PASSWORD" };
  if ((await twoFactorRow(deps.db, userId)) === null) return { status: "NOT_ENABLED" };
  try {
    await deps.auth.api.disableTwoFactor({
      body: { password: parsed.data.password },
      headers: deps.headers,
    });
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 401) {
      throw new AppError("UNAUTHENTICATED");
    }
    if (apiErrorCode(error) === "SESSION_NOT_FRESH") return { status: "REAUTHENTICATE" };
    if (isClientError(error)) return { status: "INVALID_PASSWORD" };
    throw error;
  }
  await clearSessionMfaMarkers(deps.db, userId);
  return { status: "DISABLED" };
}

export type BackupCodesResult =
  | { readonly status: "REGENERATED"; readonly backupCodes: readonly string[] }
  | { readonly status: "INVALID_PASSWORD" }
  | { readonly status: "NOT_ENABLED" };

/** New backup codes (password required); every earlier code stops working. */
export async function regenerateBackupCodes(
  deps: TwoFactorDeps,
  userId: string,
  input: { readonly password: unknown },
): Promise<BackupCodesResult> {
  await deps.limit({ bucket: "two-factor-manage", requestHeaders: deps.headers, subject: userId });
  const parsed = passwordInputSchema.safeParse(input);
  if (!parsed.success) return { status: "INVALID_PASSWORD" };
  if ((await twoFactorRow(deps.db, userId))?.verified !== true) return { status: "NOT_ENABLED" };
  try {
    const result = await deps.auth.api.generateBackupCodes({
      body: { password: parsed.data.password },
      headers: deps.headers,
    });
    return { status: "REGENERATED", backupCodes: result.backupCodes };
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 401) {
      throw new AppError("UNAUTHENTICATED");
    }
    if (isClientError(error)) return { status: "INVALID_PASSWORD" };
    throw error;
  }
}
