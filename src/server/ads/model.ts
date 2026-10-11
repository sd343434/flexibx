import { z } from "zod";

// The unified advertising model (pure). Every platform adapter translates its own API
// into these shapes, and everything above the adapters — storage, the planner, the
// review screen, the orchestration workflow — speaks only this model. Money is always
// an integer amount in the currency's minor units (e.g. halalas for SAR) plus the ISO
// 4217 code; it is never a float and never decided by a model.

export const AD_PLATFORMS = ["META", "SNAPCHAT", "TIKTOK", "WHATSAPP"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const AD_OBJECTIVES = [
  "AWARENESS",
  "TRAFFIC",
  "ENGAGEMENT",
  "LEADS",
  "SALES",
  "APP_PROMOTION",
  "MESSAGES",
] as const;
export type AdObjective = (typeof AD_OBJECTIVES)[number];

export const AD_ACCOUNT_STATUSES = [
  "ACTIVE",
  "DISABLED",
  "UNSETTLED",
  "PENDING",
  "CLOSED",
  "OTHER",
] as const;
export type AdAccountStatus = (typeof AD_ACCOUNT_STATUSES)[number];

export const AD_DELIVERY_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "IN_REVIEW",
  "REJECTED",
  "ARCHIVED",
  "DELETED",
  "OTHER",
] as const;
export type AdDeliveryStatus = (typeof AD_DELIVERY_STATUSES)[number];

/** Where an ad may appear. AUTOMATIC lets the platform choose (Advantage+ on Meta). */
export const AD_PLACEMENTS = [
  "AUTOMATIC",
  "FACEBOOK_FEED",
  "FACEBOOK_STORIES",
  "FACEBOOK_REELS",
  "INSTAGRAM_FEED",
  "INSTAGRAM_STORIES",
  "INSTAGRAM_REELS",
] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

/**
 * The placements each platform can express. Snapchat (and the platforms without an
 * adapter) only take AUTOMATIC: the platform chooses where the ad shows.
 */
export const PLATFORM_PLACEMENTS: Readonly<Record<AdPlatform, readonly AdPlacement[]>> = {
  META: AD_PLACEMENTS,
  SNAPCHAT: ["AUTOMATIC"],
  TIKTOK: ["AUTOMATIC"],
  WHATSAPP: ["AUTOMATIC"],
};

/** Keeps the placements a platform supports; none left (or AUTOMATIC) → AUTOMATIC only. */
export function placementsFor(
  platform: AdPlatform,
  placements: readonly AdPlacement[],
): AdPlacement[] {
  const supported = PLATFORM_PLACEMENTS[platform];
  const kept = [...new Set(placements)].filter((placement) => supported.includes(placement));
  return kept.length === 0 || kept.includes("AUTOMATIC") ? ["AUTOMATIC"] : kept;
}

export const AD_CALLS_TO_ACTION = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "CONTACT_US",
  "SEND_MESSAGE",
  "BOOK_NOW",
  "ORDER_NOW",
] as const;
export type AdCallToAction = (typeof AD_CALLS_TO_ACTION)[number];

const currency = z.string().regex(/^[A-Z]{3}$/);
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const moneySchema = z.strictObject({ minor, currency });
export type Money = z.infer<typeof moneySchema>;

const externalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const label = z.string().max(400);
const isoTime = z.string().max(40).nullable();

export const unifiedAccountSchema = z.strictObject({
  externalId,
  name: label,
  currency,
  timeZone: z.string().max(64).nullable(),
  status: z.enum(AD_ACCOUNT_STATUSES),
});
export type UnifiedAdAccount = z.infer<typeof unifiedAccountSchema>;

const campaignSchema = z.strictObject({
  externalId,
  name: label,
  objective: z.enum(AD_OBJECTIVES).nullable(),
  status: z.enum(AD_DELIVERY_STATUSES),
  dailyBudget: moneySchema.nullable(),
  lifetimeBudget: moneySchema.nullable(),
  startAt: isoTime,
  stopAt: isoTime,
});

const adSetSchema = z.strictObject({
  externalId,
  campaignExternalId: externalId,
  name: label,
  status: z.enum(AD_DELIVERY_STATUSES),
  dailyBudget: moneySchema.nullable(),
  lifetimeBudget: moneySchema.nullable(),
  optimizationGoal: z.string().max(60).nullable(),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50),
  ageMin: z.number().int().min(13).max(65).nullable(),
  ageMax: z.number().int().min(13).max(65).nullable(),
});

