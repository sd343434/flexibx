"use server";

import { revalidatePath } from "next/cache";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { addCreditsAdminAction, changePlanAdminAction } from "@/server/admin/credits-admin-actions";

import type { MarketingFormState } from "../../w/[workspaceSlug]/marketing-actions";

// Form adapters for the platform admin credits page (authorization is in the actions).

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const page = (locale: string) => `/${isLocale(locale) ? locale : DEFAULT_LOCALE}/admin/credits`;

export async function submitAddCredits(
  locale: string,
  workspaceId: string,
  requestKey: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    kind: text(formData, "kind"),
    amount: text(formData, "amount"),
    externalRef: text(formData, "externalRef"),
    note: text(formData, "note"),
  };
  const result = await addCreditsAdminAction({ workspaceId, requestKey, ...values });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(page(locale));
  return { done: true, at: Date.now() };
}

export async function submitChangePlan(
  locale: string,
  workspaceId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = { planCode: text(formData, "planCode") };
  const result = await changePlanAdminAction({ workspaceId, ...values });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(page(locale));
  return { done: true, at: Date.now() };
}
