"use server";

import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { signInAction, signOutAction, signUpAction } from "@/server/auth/auth-actions";
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
  const result = await signUpAction({ ...values, password: text(formData.get("password")) });
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
