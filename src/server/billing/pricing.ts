import type { AiOperation } from "@/generated/prisma/enums";

// Credits pricing. Pure (no `server-only`) for unit tests.
//
// STATUS: PROVISIONAL — PRODUCT DECISION PENDING. The prices, plans and allowances below
// are placeholders chosen to make the mechanism work end to end; they are not commercial
// terms. Every hold records PRICE_VERSION, so changing a price never rewrites history.
// The trial allowance can be tuned without a deploy (CREDITS_TRIAL_MONTHLY).

export const PRICE_VERSION = "2026-10-provisional";

/** Priced features: what a credit buys. */
export const CREDIT_FEATURES = [
  // Ideas, briefs, copy and draft assistance (AI Studio and the content editor).
  "ai_text",
  // An advertising campaign proposal.
  "ad_plan",
  // A drafted reply to a comment or message by an AI social agent.
  "social_reply",
  // An AI social agent reviewing its feedback to improve its own guidance.
  "social_learning",
  // Creator Studio (Pass 8), per started minute of media: transcription and translation
  // (charged only when a real provider did the work — never for simulated text).
  "creator_transcription",
  "creator_translation",
  // Creator Studio: one rendered clip (FFmpeg on our worker), per started minute.
  "creator_export",
] as const;

export type CreditFeature = (typeof CREDIT_FEATURES)[number];

export const FEATURE_PRICES: Readonly<Record<CreditFeature, number>> = {
  ai_text: 1,
  ad_plan: 3,
  social_reply: 1,
  social_learning: 2,
  creator_transcription: 2,
  creator_translation: 1,
  creator_export: 1,
};

export function isCreditFeature(value: unknown): value is CreditFeature {
  return typeof value === "string" && (CREDIT_FEATURES as readonly string[]).includes(value);
}

/** The feature an AI operation is billed as. */
export function featureForOperation(operation: AiOperation): CreditFeature {
  switch (operation) {
    case "AD_PLAN":
      return "ad_plan";
    case "SOCIAL_REPLY":
      return "social_reply";
    case "SOCIAL_LEARNING":
      return "social_learning";
    case "IDEAS":
    case "BRIEF":
    case "COPY":
    case "CONTENT_DRAFT":
    case "CONTENT_REWRITE":
    case "CONTENT_ALTERNATIVES":
    case "CONTENT_HOOK":
    case "CONTENT_CTA":
    case "CONTENT_BRIEF":
      return "ai_text";
  }
}

export interface Plan {
  readonly code: string;
  /** Credits granted at the start of every period (unused credits expire at its end). */
  readonly periodCredits: number;
}

/** Plans a platform administrator can assign. `trial` is every new workspace's plan. */
export function plans(trialPeriodCredits: number): Readonly<Record<string, Plan>> {
  return {
    trial: { code: "trial", periodCredits: trialPeriodCredits },
    starter: { code: "starter", periodCredits: 2_000 },
    growth: { code: "growth", periodCredits: 10_000 },
    // No allowance: pay as you go with purchased credits only.
    payg: { code: "payg", periodCredits: 0 },
  };
}

export const DEFAULT_PLAN = "trial";

/** One calendar month later in UTC (end of month clamps: Jan 31 → Feb 28/29). */
export function addMonth(date: Date): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}

/**
 * The cost to Flexibx of one AI call, in micro-USD, from the provider's token prices
 * (USD per million tokens). Null when a price or a token count is unknown — never
 * estimated from nothing.
 */
export function providerCostMicros(
  usage: { readonly inputTokens: number | null; readonly outputTokens: number | null },
  prices: { readonly inputPerMTok: number | null; readonly outputPerMTok: number | null },
): bigint | null {
  if (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    prices.inputPerMTok === null ||
    prices.outputPerMTok === null
  ) {
    return null;
  }
  // USD per million tokens == micro-USD per token.
  const micros =
    usage.inputTokens * prices.inputPerMTok + usage.outputTokens * prices.outputPerMTok;
  return BigInt(Math.ceil(micros));
}

/**
 * Margin of captured credits against their provider cost, in micro-USD, when both the
 * value of a credit and the provider cost are known.
 */
export function marginMicros(
  credits: number,
  creditValueMicros: number | null,
  costMicros: bigint | null,
): bigint | null {
  if (creditValueMicros === null || costMicros === null) return null;
  return BigInt(credits * creditValueMicros) - costMicros;
}
