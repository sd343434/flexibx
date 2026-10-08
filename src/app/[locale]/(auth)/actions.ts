"use server";

import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import {
  changePasswordAction,
  requestPasswordResetAction,
  resendVerificationAction,
  resetPasswordAction,
  signInAction,
  signOutAction,
  signUpAction,
  verifyEmailAction,
} from "@/server/auth/auth-actions";
import {
  AUTH_ERROR_MESSAGE_KEYS,
  authErrorMessageKey,
  type AuthErrorMessageKey,
} from "@/server/auth/auth-messages";
import { postSignInPath, safeNextPath } from "@/server/auth/safe-redirect";
import type { FieldError } from "@/server/errors/app-error";

/**
 * State of a rejected sign-up / sign-in form: a Flexibx message key, field errors for
 * sign-up input only, and the non-secret values to refill (never the password).
 */
export type AuthFormState = {
  readonly messageKey: AuthErrorMessageKey;
  readonly fields?: readonly FieldError[];
  readonly values: { readonly name?: string; readonly email: string };
} | null;

const text = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : "");
const toLocale = (value: string): Locale => (isLocale(value) ? value : DEFAULT_LOCALE);

/**
 * Sign-up form. The outcome is the same for a new and an already-registered email:
 * a redirect to the sign-in page (no automatic sign-in). Only invalid input is
 * reported, per field.
 */
export async function submitSignUp(
  locale: string,
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const target = toLocale(locale);
  const values = { name: text(formData.get("name")), email: text(formData.get("email")) };
  const result = await signUpAction({
    ...values,
    password: text(formData.get("password")),
    locale: target,
  });
  if (!result.ok) {
    const fields = result.error.code === "VALIDATION_FAILED" ? result.error.fields : undefined;
    return {
      messageKey: authErrorMessageKey(result.error.code),
      ...(fields === undefined ? {} : { fields }),
      values,
    };
  }

  const query = new URLSearchParams({ registered: "1" });
  const next = text(formData.get("next"));
  if (next !== "" && safeNextPath(next, target) === next) query.set("next", next);
  redirect(`/${target}/sign-in?${query.toString()}`);
}

/**
 * Sign-in form. Every failure shows the same message. On success the session cookie is
 * already set (nextCookies) and the user goes to the sanitized `next` path, or to
 * `/{locale}/workspaces`.
 */
export async function submitSignIn(
  locale: string,
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const target = toLocale(locale);
  const values = { email: text(formData.get("email")) };
  const result = await signInAction({ ...values, password: text(formData.get("password")) });
  if (!result.ok) return { messageKey: authErrorMessageKey(result.error.code), values };
  if (result.data.status !== "SIGNED_IN") {
    return { messageKey: AUTH_ERROR_MESSAGE_KEYS.invalidCredentials, values };
  }
  redirect(postSignInPath(formData.get("next"), target));
}

/** Sign-out button: revokes the current session, then shows the sign-in page. */
export async function submitSignOut(locale: string): Promise<void> {
  await signOutAction({});
  redirect(`/${toLocale(locale)}/sign-in`);
}

/**
 * State of an email-only request form (resend verification, forgot password): the
 * generic confirmation, or an error key with field errors for malformed input.
 */
export type EmailRequestState =
  | { readonly status: "sent" }
  | {
      readonly messageKey: AuthErrorMessageKey;
      readonly fields?: readonly FieldError[];
      readonly values: { readonly email: string };
    }
  | null;

function emailRequestFailure(
  error: {
    readonly code: Parameters<typeof authErrorMessageKey>[0];
    readonly fields?: readonly FieldError[];
  },
  email: string,
): EmailRequestState {
  const fields = error.code === "VALIDATION_FAILED" ? error.fields : undefined;
  return {
    messageKey: authErrorMessageKey(error.code),
    ...(fields === undefined ? {} : { fields }),
    values: { email },
  };
}

/** Resend verification. The confirmation is the same for every email address. */
export async function submitResendVerification(
  locale: string,
  _previous: EmailRequestState,
  formData: FormData,
): Promise<EmailRequestState> {
  const email = text(formData.get("email"));
  const result = await resendVerificationAction({ email, locale: toLocale(locale) });
  return result.ok ? { status: "sent" } : emailRequestFailure(result.error, email);
}

/** Forgot password. The confirmation is the same for every email address. */
export async function submitForgotPassword(
  locale: string,
  _previous: EmailRequestState,
  formData: FormData,
): Promise<EmailRequestState> {
  const email = text(formData.get("email"));
  const result = await requestPasswordResetAction({ email, locale: toLocale(locale) });
  return result.ok ? { status: "sent" } : emailRequestFailure(result.error, email);
}

/** A token form (verify email, reset password): idle, invalid token or an error. */
export type TokenFormState =
  | { readonly status: "verified" }
  | { readonly status: "invalid" }
  | { readonly messageKey: AuthErrorMessageKey; readonly fields?: readonly FieldError[] }
  | null;

/** Verifies the email address with the token read from the link's URL fragment. */
export async function submitVerifyEmail(
  _previous: TokenFormState,
  formData: FormData,
): Promise<TokenFormState> {
  const result = await verifyEmailAction({ token: text(formData.get("token")) });
  if (!result.ok) return { messageKey: authErrorMessageKey(result.error.code) };
  return result.data.status === "VERIFIED" ? { status: "verified" } : { status: "invalid" };
}

/**
 * Sets a new password with the token read from the link's URL fragment. On success
 * every session of the account has ended; the user signs in again with the new password.
 */
export async function submitResetPassword(
  locale: string,
  _previous: TokenFormState,
  formData: FormData,
): Promise<TokenFormState> {
  const result = await resetPasswordAction({
    token: text(formData.get("token")),
    newPassword: text(formData.get("newPassword")),
  });
  if (!result.ok) {
    const fields = result.error.code === "VALIDATION_FAILED" ? result.error.fields : undefined;
    return {
      messageKey: authErrorMessageKey(result.error.code),
      ...(fields === undefined ? {} : { fields }),
    };
  }
  if (result.data.status !== "RESET") return { status: "invalid" };
  redirect(`/${toLocale(locale)}/sign-in?reset=1`);
}

export type ChangePasswordState = {
  readonly messageKey: AuthErrorMessageKey;
  readonly fields?: readonly FieldError[];
} | null;

/**
 * Changes the signed-in user's password; the passwords are never echoed back. Success
 * reloads the page with `?changed=1`: Better Auth replaced the session cookie, and the
 * confirmation must not depend on client state surviving that refresh.
 */
export async function submitChangePassword(
  locale: string,
  _previous: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const result = await changePasswordAction({
    currentPassword: text(formData.get("currentPassword")),
    newPassword: text(formData.get("newPassword")),
  });
  if (!result.ok) {
    const fields = result.error.code === "VALIDATION_FAILED" ? result.error.fields : undefined;
    return {
      messageKey: authErrorMessageKey(result.error.code),
      ...(fields === undefined ? {} : { fields }),
    };
  }
  if (result.data.status !== "CHANGED")
    return { messageKey: AUTH_ERROR_MESSAGE_KEYS.wrongPassword };
  redirect(`/${toLocale(locale)}/account/security?changed=1`);
}
