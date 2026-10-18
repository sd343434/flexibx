"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { PendingLabel } from "@/components/common/loaders";
import {
  actionErrorMessage,
  inputClass,
  type FormAction,
} from "@/components/marketing/entity-form";
import { Button } from "@/components/ui/button";

import type { MarketingFormState } from "../marketing-actions";

import { formatTimestamp, secondsInput } from "./time-format";

/** One subtitle line: shown as text, edited in place (text and timing) by editors. */
export function SegmentRow({
  action,
  startMs,
  endMs,
  text,
  edited,
  canEdit,
  dir,
}: {
  readonly action: FormAction;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly edited: boolean;
  readonly canEdit: boolean;
  readonly dir: "rtl" | "ltr" | "auto";
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  // A successful save closes the editor (the page re-reads the saved line).
  const [state, formAction, pending] = useActionState<MarketingFormState, FormData>(
    async (previous: MarketingFormState, formData: FormData) => {
      const next = await action(previous, formData);
      if (next !== null && "done" in next) setEditing(false);
      return next;
    },
    null,
  );
  const time = (
    <span className="font-mono text-xs whitespace-nowrap text-muted-foreground" dir="ltr">
      {formatTimestamp(startMs)} → {formatTimestamp(endMs)}
    </span>
  );

  if (!editing) {
    return (
      <li
        className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-4"
        data-testid="studio-segment"
      >
        {time}
        <p className="flex-1 text-sm" dir={dir}>
          {text}
          {edited ? (
            <span className="ms-2 text-xs text-muted-foreground">
              ({t("studio.transcript.edited")})
            </span>
          ) : null}
        </p>
        {canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(true);
            }}
            data-testid="studio-segment-edit"
          >
            {t("studio.transcript.edit")}
          </Button>
        ) : null}
      </li>
    );
  }

  const values = state !== null && "values" in state ? state.values : undefined;
  const value = (name: string, fallback: string) => {
    const submitted = values?.[name];
    return typeof submitted === "string" ? submitted : fallback;
  };
  return (
    <li className="py-2">
      <form action={formAction} className="space-y-2" data-testid="studio-segment-form">
        <div className="flex flex-wrap gap-2">
          <label className="text-xs">
            {t("studio.time.start")}
            <input
              name="start"
              inputMode="decimal"
              dir="ltr"
              defaultValue={value("start", secondsInput(startMs))}
              className={`${inputClass} h-8 w-28`}
            />
          </label>
          <label className="text-xs">
            {t("studio.time.end")}
            <input
              name="end"
              inputMode="decimal"
              dir="ltr"
              defaultValue={value("end", secondsInput(endMs))}
              className={`${inputClass} h-8 w-28`}
            />
          </label>
        </div>
        <textarea
          name="text"
          rows={2}
          maxLength={2000}
          dir={dir}
          defaultValue={value("text", text)}
          aria-label={t("studio.transcript.text")}
          className={`${inputClass} py-2`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            <PendingLabel
              pending={pending}
              idle={t("studio.common.save")}
              busy={t("studio.common.saving")}
            />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
            }}
          >
            {t("studio.common.cancel")}
          </Button>
        </div>
        {state !== null && "error" in state ? (
          <p role="alert" className="text-sm text-destructive">
            {actionErrorMessage(t, state.error)}
          </p>
        ) : null}
      </form>
    </li>
  );
}
