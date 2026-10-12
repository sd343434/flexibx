// Pure decision for the platform-admin gate (platform-admin.ts), unit-tested on its own.

/**
 * How long a second-factor verification keeps a session admin-capable. After that the
 * administrator signs in again (password + code); the session itself stays valid for
 * the rest of the product.
 */
export const ADMIN_MFA_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Changes (saving storage settings, switching the write provider, granting credits,
 * changing plans) need a second-factor verification at most this old: a session left
 * open on a desk cannot be used to change platform settings an hour later.
 */
export const ADMIN_CHANGE_MFA_MAX_AGE_MS = 60 * 60 * 1000;

/** Tolerated clock difference between the app and the database for a fresh marker. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type PlatformAdminAccess =
  | "GRANTED"
  /** Not an administrator (or unverified email, or unknown user): the caller shows 404. */
  | "NOT_ADMIN"
  /** Administrator without two-factor on the account. */
  | "MFA_ENROLLMENT_REQUIRED"
  /** Administrator whose current session did not pass (or no longer recently passed) it. */
  | "MFA_VERIFICATION_REQUIRED";

export interface AdminAccountState {
  readonly isPlatformAdmin: boolean;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
}

export function platformAdminAccess(
  account: AdminAccountState | null,
  sessionMfaVerifiedAt: Date | null,
  now: Date,
  maxAgeMs: number = ADMIN_MFA_MAX_AGE_MS,
): PlatformAdminAccess {
  if (account === null || !account.isPlatformAdmin || !account.emailVerified) return "NOT_ADMIN";
  if (!account.twoFactorEnabled) return "MFA_ENROLLMENT_REQUIRED";
  if (sessionMfaVerifiedAt === null) return "MFA_VERIFICATION_REQUIRED";
  const age = now.getTime() - sessionMfaVerifiedAt.getTime();
  if (Number.isNaN(age) || age > maxAgeMs || age < -CLOCK_SKEW_MS) {
    return "MFA_VERIFICATION_REQUIRED";
  }
  return "GRANTED";
}
