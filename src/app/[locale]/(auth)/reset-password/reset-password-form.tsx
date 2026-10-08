"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";

import { submitResetPassword, type TokenFormState } from "../actions";
import { FormMessage } from "../form-message";
import { useFragmentToken } from "../use-fragment-token";

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

/** Choose a new password with the token from the reset link (URL fragment). */
export function ResetPasswordForm() {
  const locale = useLocale();
  const t = useTranslations("auth.resetPassword");
  const tRoot = useTranslations();
  const { ready, token } = useFragmentToken();
  const [state, formAction, pending] = useActionState<TokenFormState, FormData>(
    submitResetPassword.bind(null, locale),
    null,
  );

  if (!ready) return null;

  const requestNew = (
    <Link href="/forgot-password" className="font-medium underline underline-offset-4">
      {t("requestNew")}
    </Link>
  );

  if (token === null) {
    return (
      <FormMessage tone="status" testId="reset-password-missing">
        <p>{t("missing")}</p>
        {requestNew}
      </FormMessage>
    );
  }

  if (state !== null && "status" in state) {
    return (
      <FormMessage tone="error" testId="reset-password-invalid">
        <p>{t("invalid")}</p>
        {requestNew}
      </FormMessage>
    );
  }

  const failed = state !== null && "messageKey" in state ? state : undefined;
  const fieldError = failed?.fields?.find((field) => field.path === "newPassword");

  return (
    <form action={formAction} className="space-y-6" data-testid="reset-password-form">
      {failed === undefined || fieldError !== undefined ? null : (
        <FormMessage tone="error" testId="auth-error">
          <p>{tRoot(failed.messageKey)}</p>
        </FormMessage>
      )}
      <input type="hidden" name="token" value={token} />
      <div className="space-y-2">
        <label htmlFor="reset-new-password" className="block text-sm font-medium">
          {t("newPassword")}
        </label>
        <Input
          id="reset-new-password"
          name="newPassword"
          type="password"
          dir="ltr"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          aria-invalid={fieldError === undefined ? undefined : true}
          aria-describedby="reset-new-password-hint"
        />
        <p id="reset-new-password-hint" className="text-sm text-muted-foreground">
          {t("passwordHint", { minimum: PASSWORD_MIN_LENGTH })}
        </p>
        {fieldError === undefined ? null : (
          <p className="text-sm text-destructive">
            {tRoot.has(`validation.${fieldError.code}` as never)
              ? tRoot(`validation.${fieldError.code}` as never, fieldError.params as never)
              : tRoot("validation.invalid")}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} data-testid="reset-password-submit">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
