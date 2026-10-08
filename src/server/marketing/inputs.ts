import { z } from "zod";

import {
  BrandLanguage,
  BuyingIntent,
  CampaignStatus,
  ContentType,
  MarketingGoalStatus,
  MarketingGoalType,
} from "@/generated/prisma/enums";

// Input schemas for Marketing Core. Pure (no `server-only`): shared by the server
// actions, the services' own re-validation and unit tests.
//
// Every object is strict, so a client cannot add a workspace id, a user id, a status
// or any other field it does not own. Ids of related records are only lookup keys: the
// services resolve each one inside the current workspace before it is stored.

// The URL slug only selects which of the session user's memberships to act through.
const slug = z.string().min(1).max(100);

/** Trimmed text; empty becomes null. Accepts a missing value as null too. */
export const optionalText = (max: number) =>
  z.preprocess(
    (value) => value ?? "",
    z
      .string()
      .trim()
      .max(max)
      .transform((value) => (value === "" ? null : value)),
  );

const requiredText = (max: number) => z.string().trim().min(1).max(max);

/**
 * A list of short strings entered one per line (or separated by commas, Arabic commas
 * included). Duplicates and empty entries are dropped; arrays are accepted as-is.
 */
export const textList = (maxItems: number, maxLength: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null) return [];
      const items: unknown = typeof value === "string" ? value.split(/[\n,،]/) : value;
      if (!Array.isArray(items)) return items;
      const cleaned = (items as unknown[]).map((item) =>
        typeof item === "string" ? item.trim() : item,
      );
      return [...new Set(cleaned.filter((item) => item !== ""))];
    },
    z.array(z.string().max(maxLength)).max(maxItems),
  );

/** An absolute http(s) URL, or null. */
const optionalUrl = z.preprocess(
  (value) =>
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
      ? null
      : typeof value === "string"
        ? value.trim()
        : value,
  z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullable(),
);

/** A related record id, or null for "none". */
export const optionalId = z.preprocess(
  (value) => (value === undefined || value === "" ? null : value),
  z.uuid().nullable(),
);

/** A list of related record ids (multi-select). */
const idList = (max: number) =>
  z.preprocess(
    (value) =>
      value === undefined || value === null || value === ""
        ? []
        : Array.isArray(value)
          ? [...new Set(value as unknown[])]
          : [value],
    z.array(z.uuid()).max(max),
  );

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date (YYYY-MM-DD) as a UTC-midnight Date, or null. */
export const optionalDate = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? null : value),
  z
    .string()
    .regex(DATE_PATTERN)
    // Round-trip, so rolled-over dates such as 2030-02-30 are rejected.
    .refine((value) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), {
      message: "Invalid date",
    })
    .transform((value) => new Date(`${value}T00:00:00Z`))
    .nullable(),
);

const LOCAL_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * A wall-clock time in the workspace's time zone, as entered in a datetime-local field
 * (YYYY-MM-DDTHH:mm). The service converts it with the workspace's time zone.
 */
export const optionalLocalDateTime = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? null : value),
  z.string().regex(LOCAL_DATE_TIME_PATTERN).nullable(),
);

export const localDateTime = z.string().regex(LOCAL_DATE_TIME_PATTERN);

const nonNegativeDecimal = (maxIntegerDigits: number) =>
  z.preprocess(
    (value) =>
      value === undefined || value === null || (typeof value === "string" && value.trim() === "")
        ? null
        : typeof value === "string"
          ? value.trim()
          : value,
    z
      .string()
      .regex(new RegExp(`^\\d{1,${String(maxIntegerDigits)}}(\\.\\d{1,2})?$`))
      .nullable(),
  );

// ── Brand ────────────────────────────────────────────────────────────────────

export const brandFieldsSchema = z.strictObject({
  name: requiredText(120),
  description: optionalText(2000),
  website: optionalUrl,
  industry: optionalText(120),
  market: optionalText(200),
  language: z.enum(BrandLanguage),
  mission: optionalText(2000),
  positioning: optionalText(2000),
  valueProposition: optionalText(2000),
  toneOfVoice: optionalText(1000),
  personality: optionalText(1000),
  keywords: textList(30, 60),
  forbiddenWords: textList(50, 60),
  ctaStyle: optionalText(500),
});

