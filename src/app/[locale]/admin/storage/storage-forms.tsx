"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { PendingLabel } from "@/components/common/loaders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { FormMessage } from "../../(auth)/form-message";

import {
  submitConnectionCheck,
  submitWasabiSettings,
  submitWriteProvider,
  type ConnectionFormState,
  type StorageProviderId,
  type WasabiFormState,
  type WriteProviderFormState,
} from "./actions";

/** Wasabi's non-secret settings. Access keys are never part of this form. */
export function WasabiSettingsForm({
  defaults,
  locked,
}: {
  readonly defaults: {
    readonly region: string;
    readonly endpoint: string;
    readonly bucket: string;
  };
  readonly locked: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("admin.storage.wasabi");
  const tAdmin = useTranslations("admin");
  const [state, formAction, pending] = useActionState<WasabiFormState, FormData>(
    submitWasabiSettings.bind(null, locale),
    null,
  );
  const fieldError = (name: string) => {
    if (state?.status !== "error") return undefined;
    const code = state.fields?.find((field) => field.path === name)?.code;
    if (code === undefined) return undefined;
    return t.has(`errors.${code}` as never) ? t(`errors.${code}` as never) : t("errors.invalid");
  };
  const field = (name: "region" | "endpoint" | "bucket", hint?: string) => {
    const error = fieldError(name);
    return (
      <div className="space-y-1">
        <label htmlFor={`wasabi-${name}`} className="block text-sm font-medium">
          {t(name)}
        </label>
        <Input
          id={`wasabi-${name}`}
          name={name}
          dir="ltr"
          required
          defaultValue={defaults[name]}
          disabled={locked}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={hint === undefined ? undefined : `wasabi-${name}-hint`}
          autoComplete="off"
          spellCheck={false}
        />
        {hint === undefined ? null : (
          <p id={`wasabi-${name}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        {error === undefined ? null : <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  };

  return (
    <form action={formAction} className="space-y-4" data-testid="wasabi-settings-form">
      {state === null || state.status === "error" ? null : (
        <FormMessage tone={state.status === "locked" ? "error" : "status"} testId="wasabi-result">
          <p>{t(state.status)}</p>
        </FormMessage>
      )}
      {state?.status === "error" && state.fields === undefined ? (
        <FormMessage tone="error" testId="wasabi-result">
          <p>{tAdmin("error")}</p>
        </FormMessage>
      ) : null}
      {field("region", t("regionHint"))}
      {field("endpoint", t("endpointHint"))}
      {field("bucket")}
      <Button type="submit" disabled={pending || locked} data-testid="wasabi-save">
        <PendingLabel pending={pending} idle={t("save")} busy={t("saving")} />
      </Button>
    </form>
  );
}

/** A live, read-only connection test run on the server. */
export function ConnectionCheckButton({ provider }: { readonly provider: StorageProviderId }) {
  const t = useTranslations("admin.storage.check");
  const tAdmin = useTranslations("admin");
  const [state, formAction, pending] = useActionState<ConnectionFormState, FormData>(
    submitConnectionCheck,
    null,
  );
  return (
    <form action={formAction} className="space-y-2" data-testid={`check-${provider}`}>
      <input type="hidden" name="provider" value={provider} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        <PendingLabel pending={pending} idle={t("button")} busy={t("checking")} surface="plain" />
      </Button>
      {state === null ? null : "error" in state ? (
        <p className="text-sm text-destructive" role="status">
          {tAdmin("error")}
        </p>
      ) : (
        <p
          className={state.check.ok ? "text-sm" : "text-sm text-destructive"}
          role="status"
          data-testid={`check-${provider}-result`}
        >
          {state.check.ok ? t("ok") : t(`failure.${state.check.failure}`)}
        </p>
      )}
    </form>
  );
}

/** Changes where NEW files go, after a typed confirmation and server-side checks. */
export function ChangeWriteProviderForm({
  current,
  options,
}: {
  readonly current: StorageProviderId;
  readonly options: readonly { readonly id: StorageProviderId; readonly ready: boolean }[];
}) {
  const locale = useLocale();
  const t = useTranslations("admin.storage.change");
  const tStorage = useTranslations("admin.storage");
  const tAdmin = useTranslations("admin");
  const choices = options.filter((option) => option.id !== current);
  // Not remounted when the page refreshes after a change, so the result (and any warning
  // about files left on an unavailable provider) stays visible; the selection follows the
  // new list of choices.
  const [selected, setTarget] = useState<StorageProviderId | undefined>(choices[0]?.id);
  const target = choices.some((option) => option.id === selected) ? selected : choices[0]?.id;
  const [state, formAction, pending] = useActionState<WriteProviderFormState, FormData>(
    submitWriteProvider.bind(null, locale),
    null,
  );
  if (target === undefined) return null;
  const ready = choices.find((option) => option.id === target)?.ready === true;
  const name = (id: StorageProviderId) => tStorage(`providers.${id}`);

  let message: string | null = null;
  if (state !== null) {
    switch (state.status) {
      case "changed":
        message = t("changed", { provider: name(state.provider) });
        break;
      case "unavailable":
        message = t("unavailable", {
          provider: name(state.provider),
          reason: tStorage(`check.failure.${state.failure}`),
        });
        break;
      case "error":
        message =
          state.fields?.some((field) => field.code === "confirmation_mismatch") === true
            ? t("confirmation_mismatch")
            : tAdmin("error");
        break;
      case "unchanged":
      case "stale":
        message = t(state.status);
    }
  }

  return (
    <form action={formAction} className="space-y-4" data-testid="write-provider-form">
      <p className="text-sm text-muted-foreground">{t("explain")}</p>
      {message === null ? null : (
        <FormMessage
          tone={state?.status === "changed" || state?.status === "unchanged" ? "status" : "error"}
          testId="write-provider-result"
        >
          <p>{message}</p>
        </FormMessage>
      )}
      {state?.status === "changed" && state.warnings.length > 0 ? (
        <FormMessage tone="error" testId="write-provider-warnings">
          {state.warnings.map((warning) => (
            <p key={warning.provider}>
              {t("leftBehind", {
                provider: name(warning.provider),
                reason: tStorage(`check.failure.${warning.failure}`),
              })}
            </p>
          ))}
        </FormMessage>
      ) : null}
      <div className="space-y-1">
        <label htmlFor="write-provider-target" className="block text-sm font-medium">
          {t("target")}
        </label>
        <select
          id="write-provider-target"
          name="target"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value as StorageProviderId);
          }}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        >
          {choices.map((option) => (
            <option key={option.id} value={option.id}>
              {name(option.id)}
            </option>
          ))}
        </select>
        {ready ? null : <p className="text-sm text-muted-foreground">{t("notReady")}</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor="write-provider-confirmation" className="block text-sm font-medium">
          {t("confirm", { provider: target })}
        </label>
        <Input
          id="write-provider-confirmation"
          name="confirmation"
          dir="ltr"
          required
          autoComplete="off"
          spellCheck={false}
          disabled={!ready}
        />
      </div>
      <Button type="submit" disabled={pending || !ready} data-testid="write-provider-submit">
        <PendingLabel pending={pending} idle={t("button")} busy={t("changing")} />
      </Button>
    </form>
  );
}
