"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { submitChangePassword, type ChangePasswordState } from "../../(auth)/actions";
import { FormMessage } from "../../(auth)/form-message";

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

/** Change the password (current one required); other sessions are signed out. */
export function ChangePasswordForm({ changed }: { readonly changed: boolean }) {
  const locale = useLocale();
  const t = useTranslations("auth.changePassword");
  const tRoot = useTranslations();
  const [state, formAction, pending] = useActionState<ChangePasswordState, FormData>(
    submitChangePassword.bind(null, locale),
    null,
  );
  const failed = state ?? undefined;
  const fieldError = failed?.fields?.find((field) => field.path === "newPassword");

  return (
    <form action={formAction} className="space-y-6" data-testid="change-password-form">
      {changed && state === null ? (
        <FormMessage tone="status" testId="change-password-success">
          <p>{t("success")}</p>
        </FormMessage>
      ) : null}
      {failed === undefined || fieldError !== undefined ? null : (
        <FormMessage tone="error" testId="auth-error">
          <p>{tRoot(failed.messageKey)}</p>
        </FormMessage>
      )}
      <div className="space-y-2">
        <label htmlFor="current-password" className="block text-sm font-medium">
          {t("currentPassword")}
        </label>
        <Input
          id="current-password"
          name="currentPassword"
          type="password"
          dir="ltr"
          required
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="current-password"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="new-password" className="block text-sm font-medium">
          {t("newPassword")}
        </label>
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          dir="ltr"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          aria-invalid={fieldError === undefined ? undefined : true}
          aria-describedby="new-password-hint"
        />
        <p id="new-password-hint" className="text-sm text-muted-foreground">
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
      <Button type="submit" disabled={pending} data-testid="change-password-submit">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
