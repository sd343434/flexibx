import { z } from "zod";

import { ContentType, MarketingChannel } from "@/generated/prisma/enums";

import { optionalDate, optionalText } from "./inputs";

// Campaign content plans (Pass 4). Pure (no `server-only`): input schemas shared by the
// server actions and the service's own checks, and the deterministic parts of building
// a plan from AI ideas — dates, channels and the brief text. The model never chooses a
// date, a channel, a budget or an offer: those come from the campaign and from a person.

export const MARKETING_CHANNELS = Object.values(MarketingChannel);

/** The only channel Flexibx publishes to itself (Facebook Pages, social/publishing.ts). */
export const PUBLISHED_CHANNEL: MarketingChannel = "FACEBOOK_PAGE";

export function isPublishedByFlexibx(channel: MarketingChannel): boolean {
  return channel === PUBLISHED_CHANNEL;
}

/** Most items a plan holds (AI-proposed and hand-written together). */
export const MAX_PLAN_ITEMS = 30;
/** How many ideas one generation proposes (the IDEAS operation allows 3–10). */
export const PLAN_IDEAS_MIN = 3;
export const PLAN_IDEAS_MAX = 10;
/** Without a campaign end date, ideas are spread over this many days. */
export const DEFAULT_PLAN_DAYS = 14;
/** The topic sent to the AI engine is bounded like a person's own request. */
export const PLAN_TOPIC_MAX = 500;

const slug = z.string().min(1).max(100);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const version = z.coerce.number().int().min(0).max(2_147_483_647);

/** Multi-select of channels (form values or an array); duplicates dropped. */
const channelList = z.preprocess(
  (value) =>
    value === undefined || value === null || value === ""
      ? []
      : Array.isArray(value)
        ? [...new Set(value as unknown[])]
        : [value],
  z.array(z.enum(MarketingChannel)).max(MARKETING_CHANNELS.length),
);

/** A checkbox: "on"/"true" is checked; missing or empty is not. */
const checkbox = z.preprocess(
  (value) => value === true || value === "on" || value === "true",
  z.boolean(),
);

export const planBriefFieldsSchema = z.strictObject({
  offer: optionalText(1000),
  channels: channelList,
  budgetNotes: optionalText(1000),
});

export const planItemFieldsSchema = z.strictObject({
  title: requiredText(200),
  brief: z.preprocess((value) => value ?? "", z.string().trim().max(2000)),
  contentType: z.enum(ContentType),
  channel: z.enum(MarketingChannel),
  plannedDate: optionalDate,
  included: checkbox,
});

const planRef = { slug, campaignId: z.uuid(), version };

export const savePlanBriefInputSchema = planBriefFieldsSchema.extend(planRef);
export const generatePlanInputSchema = z.strictObject({
  ...planRef,
  uiLocale: z.preprocess(
    (value) => (value === "" || value === undefined ? "ar" : value),
    z.enum(["ar", "en"]),
  ),
  count: z.preprocess(
    (value) => (value === undefined || value === null || value === "" ? 6 : value),
    z.coerce.number().int().min(PLAN_IDEAS_MIN).max(PLAN_IDEAS_MAX),
  ),
});
export const addPlanItemInputSchema = planItemFieldsSchema.extend(planRef);
export const updatePlanItemInputSchema = planItemFieldsSchema.extend({
  ...planRef,
  itemId: z.uuid(),
});
export const removePlanItemInputSchema = z.strictObject({ ...planRef, itemId: z.uuid() });
export const planStepInputSchema = z.strictObject(planRef);

export type PlanBriefFields = z.output<typeof planBriefFieldsSchema>;
export type PlanItemFields = z.output<typeof planItemFieldsSchema>;

// ── Building items from AI ideas (deterministic) ─────────────────────────────

const DAY_MS = 24 * 3_600_000;

/** UTC midnight of a calendar date. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Planned dates for `count` items, spread evenly from the later of the campaign start and
 * `today` to the campaign end (or DEFAULT_PLAN_DAYS later without an end). A campaign
 * that has already ended gets no dates: a person sets them.
 */
export function spreadPlannedDates(
  count: number,
  window: { readonly startDate: Date | null; readonly endDate: Date | null },
  today: Date,
): (Date | null)[] {
  if (count <= 0) return [];
  const first = utcDay(
    window.startDate !== null && window.startDate > today ? window.startDate : today,
  );
  const last =
    window.endDate === null
      ? new Date(first.getTime() + (DEFAULT_PLAN_DAYS - 1) * DAY_MS)
      : utcDay(window.endDate);
  if (last < first) return Array.from({ length: count }, () => null);
  const days = Math.round((last.getTime() - first.getTime()) / DAY_MS);
  return Array.from({ length: count }, (_, index) => {
    const offset = count === 1 ? 0 : Math.round((index * days) / (count - 1));
    return new Date(first.getTime() + offset * DAY_MS);
  });
}

/** Channels in the order the person chose them, one item after another. */
export function assignChannels(
  count: number,
  channels: readonly MarketingChannel[],
): MarketingChannel[] {
  const assigned: MarketingChannel[] = [];
  for (let index = 0; index < count; index += 1) {
    const channel = channels[index % channels.length];
    if (channel === undefined) throw new RangeError("No channels to assign");
    assigned.push(channel);
  }
  return assigned;
}

const BRIEF_LABELS = {
  ar: { angle: "الزاوية", objective: "الهدف", audience: "الجمهور", cta: "الدعوة لاتخاذ إجراء" },
  en: { angle: "Angle", objective: "Objective", audience: "Audience", cta: "Call to action" },
} as const;

/** The brief of an item made from one AI idea (the idea's own words, labelled). */
export function briefFromIdea(
  idea: {
    readonly angle: string;
    readonly objective: string;
    readonly audience: string;
    readonly ctaDirection: string;
  },
  language: "ar" | "en",
): string {
  const l = BRIEF_LABELS[language];
  const text = [
    `${l.angle}: ${idea.angle}`,
    `${l.objective}: ${idea.objective}`,
    `${l.audience}: ${idea.audience}`,
    `${l.cta}: ${idea.ctaDirection}`,
  ].join("\n");
  return text.length <= 2000 ? text : text.slice(0, 2000);
}

const CHANNEL_NAMES: Readonly<Record<MarketingChannel, string>> = {
  FACEBOOK_PAGE: "Facebook Page",
  INSTAGRAM: "Instagram",
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  OTHER: "other channels",
};

const isoDay = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The request sent to the AI engine for a campaign's plan: the person's offer and budget
 * assumptions and the chosen channels, as data. The campaign itself (objective, audience,
 * goals) reaches the model through the engine's own context, focused on the campaign.
 */
export function planTopic(input: {
  readonly offer: string | null;
  readonly budgetNotes: string | null;
  readonly channels: readonly MarketingChannel[];
  readonly dates: { readonly first: Date | null; readonly last: Date | null };
}): string {
  const parts = [
    "Plan the content of this campaign: one idea per planned post, varied, on-brand.",
    `Channels: ${input.channels.map((channel) => CHANNEL_NAMES[channel]).join(", ")}.`,
    input.offer === null ? null : `Offer: ${input.offer}`,
    input.budgetNotes === null ? null : `Budget assumptions: ${input.budgetNotes}`,
    input.dates.first === null || input.dates.last === null
      ? null
      : `Publishing window: ${isoDay(input.dates.first)} to ${isoDay(input.dates.last)}.`,
  ].filter((part): part is string => part !== null);
  const topic = parts.join("\n");
  return topic.length <= PLAN_TOPIC_MAX ? topic : topic.slice(0, PLAN_TOPIC_MAX);
}
