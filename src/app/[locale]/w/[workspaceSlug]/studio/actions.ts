"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import {
  cancelJobAction,
  completeUploadAction,
  createClipAction,
  createProjectAction,
  requestExportAction,
  requestTranscriptionAction,
  requestTranslationAction,
  retryJobAction,
  reviewClipAction,
  startUploadAction,
  updateClipAction,
  updateSegmentAction,
} from "@/server/creator/creator-actions";
import type { ActionResult } from "@/server/http/action-handler";

import type { FormValues, MarketingFormState } from "../marketing-actions";

// Form entry points of the Creator Studio. The slug, ids, versions and request keys are
// bound by the page; none is authority — the server action resolves the workspace from
// the session's membership and the service re-checks the role, workspace and version.

const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const studioPath = (locale: string, slug: string) =>
  `/${toLocale(locale)}/w/${encodeURIComponent(slug)}/studio`;

function refresh(locale: string, slug: string) {
  revalidatePath(studioPath(locale, slug), "layout");
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** Seconds as typed ("12.5") → whole milliseconds; anything else is left for the schema to refuse. */
const toMs = (value: string): number | string => {
  const seconds = Number(value.replace(",", "."));
  return value.trim() !== "" && Number.isFinite(seconds) ? Math.round(seconds * 1000) : value;
};

function settle(
  result: ActionResult<unknown>,
  values: FormValues,
  locale: string,
  slug: string,
): MarketingFormState {
  if (!result.ok) return { error: result.error, values };
  refresh(locale, slug);
  return { done: true, at: Date.now() };
}

export async function submitCreateProject(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = { name: text(formData, "name"), description: text(formData, "description") };
  const result = await createProjectAction({ slug, ...values });
  if (!result.ok) return { error: result.error, values };
  refresh(locale, slug);
  redirect(`${studioPath(locale, slug)}/${result.data.id}`);
}

/** Step 1 of an upload: a short-lived signed URL for exactly this type and size. */
export async function beginUpload(
  slug: string,
  projectId: string,
  file: { readonly fileName: string; readonly contentType: string; readonly size: number },
) {
  return startUploadAction({ slug, projectId, ...file });
}

/** Step 2: the bytes are in storage; the analysis job checks them. */
export async function finishUpload(slug: string, locale: string, sourceId: string) {
  const result = await completeUploadAction({ slug, sourceId });
  if (result.ok) refresh(locale, slug);
  return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
}

export async function submitTranscription(
  slug: string,
  locale: string,
  projectId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = { language: text(formData, "language") };
  const result = await requestTranscriptionAction({
    slug,
    projectId,
    ...(values.language === "" ? {} : { language: values.language }),
    requestKey: text(formData, "requestKey"),
  });
  return settle(result, values, locale, slug);
}

export async function submitTranslation(
  slug: string,
  locale: string,
  transcriptId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = { targetLanguage: text(formData, "targetLanguage") };
  const result = await requestTranslationAction({
    slug,
    transcriptId,
    targetLanguage: values.targetLanguage,
    requestKey: text(formData, "requestKey"),
  });
  return settle(result, values, locale, slug);
}

export async function submitSegment(
  slug: string,
  locale: string,
  segmentId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    text: text(formData, "text"),
    start: text(formData, "start"),
    end: text(formData, "end"),
  };
  const result = await updateSegmentAction({
    slug,
    segmentId,
    text: values.text,
    startMs: toMs(values.start),
    endMs: toMs(values.end),
  });
  return settle(result, values, locale, slug);
}

export async function submitClip(
  slug: string,
  locale: string,
  clipId: string,
  version: number,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    title: text(formData, "title"),
    start: text(formData, "start"),
    end: text(formData, "end"),
    cropX: text(formData, "cropX"),
  };
  const result = await updateClipAction({
    slug,
    clipId,
    title: values.title,
    startMs: toMs(values.start),
    endMs: toMs(values.end),
    cropX: values.cropX,
    version,
  });
  return settle(result, values, locale, slug);
}

export async function submitNewClip(
  slug: string,
  locale: string,
  projectId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    title: text(formData, "title"),
    start: text(formData, "start"),
    end: text(formData, "end"),
  };
  const result = await createClipAction({
    slug,
    projectId,
    title: values.title,
    startMs: toMs(values.start),
    endMs: toMs(values.end),
  });
  return settle(result, values, locale, slug);
}

export async function submitReview(
  slug: string,
  locale: string,
  clipId: string,
  version: number,
  decision: "APPROVED" | "REJECTED",
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await reviewClipAction({ slug, clipId, decision, version }), {}, locale, slug);
}

export async function submitExport(
  slug: string,
  locale: string,
  clipId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    aspectRatio: text(formData, "aspectRatio"),
    subtitleTranscriptId: text(formData, "subtitleTranscriptId"),
  };
  const result = await requestExportAction({
    slug,
    clipId,
    aspectRatio: values.aspectRatio,
    ...(values.subtitleTranscriptId === ""
      ? {}
      : { subtitleTranscriptId: values.subtitleTranscriptId }),
    requestKey: text(formData, "requestKey"),
  });
  return settle(result, values, locale, slug);
}

export async function submitCancelJob(
  slug: string,
  locale: string,
  jobId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await cancelJobAction({ slug, jobId }), {}, locale, slug);
}

export async function submitRetryJob(
  slug: string,
  locale: string,
  jobId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await retryJobAction({ slug, jobId }), {}, locale, slug);
}
