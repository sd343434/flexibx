"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";

import { submitSignIn, type AuthFormState } from "../actions";

interface SignInFormProps {
  /** Raw `next` query value; the server sanitizes it before redirecting. */
  readonly next: string | undefined;
  /** A status message from the previous step (sign-up, verification, reset). */
  readonly notice?: "registered" | "verified" | "passwordReset" | undefined;
}

export function SignInForm({ next, notice }: SignInFormProps) {
  const locale = useLocale();
  const t = useTranslations("auth.signIn");
  const tRoot = useTranslations();
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(
    submitSignIn.bind(null, locale),
    null,
  );

  return (
    <form action={formAction} className="space-y-6" data-testid="sign-in-form">
      {state === null ? (
        notice === undefined ? null : (
          <p role="status" className="rounded-md border p-3 text-sm" data-testid={notice}>
            {t(notice)}
          </p>
        )
      ) : (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive p-3 text-sm text-destructive"
          data-testid="auth-error"
        >
          <p>{tRoot(state.messageKey)}</p>
          {state.messageKey === "auth.errors.emailNotVerified" ? (
            <Link
              href="/verify-email"
              className="font-medium underline underline-offset-4"
              data-testid="verify-email-link"
            >
              {t("verifyEmailLink")}
            </Link>
          ) : null}
        </div>
      )}
      {next === undefined ? null : <input type="hidden" name="next" value={next} />}

      <div className="space-y-2">
        <label htmlFor="sign-in-email" className="block text-sm font-medium">
          {t("email")}
        </label>
        <Input
          id="sign-in-email"
          name="email"
          type="email"
          dir="ltr"
          required
          autoComplete="email"
          defaultValue={state?.values.email}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="sign-in-password" className="block text-sm font-medium">
          {t("password")}
        </label>
        <Input
          id="sign-in-password"
          name="password"
          type="password"
          dir="ltr"
          required
          autoComplete="current-password"
        />
      </div>

      <Button type="submit" disabled={pending} data-testid="sign-in-submit">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
