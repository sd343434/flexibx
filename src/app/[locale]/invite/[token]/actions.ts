"use server";

import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import type { ErrorResponseBody } from "@/server/errors/http";
import { acceptInvitationAction } from "@/server/workspaces/member-actions";

export type AcceptFormState = { readonly error: ErrorResponseBody["error"] } | null;

/**
 * Accepts the invitation in the form for the signed-in user (the user comes from the
 * session only) and opens the workspace in the same locale.
 */
export async function submitAcceptInvitation(
  locale: string,
  _previous: AcceptFormState,
  formData: FormData,
): Promise<AcceptFormState> {
  const token = formData.get("token");
  const result = await acceptInvitationAction({ token: typeof token === "string" ? token : "" });
  if (!result.ok) return { error: result.error };
  redirect(
    `/${isLocale(locale) ? locale : DEFAULT_LOCALE}/w/${encodeURIComponent(result.data.slug)}`,
  );
}
