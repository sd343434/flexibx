"use server";

import { revalidatePath } from "next/cache";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import type { ErrorResponseBody } from "@/server/errors/http";
import {
  actOnRecommendationAction,
  decideRecommendationAction,
  disableInsightsSourceAction,
  enableInsightsSourceAction,
  importMetricsAction,
  syncInsightsSourceAction,
  voidImportAction,
} from "@/server/intelligence/intelligence-actions";

import type { MarketingFormState } from "../marketing-actions";

// Form entry points of the insights page. The slug, ids, fingerprint and version are
// bound by the page; none is authority — the server action resolves the workspace from
// the session's membership and the service re-checks the role, workspace and version.

export interface ImportFormState {
  readonly error?: ErrorResponseBody["error"];
  readonly result?: {
    readonly accepted: number;
    readonly duplicates: number;
    readonly rejected: number;
    readonly repeated: boolean;
    readonly status: string;
    readonly issues: readonly { readonly row: number; readonly code: string }[];
  };
  readonly values?: { readonly campaignId: string; readonly channel: string; readonly csv: string };
}

function refresh(locale: string, slug: string) {
  const prefix = isLocale(locale) ? locale : DEFAULT_LOCALE;
  revalidatePath(`/${prefix}/w/${encodeURIComponent(slug)}`, "layout");
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export async function submitMetricsImport(
  slug: string,
  locale: string,
  _previous: ImportFormState | null,
  formData: FormData,
): Promise<ImportFormState> {
  const values = {
    campaignId: text(formData, "campaignId"),
    channel: text(formData, "channel"),
    csv: text(formData, "csv"),
  };
  const result = await importMetricsAction({
    slug,
    ...values,
    batchKey: text(formData, "batchKey"),
  });
  if (!result.ok) return { error: result.error, values };
  refresh(locale, slug);
  return { result: result.data };
}

export async function submitVoidImport(
  slug: string,
  locale: string,
  importId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  const result = await voidImportAction({ slug, importId });
  if (!result.ok) return { error: result.error, values: {} };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}

export async function submitRecommendationDecision(
  slug: string,
  locale: string,
  fingerprint: string,
  version: number,
  action: "review" | "reopen" | "dismiss" | "snooze",
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = { reason: text(formData, "reason"), days: text(formData, "days") };
  const input =
    action === "dismiss"
      ? { slug, fingerprint, version, action, reason: values.reason }
      : action === "snooze"
        ? { slug, fingerprint, version, action, days: values.days }
        : { slug, fingerprint, version, action };
  const result = await decideRecommendationAction(input);
  if (!result.ok) return { error: result.error, values };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}

export async function submitRecommendationDraft(
  slug: string,
  locale: string,
  fingerprint: string,
  version: number,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  const result = await actOnRecommendationAction({ slug, fingerprint, version });
  if (!result.ok) return { error: result.error, values: {} };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}

/** Starts reading a Meta channel's insights (the server checks the grant's permissions). */
export async function submitEnableSource(
  slug: string,
  locale: string,
  channelId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  const result = await enableInsightsSourceAction({ slug, channelId });
  if (!result.ok) return { error: result.error, values: {} };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}

export async function submitDisableSource(
  slug: string,
  locale: string,
  sourceId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  const result = await disableInsightsSourceAction({ slug, sourceId });
  if (!result.ok) return { error: result.error, values: {} };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}

/**
 * "Sync now". The run's outcome (also a failed run, with its reason) is shown on the
 * source's card after the refresh; only a refusal (running, too soon, no permission)
 * comes back as an error here.
 */
export async function submitSyncSource(
  slug: string,
  locale: string,
  sourceId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  const result = await syncInsightsSourceAction({ slug, sourceId });
  if (!result.ok) return { error: result.error, values: {} };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}
