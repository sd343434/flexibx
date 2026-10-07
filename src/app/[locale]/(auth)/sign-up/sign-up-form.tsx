"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { submitSignUp, type AuthFormState } from "../actions";

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

export function SignUpForm({ next }: { readonly next: string | undefined }) {
  const locale = useLocale();
  const t = useTranslations("auth.signUp");
  const tRoot = useTranslations();
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(
    submitSignUp.bind(null, locale),
    null,
  );

  const fieldError = (path: string): string | undefined => {
    const field = state?.fields?.find((candidate) => candidate.path === path);
    if (field === undefined) return undefined;
    const key = `validation.${field.code}`;
    return tRoot.has(key as never)
      ? tRoot(key as never, field.params as never)
      : tRoot("validation.invalid");
  };
  const errors = {
    name: fieldError("name"),
    email: fieldError("email"),
    password: fieldError("password"),
  };
  const field = (name: keyof typeof errors) => ({
    "aria-invalid": errors[name] === undefined ? undefined : true,
    "aria-describedby": errors[name] === undefined ? undefined : `sign-up-${name}-error`,
  });
  const fieldMessage = (name: keyof typeof errors) =>
    errors[name] === undefined ? null : (
      <p id={`sign-up-${name}-error`} className="text-sm text-destructive">
        {errors[name]}
      </p>
    );

  return (
    <form action={formAction} className="space-y-6" data-testid="sign-up-form">
      {state === null ? null : (
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
        <label htmlFor="sign-up-name" className="block text-sm font-medium">
          {t("name")}
        </label>
        <Input
          id="sign-up-name"
          name="name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          defaultValue={state?.values.name}
          {...field("name")}
        />
        {fieldMessage("name")}
      </div>

      <div className="space-y-2">
        <label htmlFor="sign-up-email" className="block text-sm font-medium">
          {t("email")}
        </label>
        <Input
          id="sign-up-email"
          name="email"
          type="email"
          dir="ltr"
          required
          autoComplete="email"
          defaultValue={state?.values.email}
          {...field("email")}
        />
        {fieldMessage("email")}
      </div>

      <div className="space-y-2">
        <label htmlFor="sign-up-password" className="block text-sm font-medium">
          {t("password")}
        </label>
        <Input
          id="sign-up-password"
          name="password"
          type="password"
          dir="ltr"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          {...field("password")}
        />
        <p className="text-sm text-muted-foreground">
          {t("passwordHint", { minimum: PASSWORD_MIN_LENGTH })}
        </p>
        {fieldMessage("password")}
      </div>

      <Button type="submit" disabled={pending} data-testid="sign-up-submit">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
