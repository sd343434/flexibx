"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { PendingLabel } from "@/components/common/loaders";
import { actionErrorMessage, inputClass, type Option } from "@/components/marketing/entity-form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ImportFormState } from "./actions";

/**
 * The results import form. `batchKey` is fresh for each page render: submitting the same
 * form again (a retry) is recognized by the server and stores nothing twice.
 */
export function ImportForm({
  action,
  campaigns,
  channels,
  batchKey,
  example,
}: {
  readonly action: (state: ImportFormState | null, formData: FormData) => Promise<ImportFormState>;
  readonly campaigns: readonly Option[];
  readonly channels: readonly Option[];
  readonly batchKey: string;
  readonly example: string;
}) {
  const t = useTranslations("marketing.insights");
  const tAll = useTranslations();
  const [state, formAction, pending] = useActionState(action, null);
  const values = state?.values;

  return (
    <form action={formAction} className="space-y-4" data-testid="metrics-import-form" noValidate>
      <input type="hidden" name="batchKey" value={batchKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="metrics-import-campaign" className="block text-sm font-medium">
            {t("importCampaign")}
          </label>
          <select
            id="metrics-import-campaign"
            name="campaignId"
            required
            defaultValue={values?.campaignId ?? campaigns[0]?.value ?? ""}
            className={cn(inputClass, "h-10")}
          >
            {campaigns.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <label htmlFor="metrics-import-channel" className="block text-sm font-medium">
            {t("importChannel")}
          </label>
          <select
            id="metrics-import-channel"
            name="channel"
            defaultValue={values?.channel ?? "FACEBOOK_PAGE"}
            className={cn(inputClass, "h-10")}
          >
            {channels.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <label htmlFor="metrics-import-csv" className="block text-sm font-medium">
            {t("importCsv")}
          </label>
          <textarea
            id="metrics-import-csv"
            name="csv"
            rows={8}
            dir="ltr"
            required
            defaultValue={values?.csv ?? ""}
            aria-describedby="metrics-import-hint"
            className={cn(inputClass, "py-2 font-mono text-xs leading-relaxed")}
          />
          <p id="metrics-import-hint" className="text-xs text-muted-foreground">
            {t("importHint")}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t("importExample")}</summary>
            <pre dir="ltr" className="mt-2 overflow-x-auto rounded-md bg-muted p-3">
              {example}
            </pre>
          </details>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="metrics-import-submit">
          <PendingLabel pending={pending} idle={t("importSubmit")} busy={t("importing")} />
        </Button>
      </div>
      {state?.error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="metrics-import-error">
          {actionErrorMessage(tAll, state.error)}
        </p>
      )}
      {state?.result === undefined ? null : (
        <div role="status" className="space-y-2 text-sm" data-testid="metrics-import-result">
          <p>
            {state.result.repeated
              ? t("importRepeated")
              : t("importResult", {
                  accepted: state.result.accepted,
                  duplicates: state.result.duplicates,
                  rejected: state.result.rejected,
                })}
            {state.result.status === "FAILED" ? ` ${t("importFailed")}` : ""}
          </p>
          {state.result.issues.length === 0 ? null : (
            <ul
              className="list-disc space-y-1 ps-5 text-destructive"
              data-testid="metrics-import-issues"
            >
              {state.result.issues.map((issue) => (
                <li key={`${String(issue.row)}-${issue.code}`}>
                  {t("issueRow", {
                    row: issue.row,
                    problem: t.has(`issue.${issue.code}` as never)
                      ? t(`issue.${issue.code}` as never)
                      : issue.code,
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