export const saveBrandInputSchema = brandFieldsSchema.extend({ slug });

// ── Audience ─────────────────────────────────────────────────────────────────

/**
 * Descriptive attributes entered as "label: value" lines (e.g. "Age: 25–34"). At most
 * 20; anything without a label is rejected rather than guessed.
 */
export const audienceAttributes = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === "") return [];
    if (typeof value !== "string") return value;
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const separator = line.search(/[:：]/);
        return separator < 0
          ? { label: "", value: line }
          : { label: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
      });
  },
  z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(60),
        value: z.string().trim().min(1).max(200),
      }),
    )
    .max(20),
);

export const audienceFieldsSchema = z.strictObject({
  name: requiredText(120),
  description: optionalText(2000),
  attributes: audienceAttributes,
  painPoints: textList(20, 200),
  needs: textList(20, 200),
  interests: textList(30, 100),
  buyingIntent: z.preprocess(
    (value) => (value === undefined || value === "" ? null : value),
    z.enum(BuyingIntent).nullable(),
  ),
  objections: textList(20, 200),
  preferredChannels: textList(20, 60),
  notes: optionalText(4000),
});

export const createAudienceInputSchema = audienceFieldsSchema.extend({ slug });
export const updateAudienceInputSchema = audienceFieldsSchema.extend({
  slug,
  audienceId: z.uuid(),
});
export const deleteAudienceInputSchema = z.strictObject({ slug, audienceId: z.uuid() });

// ── Marketing goals ──────────────────────────────────────────────────────────

const dateRange = (value: { startDate: Date | null; endDate: Date | null }) =>
  value.startDate === null || value.endDate === null || value.endDate >= value.startDate;

export const goalFieldsSchema = z.strictObject({
  type: z.enum(MarketingGoalType),
  title: requiredText(160),
  description: optionalText(2000),
  kpi: optionalText(160),
  target: nonNegativeDecimal(12),
  startDate: optionalDate,
  endDate: optionalDate,
  status: z.enum(MarketingGoalStatus),
});

const dateRangeIssue = {
  message: "End date is before start date",
  path: ["endDate"],
  params: { code: "date_range" },
};

export const createGoalInputSchema = goalFieldsSchema
  .extend({ slug })
  .refine(dateRange, dateRangeIssue);
export const updateGoalInputSchema = goalFieldsSchema
  .extend({ slug, goalId: z.uuid() })
  .refine(dateRange, dateRangeIssue);

// ── Content pillars ──────────────────────────────────────────────────────────

export const pillarFieldsSchema = z.strictObject({
  name: requiredText(120),
  description: optionalText(2000),
  objective: optionalText(1000),
  audienceId: optionalId,
  archived: z.preprocess(
    (value) => value === true || value === "true" || value === "on",
    z.boolean(),
  ),
});

export const createPillarInputSchema = pillarFieldsSchema.extend({ slug });
export const updatePillarInputSchema = pillarFieldsSchema.extend({ slug, pillarId: z.uuid() });
export const movePillarInputSchema = z.strictObject({
  slug,
  pillarId: z.uuid(),
  direction: z.enum(["up", "down"]),
});

// ── Campaigns ────────────────────────────────────────────────────────────────

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const campaignFieldsSchema = z.strictObject({
  name: requiredText(160),
  description: optionalText(2000),
  objective: optionalText(1000),
  startDate: optionalDate,
  endDate: optionalDate,
  audienceId: optionalId,
  goalIds: idList(20),
  pillarIds: idList(20),
  /** Planning budget in major units (e.g. "1500.50"); stored in minor units. */
  budgetAmount: nonNegativeDecimal(12),
  budgetCurrency: z.preprocess(
    (value) =>
      value === undefined || value === null || value === ""
        ? null
        : typeof value === "string"
          ? value.trim().toUpperCase()
          : value,
    z.string().regex(CURRENCY_PATTERN).nullable(),
  ),
});

const budgetPair = (value: { budgetAmount: string | null; budgetCurrency: string | null }) =>
  (value.budgetAmount === null) === (value.budgetCurrency === null);
const budgetIssue = {
  message: "Amount and currency go together",
  path: ["budgetCurrency"],
  params: { code: "budget_pair" },
};

export const createCampaignInputSchema = campaignFieldsSchema
  .extend({ slug })
  .refine(dateRange, dateRangeIssue)
  .refine(budgetPair, budgetIssue);
