"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { LOCALES } from "@/i18n/config";

import { submitCreateWorkspace, type CreateWorkspaceFormState } from "./actions";

const inputClass =
  "h-10 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive";

export function CreateWorkspaceForm() {
  const locale = useLocale();
  const t = useTranslations("workspaces.new");
  const tLanguage = useTranslations("common.language");
  const tRoot = useTranslations();
  const [state, formAction, pending] = useActionState<CreateWorkspaceFormState, FormData>(
    submitCreateWorkspace.bind(null, locale),
    null,
  );

  const fieldError = (path: string): string | undefined => {
    const field = state?.error.fields?.find((candidate) => candidate.path === path);
    if (field === undefined) return undefined;
    const key = `validation.${field.code}`;
    return tRoot.has(key as never)
      ? tRoot(key as never, field.params as never)
      : tRoot("validation.invalid");
  };
  const nameError = fieldError("name");
  const slugError = fieldError("slug");
  const localeError = fieldError("defaultLocale");
  const formError =
    state !== null &&
    nameError === undefined &&
    slugError === undefined &&
    localeError === undefined
      ? tRoot(state.error.messageKey)
      : undefined;
  const values = state?.values;

  return (
    <form action={formAction} className="space-y-6" data-testid="create-workspace-form">
      {formError === undefined ? null : (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {formError}
        </p>
      )}

      <div className="space-y-2">
        <label htmlFor="workspace-name" className="block text-sm font-medium">
          {t("name")}
        </label>
        <input
          id="workspace-name"
          name="name"
          type="text"
          required
          maxLength={120}
          autoComplete="organization"
          defaultValue={values?.name}
          aria-invalid={nameError === undefined ? undefined : true}
          aria-describedby={nameError === undefined ? undefined : "workspace-name-error"}
          className={inputClass}
        />
        {nameError === undefined ? null : (
          <p id="workspace-name-error" className="text-sm text-destructive">
            {nameError}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor="workspace-slug" className="block text-sm font-medium">
          {t("slug")}
        </label>
        <input
          id="workspace-slug"
          name="slug"
          type="text"
          dir="ltr"
          required
          minLength={3}
          maxLength={48}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={values?.slug}
          aria-invalid={slugError === undefined ? undefined : true}
          aria-describedby="workspace-slug-hint workspace-slug-error"
          className={inputClass}
        />
        <p id="workspace-slug-hint" className="text-sm text-muted-foreground">
          {t("slugHint")}
        </p>
        {slugError === undefined ? null : (
          <p id="workspace-slug-error" className="text-sm text-destructive">
            {slugError}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor="workspace-locale" className="block text-sm font-medium">
          {t("defaultLocale")}
        </label>
        <select
          id="workspace-locale"
          name="defaultLocale"
          defaultValue={values?.defaultLocale ?? locale}
          aria-invalid={localeError === undefined ? undefined : true}
          className={inputClass}
        >
          {LOCALES.map((candidate) => (
            <option key={candidate} value={candidate} lang={candidate}>
              {tLanguage(`names.${candidate}`)}
            </option>
          ))}
        </select>
        {localeError === undefined ? null : (
          <p className="text-sm text-destructive">{localeError}</p>
        )}
      </div>

      <Button type="submit" disabled={pending} data-testid="create-workspace-submit">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
