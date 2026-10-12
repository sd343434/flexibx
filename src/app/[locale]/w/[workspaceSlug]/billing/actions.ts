"use server";

import { revalidatePath } from "next/cache";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { updateCreditSettingsAction } from "@/server/billing/billing-actions";
import { CREDIT_FEATURES } from "@/server/billing/pricing";

import type { MarketingFormState } from "../marketing-actions";

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** Saves the workspace's credit caps and automatic top-up (owners). */
export async function submitCreditSettings(
  slug: string,
  locale: string,
  version: number,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const featureCaps = Object.fromEntries(
    CREDIT_FEATURES.map((feature) => [feature, text(formData, `featureCap_${feature}`)]),
  );
  const values = {
    dailyCap: text(formData, "dailyCap"),
    periodCap: text(formData, "periodCap"),
    autoRechargeThreshold: text(formData, "autoRechargeThreshold"),
    autoRechargeAmount: text(formData, "autoRechargeAmount"),
    autoRechargePeriodMax: text(formData, "autoRechargePeriodMax"),
  };
  const result = await updateCreditSettingsAction({
    slug,
    ...values,
    version: String(version),
    featureCaps,
    autoRechargeEnabled: formData.get("autoRechargeEnabled") === "on",
  });
  if (!result.ok) return { error: result.error, values: { ...values, ...featureCaps } };
  revalidatePath(
    `/${isLocale(locale) ? locale : DEFAULT_LOCALE}/w/${encodeURIComponent(slug)}/billing`,
  );
  return { done: true, at: Date.now() };
}
