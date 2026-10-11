"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import {
  applyGenerationAction,
  assistContentAction,
  generateBriefAction,
  generateCopyAction,
  generateIdeasAction,
} from "@/server/ai/ai-actions";

import type { MarketingFormState } from "../marketing-actions";

// Form entry points for AI Studio and the content assist panel. Each forwards only the
// fields it names. The slug selects one of the session user's memberships; ids are
// lookups inside that workspace; no generated text is ever accepted from the browser —
// "Use" sends only the generation id and the chosen option's index.

const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const base = (locale: string, slug: string) => `/${toLocale(locale)}/w/${encodeURIComponent(slug)}`;

function collect(formData: FormData, names: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = formData.get(name);
    values[name] = typeof value === "string" ? value : "";
  }
  return values;
}

const TOOLS = {
  ideas: {
    action: generateIdeasAction,
    fields: ["language", "topic", "count", "pillarId", "campaignId"],
  },
  brief: {
    action: generateBriefAction,
    fields: ["language", "topic", "contentType", "pillarId", "campaignId"],
  },
  copy: {
    action: generateCopyAction,
    fields: ["language", "topic", "contentType", "campaignId", "variants"],
  },
} as const;

export type StudioTool = keyof typeof TOOLS;

export async function submitGenerate(
  slug: string,
  locale: string,
  tool: StudioTool,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const { action, fields } = TOOLS[tool];
  const values = collect(formData, fields);
  const result = await action({ slug, uiLocale: toLocale(locale), ...values });
  if (!result.ok) return { error: result.error, values };
  redirect(`${base(locale, slug)}/ai?tool=${tool}&g=${result.data.generationId}`);
}

export async function submitAssist(
  slug: string,
  locale: string,
  contentId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ["operation", "language", "instructions"]);
  const result = await assistContentAction({
    slug,
    contentId,
    uiLocale: toLocale(locale),
    ...values,
  });
  if (!result.ok) return { error: result.error, values };
  redirect(`${base(locale, slug)}/content/${contentId}?ai=${result.data.generationId}#ai-assist`);
}

export async function submitApply(
  slug: string,
  locale: string,
  generationId: string,
  choice: number,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await applyGenerationAction({ slug, generationId, choice });
  if (!result.ok) return { error: result.error, values: {} };
  revalidatePath(base(locale, slug), "layout");
  redirect(`${base(locale, slug)}/content/${result.data.contentId}`);
}