export const updateCampaignInputSchema = campaignFieldsSchema
  .extend({ slug, campaignId: z.uuid() })
  .refine(dateRange, dateRangeIssue)
  .refine(budgetPair, budgetIssue);
export const changeCampaignStatusInputSchema = z.strictObject({
  slug,
  campaignId: z.uuid(),
  status: z.enum(CampaignStatus),
});

// ── Content ──────────────────────────────────────────────────────────────────

export const contentMetadataSchema = z.strictObject({
  hashtags: textList(30, 60),
  callToAction: optionalText(200),
  link: optionalUrl,
});

export const contentFieldsSchema = z.strictObject({
  title: requiredText(200),
  body: z.preprocess((value) => value ?? "", z.string().max(10000)),
  type: z.enum(ContentType),
  campaignId: optionalId,
  pillarId: optionalId,
  audienceId: optionalId,
  goalId: optionalId,
  /** Planned time (workspace time zone). Committed schedules use the SCHEDULE transition. */
  plannedAt: optionalLocalDateTime,
  notes: optionalText(4000),
  hashtags: textList(30, 60),
  callToAction: optionalText(200),
  link: optionalUrl,
  assetIds: idList(10),
});

export const createContentInputSchema = contentFieldsSchema.extend({ slug });
export const updateContentInputSchema = contentFieldsSchema.extend({
  slug,
  contentId: z.uuid(),
});
export const deleteContentInputSchema = z.strictObject({ slug, contentId: z.uuid() });

export const CONTENT_TRANSITIONS = [
  "submit",
  "withdraw",
  "approve",
  "request_changes",
  "reopen",
  "schedule",
  "unschedule",
  "publish",
] as const;
export type ContentTransition = (typeof CONTENT_TRANSITIONS)[number];

export const transitionContentInputSchema = z.strictObject({
  slug,
  contentId: z.uuid(),
  transition: z.enum(CONTENT_TRANSITIONS),
  /** Required for `schedule` (workspace time zone). */
  scheduledAt: optionalLocalDateTime,
});

export const rescheduleContentInputSchema = z.strictObject({
  slug,
  contentId: z.uuid(),
  scheduledAt: optionalLocalDateTime,
});

// ── Calendar ─────────────────────────────────────────────────────────────────

export const CALENDAR_VIEWS = ["week", "day"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const calendarQuerySchema = z.strictObject({
  view: z.enum(CALENDAR_VIEWS).catch("week"),
  /** Any day inside the period (YYYY-MM-DD, workspace time zone); defaults to today. */
  date: z.string().regex(DATE_PATTERN).optional().catch(undefined),
});

// ── Content list ─────────────────────────────────────────────────────────────

export const CONTENT_PAGE_SIZE = 20;

export const contentListQuerySchema = z.strictObject({
  status: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .enum(["DRAFT", "IN_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED"])
      .optional()
      .catch(undefined),
  ),
  type: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(ContentType).optional().catch(undefined),
  ),
  campaignId: z.uuid().optional().catch(undefined),
  pillarId: z.uuid().optional().catch(undefined),
  q: z.string().trim().max(100).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});

// ── Media ────────────────────────────────────────────────────────────────────

export const updateMediaInputSchema = z.strictObject({
  slug,
  assetId: z.uuid(),
  altText: optionalText(500),
});
export const deleteMediaInputSchema = z.strictObject({ slug, assetId: z.uuid() });

/** Option values for the enum-backed form fields (pages may not import the DB layer). */
export const ENUM_VALUES = {
  brandLanguage: Object.values(BrandLanguage),
  buyingIntent: Object.values(BuyingIntent),
  goalType: Object.values(MarketingGoalType),
  goalStatus: Object.values(MarketingGoalStatus),
  contentType: Object.values(ContentType),
} as const;

export type BrandFields = z.output<typeof brandFieldsSchema>;
export type AudienceFields = z.output<typeof audienceFieldsSchema>;
export type GoalFields = z.output<typeof goalFieldsSchema>;
export type PillarFields = z.output<typeof pillarFieldsSchema>;
export type CampaignFields = z.output<typeof campaignFieldsSchema>;
export type ContentFields = z.output<typeof contentFieldsSchema>;
