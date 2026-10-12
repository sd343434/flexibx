"use client";

import { PendingLabel } from "@/components/common/loaders";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  submitConfirmEnrollment,
  submitDisableTwoFactor,
  submitRegenerateBackupCodes,
  submitStartEnrollment,
  type BackupCodesState,
  type EnrollmentState,
  type TwoFactorFormState,
} from "../../(auth)/actions";
import { FormMessage } from "../../(auth)/form-message";

function PasswordField({ id }: { readonly id: string }) {
  const t = useTranslations("auth.twoFactor");
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {t("password")}
      </label>
      <Input
        id={id}
        name="password"
        type="password"
        dir="ltr"
        required
        maxLength={128}
        autoComplete="current-password"
      />
    </div>
  );
}

function ErrorMessage({ state }: { readonly state: object | null }) {
  const tRoot = useTranslations();
  if (state === null || !("messageKey" in state)) return null;
  return (
    <FormMessage tone="error" testId="two-factor-error">
      <p>{tRoot((state as { messageKey: Parameters<typeof tRoot>[0] }).messageKey)}</p>
    </FormMessage>
  );
}

function BackupCodes({ codes }: { readonly codes: readonly string[] }) {
  const t = useTranslations("auth.twoFactor");
  return (
    <div className="space-y-2">
      <h3 className="font-medium">{t("backupTitle")}</h3>
      <p className="text-sm text-muted-foreground">{t("backupHint")}</p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm" dir="ltr" data-testid="backup-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </div>
  );
}

/** Account without two-factor: password → setup key + backup codes → first code. */
function Enroll() {
  const locale = useLocale();
  const t = useTranslations("auth.twoFactor");
  const [started, startAction, starting] = useActionState<EnrollmentState, FormData>(
    submitStartEnrollment,
    null,
  );
  const [confirmed, confirmAction, confirming] = useActionState<TwoFactorFormState, FormData>(
    submitConfirmEnrollment.bind(null, locale),
    null,
  );

  if (started !== null && "status" in started) {
    return (
      <div className="space-y-6" data-testid="two-factor-setup">
        <div className="space-y-2">
          <h3 className="font-medium">{t("scanTitle")}</h3>
          <p className="text-sm">{t("manualKey")}</p>
          <p
            className="rounded-md border p-3 font-mono text-sm break-all"
            dir="ltr"
            data-testid="two-factor-key"
          >
            {started.manualKey}
          </p>
          <a
            href={started.totpUri}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("setupLink")}
          </a>
        </div>
        <BackupCodes codes={started.backupCodes} />
        <form action={confirmAction} className="space-y-4" data-testid="two-factor-confirm-form">
          <ErrorMessage state={confirmed} />
          <div className="space-y-2">
            <label htmlFor="two-factor-confirm-code" className="block text-sm font-medium">
              {t("confirmCode")}
            </label>
            <Input
              id="two-factor-confirm-code"
              name="code"
              dir="ltr"
              required
              inputMode="numeric"
              maxLength={8}
              autoComplete="one-time-code"
            />
          </div>
          <Button type="submit" disabled={confirming} data-testid="two-factor-confirm">
            <PendingLabel pending={confirming} idle={t("confirm")} busy={t("confirming")} />
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form action={startAction} className="space-y-4" data-testid="two-factor-start-form">
      <ErrorMessage state={started} />
      <p className="text-sm">{t("enrollPassword")}</p>
      <PasswordField id="two-factor-start-password" />
      <Button type="submit" disabled={starting} data-testid="two-factor-start">
        <PendingLabel pending={starting} idle={t("start")} busy={t("starting")} />
      </Button>
    </form>
  );
}

/** Account with two-factor: new backup codes, or turn it off. */
function Manage() {
  const locale = useLocale();
  const t = useTranslations("auth.twoFactor");
  const [codes, regenerateAction, regenerating] = useActionState<BackupCodesState, FormData>(
    submitRegenerateBackupCodes,
    null,
  );
  const [disabled, disableAction, disabling] = useActionState<TwoFactorFormState, FormData>(
    submitDisableTwoFactor.bind(null, locale),
    null,
  );
  return (
    <div className="space-y-8">
      <form action={regenerateAction} className="space-y-4" data-testid="backup-codes-form">
        <h3 className="font-medium">{t("regenerateTitle")}</h3>
        <ErrorMessage state={codes} />
        {codes !== null && "status" in codes ? (
          <>
            <FormMessage tone="status" testId="backup-codes-regenerated">
              <p>{t("regenerated")}</p>
            </FormMessage>
            <BackupCodes codes={codes.backupCodes} />
          </>
        ) : null}
        <PasswordField id="backup-codes-password" />
        <Button type="submit" variant="outline" disabled={regenerating}>
          <PendingLabel pending={regenerating} idle={t("regenerate")} busy={t("regenerating")} />
        </Button>
      </form>
      <form action={disableAction} className="space-y-4" data-testid="two-factor-disable-form">
        <h3 className="font-medium">{t("disableTitle")}</h3>
        <ErrorMessage state={disabled} />
        <PasswordField id="two-factor-disable-password" />
        <Button type="submit" variant="outline" disabled={disabling}>
          <PendingLabel pending={disabling} idle={t("disable")} busy={t("disabling")} />
        </Button>
      </form>
    </div>
  );
}

export function TwoFactorSection({
  enabled,
  notice,
}: {
  readonly enabled: boolean;
  readonly notice: "enabled" | "disabled" | "adminEnroll" | "adminVerify" | undefined;
}) {
  const t = useTranslations("auth.twoFactor");
  return (
    <section
      className="space-y-6 border-t pt-8"
      aria-labelledby="two-factor-title"
      data-testid="two-factor-section"
    >
      <h2 id="two-factor-title" className="text-xl font-semibold">
        {t("title")}
      </h2>
      {notice === undefined ? null : (
        <FormMessage tone="status" testId={`two-factor-notice-${notice}`}>
          <p>{t(notice)}</p>
        </FormMessage>
      )}
      <p className="text-sm text-muted-foreground" data-testid="two-factor-status">
        {enabled ? t("statusOn") : t("statusOff")}
      </p>
      {enabled ? <Manage /> : <Enroll />}
    </section>
  );
}
