"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import type { ErrorResponseBody } from "@/server/errors/http";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  leaveWorkspaceAction,
  removeMemberAction,
  revokeInvitationAction,
} from "@/server/workspaces/member-actions";

// Form entry points for /{locale}/w/{slug}/members. Only the named fields are read from
// each form; the slug comes from the page URL and is resolved against the session
// user's memberships by `requireWorkspaceAccess` — it is never authority by itself.

export type ActionError = ErrorResponseBody["error"];

/** State of a small form (role change, remove, revoke, leave): idle, done or an error. */
export type SimpleFormState = { readonly error: ActionError } | { readonly done: true } | null;

export type InviteFormState =
  | {
      readonly error: ActionError;
      readonly values: { readonly email: string; readonly role: string };
    }
  | {
      readonly created: {
        readonly email: string;
        readonly acceptUrl: string;
        readonly delivery:
          | { readonly status: "sent" }
          | {
              readonly status: "not_sent";
              readonly reason: "development" | "not_configured" | "failed";
            };
      };
    }
  | null;

const text = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : "");
const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const membersPath = (locale: string, slug: string) =>
  `/${toLocale(locale)}/w/${encodeURIComponent(slug)}/members`;

export async function submitInvite(
  slug: string,
  locale: string,
  _previous: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const values = { email: text(formData.get("email")), role: text(formData.get("role")) };
  const result = await inviteMemberAction({ slug, ...values, locale: toLocale(locale) });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(membersPath(locale, slug));
  return {
    created: {
      email: result.data.email,
      acceptUrl: result.data.acceptUrl,
      delivery: result.data.delivery,
    },
  };
}

export async function submitRevokeInvitation(
  slug: string,
  locale: string,
  _previous: SimpleFormState,
  formData: FormData,
): Promise<SimpleFormState> {
  const result = await revokeInvitationAction({
    slug,
    invitationId: text(formData.get("invitationId")),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(membersPath(locale, slug));
  return { done: true };
}

export async function submitChangeRole(
  slug: string,
  locale: string,
  _previous: SimpleFormState,
  formData: FormData,
): Promise<SimpleFormState> {
  const result = await changeMemberRoleAction({
    slug,
    memberId: text(formData.get("memberId")),
    role: text(formData.get("role")),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(membersPath(locale, slug));
  return { done: true };
}

export async function submitRemoveMember(
  slug: string,
  locale: string,
  _previous: SimpleFormState,
  formData: FormData,
): Promise<SimpleFormState> {
  const result = await removeMemberAction({ slug, memberId: text(formData.get("memberId")) });
  if (!result.ok) return { error: result.error };
  revalidatePath(membersPath(locale, slug));
  return { done: true };
}

/** Leaving ends access to this workspace, so the user goes to their workspace list. */
export async function submitLeaveWorkspace(
  slug: string,
  locale: string,
  _previous: SimpleFormState,
): Promise<SimpleFormState> {
  const result = await leaveWorkspaceAction({ slug });
  if (!result.ok) return { error: result.error };
  redirect(`/${toLocale(locale)}/workspaces`);
}
