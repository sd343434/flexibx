import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { LOCALES } from "@/i18n/config";

import { recordAudit } from "../audit/audit-log";
import { getDb, getSystemDb } from "../db/client";
import { withAction } from "../http/action-handler";

import {
  changePassword,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  verifyEmailToken,
  type AccountSecurityDeps,
} from "./account-security";
import { getAuth, getRateLimiter } from "./auth";
import {
  signInWithEmail,
  signOutCurrentSession,
  signUpInputSchema,
  signUpWithEmail,
} from "./credentials";
import { requireUser } from "./session";
import {
  confirmEnrollment,
  disableTwoFactor,
  regenerateBackupCodes,
  startEnrollment,
  verifySignInChallenge,
  type TwoFactorDeps,
} from "./two-factor";

// Server actions behind the authentication pages. Session cookies are written (and
// cleared) by Better Auth's nextCookies() plugin; nothing here touches tokens. Next.js
// rejects cross-origin server action calls. Inputs are only shape-checked here; the
// functions they call validate content and keep every response generic.

const locale = z.enum(LOCALES);

async function deps(): Promise<AccountSecurityDeps> {
  return { auth: getAuth(), limit: getRateLimiter(), headers: new Headers(await headers()) };
}

/** Read-only: whether the user currently holds the platform-admin flag. */
async function isPlatformAdminFlagSet(userId: string): Promise<boolean> {
  const row = await getSystemDb().user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true },
  });
  return row?.isPlatformAdmin === true;
}

async function twoFactorDeps(): Promise<TwoFactorDeps> {
  return { ...(await deps()), db: getSystemDb() };
}

const userAudit = (
  userId: string,
  action: Parameters<typeof recordAudit>[2]["action"],
  metadata?: Record<string, string>,
) =>
  recordAudit(
    getDb(),
    { workspaceId: null, userId },
    {
      action,
      entityType: "user",
      entityId: userId,
      ...(metadata === undefined ? {} : { metadata }),
    },
  );

/** Registers an account. ACCEPTED for a new and an already-registered email alike. */
export const signUpAction = withAction({
  name: "auth.signUp",
  input: signUpInputSchema.extend({ locale }),
  handler: async ({ locale: target, ...input }) => {
    const { auth, ...rest } = await deps();
    return signUpWithEmail(auth, input, rest, target);
  },
});

/**
 * Signs in. The schema only checks the shape; every content problem — malformed email,
 * unknown account, wrong password — comes back as the same INVALID_CREDENTIALS.
 */
export const signInAction = withAction({
  name: "auth.signIn",
  input: z.object({ email: z.string(), password: z.string() }),
  handler: async (input) => {
    const { auth, ...rest } = await deps();
    const result = await signInWithEmail(auth, input, rest);
    return { status: result.status };
  },
});

/** Ends the current session: deletes it in the database and expires the cookie. */
export const signOutAction = withAction({
  name: "auth.signOut",
  input: z.object({}),
  handler: async () => {
    await signOutCurrentSession(getAuth(), new Headers(await headers()));
    return { status: "SIGNED_OUT" as const };
  },
});

/** Sends a new verification link when an unverified account uses the email. */
export const resendVerificationAction = withAction({
  name: "auth.resendVerification",
  input: z.object({ email: z.string(), locale }),
  handler: async ({ email, locale: target }) =>
    resendVerificationEmail(await deps(), { email }, target),
});

/** Verifies an email address with the token from the link's URL fragment. */
export const verifyEmailAction = withAction({
  name: "auth.verifyEmail",
  input: z.object({ token: z.string().max(4096) }),
  handler: async ({ token }) => verifyEmailToken(await deps(), { token }),
});

/** Starts a password reset; the same answer for every email. */
export const requestPasswordResetAction = withAction({
  name: "auth.requestPasswordReset",
  input: z.object({ email: z.string(), locale }),
  handler: async ({ email, locale: target }) =>
    requestPasswordReset(await deps(), { email }, target),
});

/** Sets a new password with a reset token; every session of the account ends. */
export const resetPasswordAction = withAction({
  name: "auth.resetPassword",
  input: z.object({ token: z.string().max(256), newPassword: z.string() }),
  handler: async (input) => resetPasswordWithToken(await deps(), input),
});

/** Changes the signed-in user's password; the account's other sessions end. */
export const changePasswordAction = withAction({
  name: "auth.changePassword",
  input: z.object({ currentPassword: z.string(), newPassword: z.string() }),
  handler: async (input) => {
    const user = await requireUser();
    const result = await changePassword(await deps(), user.id, input);
    if (result.status === "CHANGED") {
      await recordAudit(
        getDb(),
        { workspaceId: null, userId: user.id },
        { action: "user.password_changed", entityType: "user", entityId: user.id },
      );
    }
    return result;
  },
});

/**
 * Second sign-in step for an account with two-factor authentication (TOTP or a backup
 * code). On success the session cookie is set (nextCookies) and the sign-in is audited.
 */
export const verifyTwoFactorAction = withAction({
  name: "auth.twoFactor.verify",
  input: z.object({ method: z.string(), code: z.string() }),
  handler: async (input) => {
    const result = await verifySignInChallenge(await twoFactorDeps(), input);
    if (result.status === "SIGNED_IN") {
      await userAudit(result.userId, "user.mfa_sign_in", {
        method: input.method === "backup" ? "backup_code" : "totp",
      });
      return { status: result.status };
    }
    return result;
  },
});

/** Enrollment step 1: the secret and backup codes, shown once to the signed-in user. */
export const startTwoFactorEnrollmentAction = withAction({
  name: "auth.twoFactor.start",
  input: z.object({ password: z.string() }),
  handler: async (input) => {
    const user = await requireUser();
    return startEnrollment(await twoFactorDeps(), user.id, input);
  },
});

/** Enrollment step 2: the first valid code turns two-factor on. */
export const confirmTwoFactorEnrollmentAction = withAction({
  name: "auth.twoFactor.confirm",
  input: z.object({ code: z.string() }),
  handler: async (input) => {
    const user = await requireUser();
    const result = await confirmEnrollment(await twoFactorDeps(), user.id, input);
    if (result.status === "ENABLED") {
      await userAudit(user.id, "user.mfa_enabled", { method: "totp" });
    }
    return result;
  },
});

/** Turns two-factor off (password required). */
export const disableTwoFactorAction = withAction({
  name: "auth.twoFactor.disable",
  input: z.object({ password: z.string() }),
  handler: async (input) => {
    const user = await requireUser();
    const wasAdmin = await isPlatformAdminFlagSet(user.id);
    const result = await disableTwoFactor(await twoFactorDeps(), user.id, input);
    if (result.status === "DISABLED") {
      await userAudit(user.id, "user.mfa_disabled");
      // The database removed the administrator flag with two-factor (migration
      // 20261014120000); getting it back needs a new grant (ADMIN_PROVISIONING.md).
      if (wasAdmin) await userAudit(user.id, "platform_admin.revoked", { cause: "mfa_disabled" });
    }
    return result;
  },
});

/** Replaces the backup codes (password required). */
export const regenerateBackupCodesAction = withAction({
  name: "auth.twoFactor.backupCodes",
  input: z.object({ password: z.string() }),
  handler: async (input) => {
    const user = await requireUser();
    const result = await regenerateBackupCodes(await twoFactorDeps(), user.id, input);
    if (result.status === "REGENERATED") {
      await userAudit(user.id, "user.mfa_backup_codes_regenerated");
    }
    return result;
  },
});
