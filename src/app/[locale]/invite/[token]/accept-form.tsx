"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { submitAcceptInvitation, type AcceptFormState } from "./actions";

export function AcceptInvitationForm({ token }: { readonly token: string }) {
  const locale = useLocale();
  const t = useTranslations("invite");
  const tRoot = useTranslations();
  const [state, formAction, pending] = useActionState<AcceptFormState, FormData>(
    submitAcceptInvitation.bind(null, locale),
    null,
  );
  const field = state?.error.fields?.[0];
  const fieldKey = field === undefined ? undefined : `validation.${field.code}`;
  const message =
    state === null
      ? undefined
      : fieldKey !== undefined && tRoot.has(fieldKey as never)
        ? tRoot(fieldKey as never)
        : tRoot(state.error.messageKey);

  return (
    <form action={formAction} className="space-y-3" data-testid="accept-invitation-form">
      <input type="hidden" name="token" value={token} />
      {message === undefined ? null : (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
          data-testid="accept-error"
        >
          {message}
        </p>
      )}
      <Button type="submit" disabled={pending} data-testid="accept-invitation">
        {pending ? t("accepting") : t("accept")}
      </Button>
    </form>
  );
}
