"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import type { ErrorResponseBody } from "@/server/errors/http";
import type { ActionResult } from "@/server/http/action-handler";
import {
  changeCampaignStatusAction,
  createAudienceAction,
  createCampaignAction,
  createContentAction,
  createGoalAction,
  createPillarAction,
  deleteAudienceAction,
  deleteContentAction,
  deleteMediaAction,
  movePillarAction,
  rescheduleContentAction,
  saveBrandAction,
  transitionContentAction,
  updateAudienceAction,
  updateCampaignAction,
  updateContentAction,
  updateGoalAction,
  updateMediaAction,
  updatePillarAction,
  uploadMediaAction,
} from "@/server/marketing/marketing-actions";

// Form entry points for the Marketing Core pages. Each reads only the fields it names
// from the form; the slug comes from the page URL and is resolved against the session
// user's memberships by `requireWorkspaceAccess` — it is never authority by itself, and
// neither are the record ids (lookups inside that workspace only).

export type ActionError = ErrorResponseBody["error"];

export type FormValues = Readonly<Record<string, string | readonly string[]>>;

/** State of a marketing form: idle, saved, or rejected (with the submitted values). */
export type MarketingFormState =
  | { readonly error: ActionError; readonly values: FormValues }
  | { readonly done: true; readonly at: number }
  | null;

const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const base = (locale: string, slug: string) => `/${toLocale(locale)}/w/${encodeURIComponent(slug)}`;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function list(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((value): value is string => typeof value === "string");
}

/** The named fields of a form (scalars and multi-selects); nothing else is forwarded. */
function collect(
  formData: FormData,
  scalars: readonly string[],
  lists: readonly string[] = [],
): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const name of scalars) values[name] = text(formData, name);
  for (const name of lists) values[name] = list(formData, name);
  return values;
}

/** Revalidates the workspace's marketing pages after a change (layout-level). */
function refresh(locale: string, slug: string) {
  revalidatePath(base(locale, slug), "layout");
}

function settle<T>(
  result: ActionResult<T>,
  values: FormValues,
  locale: string,
  slug: string,
): MarketingFormState {
  if (!result.ok) return { error: result.error, values };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}

// ── Brand ────────────────────────────────────────────────────────────────────

const BRAND_FIELDS = [
  "name",
  "description",
  "website",
  "industry",
  "market",
  "language",
  "mission",
  "positioning",
  "valueProposition",
  "toneOfVoice",
  "personality",
  "keywords",
  "forbiddenWords",
  "ctaStyle",
] as const;

export async function submitBrand(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, BRAND_FIELDS);
  return settle(await saveBrandAction({ slug, ...values }), values, locale, slug);
}

// ── Audiences ────────────────────────────────────────────────────────────────

const AUDIENCE_FIELDS = [
  "name",
  "description",
  "attributes",
  "painPoints",
  "needs",
  "interests",
  "buyingIntent",
  "objections",
  "preferredChannels",
  "notes",
] as const;

export async function submitAudience(
  slug: string,
  locale: string,
  audienceId: string | null,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, AUDIENCE_FIELDS);
  if (audienceId === null) {
    const result = await createAudienceAction({ slug, ...values });
    if (!result.ok) return { error: result.error, values };
    refresh(locale, slug);
    redirect(`${base(locale, slug)}/brand/audiences/${result.data.audienceId}`);
  }
  return settle(await updateAudienceAction({ slug, audienceId, ...values }), values, locale, slug);
}

export async function submitDeleteAudience(
  slug: string,
  locale: string,
  audienceId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  const result = await deleteAudienceAction({ slug, audienceId });
  if (!result.ok) return { error: result.error, values: {} };
  refresh(locale, slug);
  redirect(`${base(locale, slug)}/brand/audiences`);
}

// ── Goals ────────────────────────────────────────────────────────────────────

const GOAL_FIELDS = [
  "type",
  "title",
  "description",
  "kpi",
  "target",
  "startDate",
  "endDate",
  "status",
] as const;

export async function submitGoal(
  slug: string,
  locale: string,
  goalId: string | null,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, GOAL_FIELDS);
  if (goalId === null) {
    const result = await createGoalAction({ slug, ...values });
    if (!result.ok) return { error: result.error, values };
    refresh(locale, slug);
    redirect(`${base(locale, slug)}/campaigns/goals`);
  }
  return settle(await updateGoalAction({ slug, goalId, ...values }), values, locale, slug);
}

