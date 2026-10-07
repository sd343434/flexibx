"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { submitSignIn, type AuthFormState } from "../actions";

interface SignInFormProps {
  /** Raw `next` query value; the server sanitizes it before redirecting. */
  readonly next: string | undefined;
  readonly registered: boolean;
}

export function SignInForm({ next, registered }: SignInFormProps) {
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
        registered ? (
          <p role="status" className="rounded-md border p-3 text-sm" data-testid="registered">
            {t("registered")}
          </p>
        ) : null
      ) : (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
          data-testid="auth-error"
        >
          {tRoot(state.messageKey)}
        </p>
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