const adSchema = z.strictObject({
  externalId,
  adSetExternalId: externalId,
  campaignExternalId: externalId,
  name: label,
  status: z.enum(AD_DELIVERY_STATUSES),
});

const metricsSchema = z.strictObject({
  campaignExternalId: externalId,
  impressions: minor,
  reach: minor.nullable(),
  clicks: minor,
  spend: moneySchema,
});

export const accountSnapshotSchema = z.strictObject({
  version: z.literal(1),
  fetchedAt: z.string().max(40),
  /** The insights window, inclusive dates (YYYY-MM-DD) as the platform reported them. */
  range: z.strictObject({ days: z.number().int().min(1).max(90) }),
  campaigns: z.array(campaignSchema).max(500),
  adSets: z.array(adSetSchema).max(500),
  ads: z.array(adSchema).max(500),
  metrics: z.array(metricsSchema).max(500),
  /** True when a list was cut at the page limit (the UI says so). */
  truncated: z.boolean(),
});
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;
export type UnifiedCampaign = AccountSnapshot["campaigns"][number];
export type UnifiedAdSet = AccountSnapshot["adSets"][number];
export type UnifiedAd = AccountSnapshot["ads"][number];
export type UnifiedMetrics = AccountSnapshot["metrics"][number];

/** A stored snapshot, re-validated whenever it is read back (null when unusable). */
export function readAccountSnapshot(value: unknown): AccountSnapshot | null {
  const parsed = accountSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Digits after the decimal point for a currency (2 for SAR, 0 for JPY, 3 for KWD). */
export function currencyDigits(code: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Micro-currency (1 major unit = 1,000,000 micro, as Snapchat reports spend and budgets)
 * → minor units, rounded half up. Exact integer arithmetic; null when not a safe integer.
 */
export function microToMinor(micro: number, code: string): number | null {
  if (!Number.isSafeInteger(micro) || micro < 0) return null;
  const divisor = 10 ** (6 - Math.min(6, currencyDigits(code)));
  return Math.floor(micro / divisor) + (micro % divisor >= divisor / 2 ? 1 : 0);
}

/** Minor units → micro-currency (for describing a Snapchat budget). */
export function minorToMicro(minor: number, code: string): number {
  return minor * 10 ** (6 - Math.min(6, currencyDigits(code)));
}

/** "12.34" (major units, as platforms report spend) → 1234 minor units. Exact, no floats. */
export function majorToMinor(value: string, code: string): number | null {
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (match === null) return null;
  const digits = currencyDigits(code);
  const fraction = (match[2] ?? "").padEnd(digits, "0");
  // Round half up on any extra precision the platform sends.
  const kept = fraction.slice(0, digits);
  const extra = fraction.slice(digits);
  let result = Number(match[1]) * 10 ** digits + (digits === 0 ? 0 : Number(kept));
  if (extra !== "" && Number(extra[0]) >= 5) result += 1;
  return Number.isSafeInteger(result) ? result : null;
}

/** The campaign a person reviews and approves (unified; platform mapping is the adapter's). */
export const adCampaignSpecSchema = z.strictObject({
  objective: z.enum(AD_OBJECTIVES),
  campaignName: z.string().trim().min(1).max(200),
  audience: z.strictObject({
    description: z.string().trim().min(1).max(400),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(10),
    ageMin: z.number().int().min(18).max(65),
    ageMax: z.number().int().min(18).max(65),
    genders: z.enum(["ALL", "FEMALE", "MALE"]),
    interests: z.array(z.string().trim().min(1).max(80)).max(10),
  }),
  placements: z.array(z.enum(AD_PLACEMENTS)).min(1).max(AD_PLACEMENTS.length),
  creative: z.strictObject({
    headline: z.string().trim().min(1).max(120),
    primaryText: z.string().trim().min(1).max(1000),
    callToAction: z.enum(AD_CALLS_TO_ACTION),
    /** A workspace media asset (resolved and checked by the server), or none. */
    mediaAssetId: z.uuid().nullable(),
    /** Where the ad leads (https). Required to create the ad on a platform. */
    destinationUrl: z
      .url({ protocol: /^https$/ })
      .max(2000)
      .nullable()
      .optional(),
  }),
  rationale: z.string().trim().min(1).max(600),
});
export type AdCampaignSpec = z.infer<typeof adCampaignSpecSchema>;

export function readCampaignSpec(value: unknown): AdCampaignSpec | null {
  const parsed = adCampaignSpecSchema.safeParse(value);
  if (!parsed.success) return null;
  const spec = parsed.data;
  if (spec.audience.ageMin > spec.audience.ageMax) return null;
  return spec;
}
