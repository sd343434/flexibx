"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  ActionError,
  FormValues,
  MarketingFormState,
} from "@/app/[locale]/w/[workspaceSlug]/marketing-actions";

// Generic forms for the Marketing Core pages. They collect input and display results;
// every rule (who may do what, which values are valid) is decided on the server.

export type FormAction = (
  state: MarketingFormState,
  formData: FormData,
) => Promise<MarketingFormState>;

export interface Option {
  readonly value: string;
  readonly label: string;
}

interface FieldBase {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  /** Full width in a two-column grid. */
  readonly wide?: boolean;
}

export type FieldSpec =
  | (FieldBase & {
      readonly kind: "text" | "url" | "date" | "datetime" | "number";
      readonly defaultValue?: string;
      readonly maxLength?: number;
      readonly dir?: "ltr" | "auto";
      readonly placeholder?: string;
    })
  | (FieldBase & {
      readonly kind: "textarea";
      readonly defaultValue?: string;
      readonly maxLength?: number;
      readonly rows?: number;
    })
  | (FieldBase & {
      readonly kind: "select";
      readonly options: readonly Option[];
      readonly defaultValue?: string;
      /** Label of an empty "none" choice; omitted = a value is required. */
      readonly emptyLabel?: string;
    })
  | (FieldBase & {
      readonly kind: "multiselect";
      readonly options: readonly Option[];
      readonly defaultValue?: readonly string[];
      readonly emptyLabel: string;
    })
  | (FieldBase & { readonly kind: "checkbox"; readonly defaultChecked?: boolean });

export const inputClass =
  "w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive disabled:opacity-70";

type Translator = ReturnType<typeof useTranslations<never>>;

/** The translated message for a field code (`validation.<code>`), or the generic one. */
function fieldMessage(t: Translator, code: string, params: unknown): string {
  const key = `validation.${code}`;
  return t.has(key as never) ? t(key as never, params as never) : t("validation.invalid" as never);
}

/**
 * The message for a rejected action: the first field code with a translation (domain
 * codes such as `invalid_transition`), otherwise the generic message for the error code.
 */
export function actionErrorMessage(t: Translator, error: ActionError): string {
  for (const field of error.fields ?? []) {
    const key = `validation.${field.code}`;
    if (t.has(key as never)) return t(key as never, field.params as never);
  }
  return t(error.messageKey as never);
}

function errorsByField(state: MarketingFormState): Map<string, { code: string; params: unknown }> {
  const map = new Map<string, { code: string; params: unknown }>();
  if (state === null || !("error" in state)) return map;
  for (const field of state.error.fields ?? []) {
    const name = field.path.split(".")[0] ?? "";
    if (!map.has(name)) map.set(name, { code: field.code, params: field.params });
  }
  return map;
}

function valueOf(values: FormValues | undefined, name: string): string | undefined {
  const value = values?.[name];
  return typeof value === "string" ? value : undefined;
}

