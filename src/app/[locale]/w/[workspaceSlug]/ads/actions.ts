"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import {
  createAdPlanAction,
  disconnectAction,
  discardAdPlanAction,
  refreshAccountsAction,
  reopenAdPlanAction,
  refreshPlanIdentitiesAction,
  requestActivationAction,
  selectPlanIdentityAction,
  selectAccountAction,
  setSpendLimitAction,
  startConnectionAction,
  submitAdPlanAction,
  syncAccountAction,
  updateAdPlanAction,
} from "@/server/ads/ads-actions";

import type { MarketingFormState } from "../marketing-actions";

// Form entry points for the advertising area. Each forwards only the fields it names;
// the slug selects one of the session user's memberships. What may be connected, read,
// planned or launched is decided on the server only.

type Platform = "META" | "SNAPCHAT" | "TIKTOK" | "WHATSAPP";

const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const adsPath = (locale: string, slug: string) =>
  `/${toLocale(locale)}/w/${encodeURIComponent(slug)}/ads`;
/** Connections are managed on the Integrations page. */
const integrationsPath = (locale: string, slug: string) =>
  `/${toLocale(locale)}/w/${encodeURIComponent(slug)}/integrations`;
const planPath = (locale: string, slug: string, planId: string) =>
  `${adsPath(locale, slug)}/plans/${encodeURIComponent(planId)}`;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function back(path: string): never {
  revalidatePath(path);
  redirect(path);
}

export async function submitConnect(
  slug: string,
  locale: string,
  platform: Platform,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await startConnectionAction({
    slug,
    platform,
    locale: toLocale(locale) === "en" ? "en" : "ar",
  });
  if (!result.ok) return { error: result.error, values: {} };
  // The platform's own consent screen (an absolute https URL built by the adapter).
  redirect(result.data.url);
}

export async function submitDisconnect(
  slug: string,
  locale: string,
  platform: Platform,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await disconnectAction({ slug, platform });
  if (!result.ok) return { error: result.error, values: {} };
  back(integrationsPath(locale, slug));
}

export async function submitRefreshAccounts(
  slug: string,
  locale: string,
  platform: Platform,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await refreshAccountsAction({ slug, platform });
  if (!result.ok) return { error: result.error, values: {} };
  back(integrationsPath(locale, slug));
}

export async function submitSelectAccount(
  slug: string,
  locale: string,
  accountId: string,
  selected: boolean,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await selectAccountAction({ slug, accountId, selected });
  if (!result.ok) return { error: result.error, values: {} };
  back(adsPath(locale, slug));
}

export async function submitSyncAccount(
  slug: string,
  locale: string,
  accountId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await syncAccountAction({ slug, accountId });
  if (!result.ok) return { error: result.error, values: {} };
  back(adsPath(locale, slug));
}

export async function submitCreatePlan(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    accountId: text(formData, "accountId"),
    budget: text(formData, "budget"),
    startDate: text(formData, "startDate"),
    endDate: text(formData, "endDate"),
    request: text(formData, "request"),
    destinationUrl: text(formData, "destinationUrl"),
  };
  const result = await createAdPlanAction({
    slug,
    uiLocale: toLocale(locale) === "en" ? "en" : "ar",
    ...values,
  });
  if (!result.ok) return { error: result.error, values };
  back(planPath(locale, slug, result.data.planId));
}

export async function submitUpdatePlan(
  slug: string,
  locale: string,
  planId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    budget: text(formData, "budget"),
    startDate: text(formData, "startDate"),
    endDate: text(formData, "endDate"),
    campaignName: text(formData, "campaignName"),
    headline: text(formData, "headline"),
    primaryText: text(formData, "primaryText"),
    destinationUrl: text(formData, "destinationUrl"),
  };
  const placements = formData
    .getAll("placements")
    .filter((v): v is string => typeof v === "string");
  const result = await updateAdPlanAction({
    slug,
    planId,
    ...values,
    ...(placements.length === 0 ? {} : { placements }),
  });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(planPath(locale, slug, planId));
  return { done: true, at: Date.now() };
}

export async function submitPlanCommand(
  slug: string,
  locale: string,
  planId: string,
  command: "discard" | "submit" | "reopen" | "activate" | "identities",
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const input = { slug, planId };
  const result =
    command === "discard"
      ? await discardAdPlanAction(input)
      : command === "submit"
        ? await submitAdPlanAction(input)
        : command === "activate"
          ? await requestActivationAction(input)
          : command === "identities"
            ? await refreshPlanIdentitiesAction(input)
            : await reopenAdPlanAction(input);
  if (!result.ok) return { error: result.error, values: {} };
  back(command === "discard" ? adsPath(locale, slug) : planPath(locale, slug, planId));
}

export async function submitSpendLimit(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    currency: text(formData, "currency"),
    maxPlanBudget: text(formData, "maxPlanBudget"),
    maxDailyBudget: text(formData, "maxDailyBudget"),
  };
  const result = await setSpendLimitAction({ slug, ...values });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(adsPath(locale, slug));
  return { done: true, at: Date.now() };
}

export async function submitSelectIdentity(
  slug: string,
  locale: string,
  planId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = { identityId: text(formData, "identityId") };
  const result = await selectPlanIdentityAction({ slug, planId, ...values });
  if (!result.ok) return { error: result.error, values };
  back(planPath(locale, slug, planId));
}
