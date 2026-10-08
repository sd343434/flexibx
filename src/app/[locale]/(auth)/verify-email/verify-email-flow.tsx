"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

import { submitVerifyEmail, type TokenFormState } from "../actions";
import { EmailRequestForm } from "../email-request-form";
import { FormMessage } from "../form-message";
import { useFragmentToken } from "../use-fragment-token";

interface VerifyEmailFlowProps {
  readonly signedIn: boolean;
  /** The signed-in account is already verified. */
  readonly alreadyVerified: boolean;
}

/**
 * `/{locale}/verify-email`: with a link token (URL fragment) the user confirms with a
 * button — a POST, so mail scanners that prefetch links cannot use up the token.
 * Without one: instructions and a "send a new link" form with a generic answer.
 */
export function VerifyEmailFlow({ signedIn, alreadyVerified }: VerifyEmailFlowProps) {
  const t = useTranslations("auth.verifyEmail");
  const tRoot = useTranslations();
  const { ready, token } = useFragmentToken();
  const [state, formAction, pending] = useActionState<TokenFormState, FormData>(
    submitVerifyEmail,
    null,
  );
  const continueHref = signedIn
    ? "/workspaces"
    : { pathname: "/sign-in", query: { verified: "1" } };

  const resend = (
    <section className="space-y-3 border-t pt-6">
      <h2 className="text-lg font-semibold">{t("resendTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("resendDescription")}</p>
      <EmailRequestForm
        kind="resend-verification"
        label={t("email")}
        submit={t("resendSubmit")}
        submitting={t("resending")}
        sent={t("resendSent")}
      />
    </section>
  );

  if (!ready) return null;

  if (state !== null && "status" in state && state.status === "verified") {
    return (
      <FormMessage tone="status" testId="verify-email-success">
        <p>{t("success")}</p>
        <Button asChild size="sm">
          <Link href={continueHref}>{signedIn ? t("continue") : t("signIn")}</Link>
        </Button>
      </FormMessage>
    );
  }

  if (token !== null && !(state !== null && "status" in state)) {
    return (
      <form action={formAction} className="space-y-4" data-testid="verify-email-form">
        <h2 className="text-lg font-semibold">{t("confirmTitle")}</h2>
        <p className="text-muted-foreground">{t("confirmDescription")}</p>
        {state !== null && "messageKey" in state ? (
          <FormMessage tone="error" testId="auth-error">
            <p>{tRoot(state.messageKey)}</p>
          </FormMessage>
        ) : null}
        <input type="hidden" name="token" value={token} />
        <Button type="submit" disabled={pending} data-testid="verify-email-submit">
          {pending ? t("confirming") : t("confirm")}
        </Button>
      </form>
    );
  }

  if (state !== null && "status" in state) {
    return (
      <div className="space-y-6">
        <FormMessage tone="error" testId="verify-email-invalid">
          <p>{t("invalid")}</p>
        </FormMessage>
        {resend}
      </div>
    );
  }

  if (alreadyVerified) {
    return (
      <FormMessage tone="status" testId="verify-email-already">
        <p>{t("alreadyVerified")}</p>
        <Button asChild size="sm">
          <Link href="/workspaces">{t("continue")}</Link>
        </Button>
      </FormMessage>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">{t("description")}</p>
      {resend}
    </div>
  );
}