function Field({
  spec,
  id,
  values,
  error,
}: {
  readonly spec: FieldSpec;
  readonly id: string;
  readonly values: FormValues | undefined;
  readonly error: string | undefined;
}) {
  const describedBy =
    [error === undefined ? null : `${id}-error`, spec.hint === undefined ? null : `${id}-hint`]
      .filter((value) => value !== null)
      .join(" ") || undefined;
  const common = {
    id,
    name: spec.name,
    "aria-invalid": error === undefined ? undefined : true,
    "aria-describedby": describedBy,
  } as const;

  let control: ReactNode;
  switch (spec.kind) {
    case "textarea":
      control = (
        <textarea
          {...common}
          rows={spec.rows ?? 4}
          maxLength={spec.maxLength}
          required={spec.required}
          defaultValue={valueOf(values, spec.name) ?? spec.defaultValue}
          className={cn(inputClass, "py-2 leading-relaxed")}
        />
      );
      break;
    case "select":
      control = (
        <select
          {...common}
          required={spec.required}
          defaultValue={valueOf(values, spec.name) ?? spec.defaultValue ?? ""}
          className={cn(inputClass, "h-10")}
        >
          {spec.emptyLabel === undefined ? null : <option value="">{spec.emptyLabel}</option>}
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
    case "multiselect": {
      const submitted = values?.[spec.name];
      const selected = Array.isArray(submitted) ? submitted : (spec.defaultValue ?? []);
      control =
        spec.options.length === 0 ? (
          <p className="text-sm text-muted-foreground" id={id}>
            {spec.emptyLabel}
          </p>
        ) : (
          <div
            role="group"
            aria-labelledby={`${id}-label`}
            aria-describedby={describedBy}
            className="flex flex-wrap gap-2"
          >
            {spec.options.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="checkbox"
                  name={spec.name}
                  value={option.value}
                  defaultChecked={selected.includes(option.value)}
                  className="size-4 accent-[var(--primary)]"
                />
                {option.label}
              </label>
            ))}
          </div>
        );
      break;
    }
    case "checkbox":
      control = (
        <input
          {...common}
          type="checkbox"
          defaultChecked={
            valueOf(values, spec.name) === undefined
              ? spec.defaultChecked
              : valueOf(values, spec.name) === "on"
          }
          className="size-4 accent-[var(--primary)]"
        />
      );
      break;
    case "text":
    case "url":
    case "date":
    case "datetime":
    case "number":
      control = (
        <input
          {...common}
          type={
            spec.kind === "datetime"
              ? "datetime-local"
              : spec.kind === "number"
                ? "text"
                : spec.kind
          }
          inputMode={spec.kind === "number" ? "decimal" : undefined}
          dir={spec.dir ?? (spec.kind === "text" ? "auto" : "ltr")}
          maxLength={spec.maxLength}
          required={spec.required}
          placeholder={spec.placeholder}
          defaultValue={valueOf(values, spec.name) ?? spec.defaultValue}
          className={cn(inputClass, "h-10")}
        />
      );
  }

  return (
    <div
      className={cn(
        "space-y-2",
        spec.wide === true && "sm:col-span-2",
        spec.kind === "checkbox" &&
          "flex flex-row-reverse items-center justify-end gap-2 space-y-0",
      )}
    >
      <label
        id={`${id}-label`}
        htmlFor={spec.kind === "multiselect" ? undefined : id}
        className="block text-sm font-medium"
      >
        {spec.label}
        {spec.required === true ? (
          <span aria-hidden="true" className="ms-1 text-destructive">
            *
          </span>
        ) : null}
      </label>
      {control}
      {spec.hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {spec.hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export interface EntityFormProps {
  readonly action: FormAction;
  readonly fields: readonly FieldSpec[];
  readonly submitLabel: string;
  readonly testId: string;
  /** Show the fields without a submit button (the role may only view). */
  readonly readOnly?: boolean;
  readonly children?: ReactNode;
}

/** A labelled, accessible form for one record, with per-field server errors. */
export function EntityForm({
  action,
  fields,
  submitLabel,
  testId,
  readOnly = false,
  children,
}: EntityFormProps) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<MarketingFormState, FormData>(action, null);
  const errors = errorsByField(state);
  const values = state !== null && "values" in state ? state.values : undefined;
  const known = new Set(fields.map((field) => field.name));
  const unplaced =
    state !== null && "error" in state
      ? (state.error.fields ?? []).length === 0 ||
        (state.error.fields ?? []).some((field) => !known.has(field.path.split(".")[0] ?? ""))
      : false;

  return (
    <form action={formAction} className="space-y-6" data-testid={testId} noValidate>
      <fieldset disabled={readOnly || pending} className="grid gap-5 sm:grid-cols-2">
        {fields.map((spec) => {
          const fieldError = errors.get(spec.name);
          return (
            <Field
              key={spec.name}
              spec={spec}
              id={`${testId}-${spec.name}`}
              values={values}
              error={
                fieldError === undefined
                  ? undefined
                  : fieldMessage(t, fieldError.code, fieldError.params)
              }
            />
          );
        })}
      </fieldset>
      {children}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending} data-testid={`${testId}-submit`}>
            {pending ? t("marketing.common.saving") : submitLabel}
          </Button>
          {state !== null && "done" in state ? (
            <p
              role="status"
              className="flex items-center gap-1 text-sm text-muted-foreground"
              data-testid="form-saved"
            >
              <Check aria-hidden="true" className="size-4" />
              {t("marketing.common.saved")}
            </p>
          ) : null}
          {state !== null && "error" in state && unplaced ? (
            <p role="alert" className="text-sm text-destructive" data-testid="form-error">
              {actionErrorMessage(t, state.error)}
            </p>
          ) : null}
          {state !== null && "error" in state && !unplaced ? (
            <p role="alert" className="text-sm text-destructive" data-testid="form-error">
              {t(state.error.messageKey as never)}
            </p>
          ) : null}
        </div>
      )}
    </form>
  );
}

/**
 * A one-button form (status change, move, delete). With `confirm`, the first click asks
 * for confirmation in place. Optional extra fields (e.g. a date) can be passed as children.
 */
export function ActionButton({
  action,
  label,
  confirm,
  variant = "outline",
  danger = false,
  testId,
  children,
}: {
  readonly action: FormAction;
  readonly label: string;
  readonly confirm?: string | undefined;
  readonly variant?: "default" | "outline" | "ghost";
  readonly danger?: boolean;
  readonly testId?: string | undefined;
  readonly children?: ReactNode;
}) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<MarketingFormState, FormData>(action, null);
  const [asking, setAsking] = useState(false);
  const dangerClass = danger ? "border-destructive text-destructive hover:bg-destructive/10" : "";

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2" data-testid={testId}>
      {children}
      {confirm !== undefined && !asking ? (
        <Button
          type="button"
          size="sm"
          variant={variant}
          className={dangerClass}
          onClick={() => {
            setAsking(true);
          }}
        >
          {label}
        </Button>
      ) : (
        <>
          {confirm === undefined ? null : <span className="text-sm">{confirm}</span>}
          <Button
            type="submit"
            size="sm"
            variant={variant}
            className={dangerClass}
            disabled={pending}
            data-testid={testId === undefined ? undefined : `${testId}-submit`}
          >
            {pending
              ? t("marketing.common.working")
              : confirm === undefined
                ? label
                : t("marketing.common.confirm")}
          </Button>
          {confirm === undefined ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAsking(false);
              }}
            >
              {t("marketing.common.cancel")}
            </Button>
          )}
        </>
      )}
      {state !== null && "error" in state ? (
        <p role="alert" className="basis-full text-sm text-destructive" data-testid="action-error">
          {actionErrorMessage(t, state.error)}
        </p>
      ) : null}
    </form>
  );
}
