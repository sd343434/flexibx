"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { submitForgotPassword, submitResendVerification, type EmailRequestState } from "./actions";
import { FormMessage } from "./form-message";

interface EmailRequestFormProps {
  readonly kind: "resend-verification" | "forgot-password";
  readonly label: string;
  readonly submit: string;
  readonly submitting: string;
  /** The generic confirmation shown for every address. */
  readonly sent: string;
  readonly defaultEmail?: string;
}

/**
 * One email field and a generic answer: used to resend a verification link and to
 * request a password reset. The confirmation never depends on the account existing.
 */
export function EmailRequestForm({
  kind,
  label,
  submit,
  submitting,
  sent,
  defaultEmail,
}: EmailRequestFormProps) {
  const locale = useLocale();
  const tRoot = useTranslations();
  const action = kind === "forgot-password" ? submitForgotPassword : submitResendVerification;
  const [state, formAction, pending] = useActionState<EmailRequestState, FormData>(
    action.bind(null, locale),
    null,
  );
  const id = `${kind}-email`;
  const failed = state !== null && "messageKey" in state ? state : undefined;
  const fieldError = failed?.fields?.find((field) => field.path === "email");

  if (state !== null && "status" in state) {
    return (
      <FormMessage tone="status" testId={`${kind}-sent`}>
        <p>{sent}</p>
      </FormMessage>
    );
  }

  return (
    <form action={formAction} className="space-y-4" data-testid={`${kind}-form`}>
      {failed === undefined ? null : (
        <FormMessage tone="error" testId="auth-error">
          <p>{tRoot(failed.messageKey)}</p>
        </FormMessage>
      )}
      <div className="space-y-2">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <Input
          id={id}
          name="email"
          type="email"
          dir="ltr"
          required
          autoComplete="email"
          defaultValue={failed?.values.email ?? defaultEmail}
          aria-invalid={fieldError === undefined ? undefined : true}
        />
        {fieldError === undefined ? null : (
          <p className="text-sm text-destructive">
            {tRoot.has(`validation.${fieldError.code}` as never)
              ? tRoot(`validation.${fieldError.code}` as never, fieldError.params as never)
              : tRoot("validation.invalid")}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} data-testid={`${kind}-submit`}>
        {pending ? submitting : submit}
      </Button>
    </form>
  );
}
