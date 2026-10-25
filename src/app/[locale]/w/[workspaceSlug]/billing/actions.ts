"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { startCheckoutAction, updateCreditSettingsAction } from "@/server/billing/billing-actions";
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

/**
 * Opens the card payment page for one credit package (owners). Only the package id and the
 * form's one-time request key go to the server; on success the browser is sent to the
 * provider's hosted page, otherwise back here with the reason.
 */
export async function submitCheckout(
  slug: string,
  locale: string,
  packageId: string,
  requestKey: string,
): Promise<void> {
  const safeLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const result = await startCheckoutAction({ slug, locale: safeLocale, packageId, requestKey });
  if (!result.ok) {
    const reason = result.error.fields?.[0]?.code ?? "payments_checkout_failed";
    redirect(
      `/${safeLocale}/w/${encodeURIComponent(slug)}/billing?checkout=error&reason=${encodeURIComponent(reason)}`,
    );
  }
  // The provider's hosted page (checked to be https on stripe.com by the adapter).
  redirect(result.data.redirectUrl);
}
