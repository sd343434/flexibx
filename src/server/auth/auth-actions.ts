import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { LOCALES } from "@/i18n/config";

import { recordAudit } from "../audit/audit-log";
import { getDb } from "../db/client";
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

// Server actions behind the authentication pages. Session cookies are written (and
// cleared) by Better Auth's nextCookies() plugin; nothing here touches tokens. Next.js
// rejects cross-origin server action calls. Inputs are only shape-checked here; the
// functions they call validate content and keep every response generic.

const locale = z.enum(LOCALES);

async function deps(): Promise<AccountSecurityDeps> {
  return { auth: getAuth(), limit: getRateLimiter(), headers: new Headers(await headers()) };
}

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
