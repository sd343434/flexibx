"use client";

import { PendingLabel } from "@/components/common/loaders";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { submitTwoFactor, type TwoFactorFormState } from "../../actions";
import { FormMessage } from "../../form-message";

/** Second sign-in step: a code from the authenticator app, or a single-use backup code. */
export function TwoFactorForm({ next }: { readonly next: string | undefined }) {
  const locale = useLocale();
  const t = useTranslations("auth.twoFactor");
  const tRoot = useTranslations();
  const [method, setMethod] = useState<"totp" | "backup">("totp");
  const [state, formAction, pending] = useActionState<TwoFactorFormState, FormData>(
    submitTwoFactor.bind(null, locale),
    null,
  );

  return (
    <form action={formAction} className="space-y-6" data-testid="two-factor-form">
      {state === null ? null : (
        <FormMessage tone="error" testId="auth-error">
          <p>{tRoot(state.messageKey)}</p>
        </FormMessage>
      )}
      {next === undefined ? null : <input type="hidden" name="next" value={next} />}
      <input type="hidden" name="method" value={method} />
      <div className="space-y-2">
        <label htmlFor="two-factor-code" className="block text-sm font-medium">
          {method === "totp" ? t("code") : t("backupCode")}
        </label>
        <Input
          key={method}
          id="two-factor-code"
          name="code"
          dir="ltr"
          required
          autoFocus
          maxLength={method === "totp" ? 8 : 16}
          inputMode={method === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
        />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending} data-testid="two-factor-submit">
          <PendingLabel pending={pending} idle={t("verify")} busy={t("verifying")} />
        </Button>
        <button
          type="button"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => {
            setMethod(method === "totp" ? "backup" : "totp");
          }}
          data-testid="two-factor-switch"
        >
          {method === "totp" ? t("useBackup") : t("useTotp")}
        </button>
      </div>
    </form>
  );
}
