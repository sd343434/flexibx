"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import {
  refreshVideoJobAction,
  regenerateVideoAction,
  requestVideoAction,
  reviewVideoAction,
} from "@/server/videos/generation/video-generation-actions";

import type { MarketingFormState } from "../../../marketing-actions";

// Form entry points for video generation. Each forwards only the fields it names; the
// slug selects one of the session user's memberships, the job id is a lookup inside that
// workspace. Budget, limits, provider and permissions are decided on the server only.

const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const page = (locale: string, slug: string) =>
  `/${toLocale(locale)}/w/${encodeURIComponent(slug)}/ai/videos/generate`;

const FIELDS = [
  "title",
  "objective",
  "audience",
  "description",
  "platform",
  "style",
  "language",
  "durationSeconds",
  "aspectRatio",
  "resolution",
  "tier",
] as const;

export async function submitVideoRequest(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values: Record<string, string> = {};
  for (const name of FIELDS) {
    const value = formData.get(name);
    values[name] = typeof value === "string" ? value : "";
  }
  const audio = formData.get("audio") === "on";
  const result = await requestVideoAction({ slug, ...values, audio });
  if (!result.ok) return { error: result.error, values: { ...values, audio: audio ? "on" : "" } };
  redirect(`${page(locale, slug)}?job=${result.data.jobId}`);
}

export async function submitVideoRefresh(
  slug: string,
  locale: string,
  jobId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await refreshVideoJobAction({ slug, jobId });
  if (!result.ok) return { error: result.error, values: {} };
  redirect(`${page(locale, slug)}?job=${jobId}`);
}

export async function submitVideoReview(
  slug: string,
  locale: string,
  jobId: string,
  decision: "accept" | "reject",
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await reviewVideoAction({ slug, jobId, decision });
  if (!result.ok) return { error: result.error, values: {} };
  revalidatePath(page(locale, slug));
  redirect(`${page(locale, slug)}?job=${jobId}`);
}

/** "Generate again": a new request with the same brief and settings. */
export async function submitVideoRegenerate(
  slug: string,
  locale: string,
  jobId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await regenerateVideoAction({ slug, jobId });
  if (!result.ok) return { error: result.error, values: {} };
  redirect(`${page(locale, slug)}?job=${result.data.jobId}`);
}
