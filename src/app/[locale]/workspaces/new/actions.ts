"use server";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { redirect } from "@/i18n/navigation";
import type { ErrorResponseBody } from "@/server/errors/http";
import { createWorkspaceAction } from "@/server/workspaces/workspace-actions";

export interface CreateWorkspaceFormValues {
  readonly name: string;
  readonly slug: string;
  readonly defaultLocale: string;
}

/** Form state after a rejected submission: the code-only error and what the user typed. */
export type CreateWorkspaceFormState = {
  readonly error: ErrorResponseBody["error"];
  readonly values: CreateWorkspaceFormValues;
} | null;

const text = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : "");

/**
 * Form entry point for `/{locale}/workspaces/new`. Only the three user-content fields are
 * read from the form; anything else a client posts (type, owner, role, user id) is never
 * forwarded. On success the user is sent into the new workspace; `locale` only picks
 * the URL prefix of that redirect.
 */
export async function submitCreateWorkspace(
  locale: string,
  _previous: CreateWorkspaceFormState,
  formData: FormData,
): Promise<CreateWorkspaceFormState> {
  const values: CreateWorkspaceFormValues = {
    name: text(formData.get("name")),
    slug: text(formData.get("slug")),
    defaultLocale: text(formData.get("defaultLocale")),
  };
  const result = await createWorkspaceAction(values);
  if (!result.ok) return { error: result.error, values };
  return redirect({
    href: `/w/${result.data.slug}`,
    locale: isLocale(locale) ? locale : DEFAULT_LOCALE,
  });
}