// ── Pillars ──────────────────────────────────────────────────────────────────

const PILLAR_FIELDS = ["name", "description", "objective", "audienceId", "archived"] as const;

export async function submitPillar(
  slug: string,
  locale: string,
  pillarId: string | null,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, PILLAR_FIELDS);
  if (pillarId === null) {
    const result = await createPillarAction({ slug, ...values });
    if (!result.ok) return { error: result.error, values };
    refresh(locale, slug);
    redirect(`${base(locale, slug)}/brand/pillars`);
  }
  return settle(await updatePillarAction({ slug, pillarId, ...values }), values, locale, slug);
}

export async function submitMovePillar(
  slug: string,
  locale: string,
  pillarId: string,
  direction: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await movePillarAction({ slug, pillarId, direction }), {}, locale, slug);
}

// ── Campaigns ────────────────────────────────────────────────────────────────

const CAMPAIGN_FIELDS = [
  "name",
  "description",
  "objective",
  "startDate",
  "endDate",
  "audienceId",
  "budgetAmount",
  "budgetCurrency",
] as const;
const CAMPAIGN_LISTS = ["goalIds", "pillarIds"] as const;

export async function submitCampaign(
  slug: string,
  locale: string,
  campaignId: string | null,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, CAMPAIGN_FIELDS, CAMPAIGN_LISTS);
  if (campaignId === null) {
    const result = await createCampaignAction({ slug, ...values });
    if (!result.ok) return { error: result.error, values };
    refresh(locale, slug);
    redirect(`${base(locale, slug)}/campaigns/${result.data.campaignId}`);
  }
  return settle(await updateCampaignAction({ slug, campaignId, ...values }), values, locale, slug);
}

export async function submitCampaignStatus(
  slug: string,
  locale: string,
  campaignId: string,
  status: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await changeCampaignStatusAction({ slug, campaignId, status }), {}, locale, slug);
}

// ── Content ──────────────────────────────────────────────────────────────────

const CONTENT_FIELDS = [
  "title",
  "body",
  "type",
  "campaignId",
  "pillarId",
  "audienceId",
  "goalId",
  "plannedAt",
  "notes",
  "hashtags",
  "callToAction",
  "link",
] as const;
const CONTENT_LISTS = ["assetIds"] as const;

export async function submitContent(
  slug: string,
  locale: string,
  contentId: string | null,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, CONTENT_FIELDS, CONTENT_LISTS);
  if (contentId === null) {
    const result = await createContentAction({ slug, ...values });
    if (!result.ok) return { error: result.error, values };
    refresh(locale, slug);
    redirect(`${base(locale, slug)}/content/${result.data.contentId}`);
  }
  return settle(await updateContentAction({ slug, contentId, ...values }), values, locale, slug);
}

export async function submitContentTransition(
  slug: string,
  locale: string,
  contentId: string,
  transition: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ["scheduledAt"]);
  return settle(
    await transitionContentAction({ slug, contentId, transition, ...values }),
    values,
    locale,
    slug,
  );
}

export async function submitReschedule(
  slug: string,
  locale: string,
  contentId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ["scheduledAt"]);
  return settle(
    await rescheduleContentAction({ slug, contentId, ...values }),
    values,
    locale,
    slug,
  );
}

export async function submitDeleteContent(
  slug: string,
  locale: string,
  contentId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  const result = await deleteContentAction({ slug, contentId });
  if (!result.ok) return { error: result.error, values: {} };
  refresh(locale, slug);
  redirect(`${base(locale, slug)}/content`);
}

// ── Media ────────────────────────────────────────────────────────────────────

export async function submitUpload(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ["altText"]);
  const file = formData.get("file");
  return settle(await uploadMediaAction({ slug, file, ...values }), values, locale, slug);
}

export async function submitMediaAltText(
  slug: string,
  locale: string,
  assetId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ["altText"]);
  return settle(await updateMediaAction({ slug, assetId, ...values }), values, locale, slug);
}

export async function submitDeleteMedia(
  slug: string,
  locale: string,
  assetId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await deleteMediaAction({ slug, assetId }), {}, locale, slug);
}
