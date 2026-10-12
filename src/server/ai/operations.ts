import { z } from "zod";

import { AiOperation, ContentType } from "@/generated/prisma/enums";

import { AD_CALLS_TO_ACTION, AD_OBJECTIVES, AD_PLACEMENTS } from "../ads/model";

import { AiProviderError } from "./provider";

// What each AI operation must return. Pure (no `server-only`). Every model response is
// untrusted input: it is parsed as one JSON object and validated by a strict schema
// (required fields, lengths, list sizes, allowed values, no unknown keys) before it is
// stored or shown. The model never produces database ids: it may only name the short
// reference handles it was shown (P1–P9 pillars, C1–C9 campaigns), and the server maps
// a handle back to an id it already knows — unknown handles are dropped.

/** Largest raw response accepted before parsing (characters). */
export const MAX_OUTPUT_CHARS = 24_000;

const text = (max: number) => z.string().trim().min(1).max(max);
const pillarRef = z
  .string()
  .regex(/^P[1-9]$/)
  .nullable();
const campaignRef = z
  .string()
  .regex(/^C[1-9]$/)
  .nullable();
const hashtag = z
  .string()
  .trim()
  .regex(/^#?[\p{L}\p{N}_]{1,59}$/u)
  .transform((tag) => (tag.startsWith("#") ? tag : `#${tag}`));

const ideaSchema = z.strictObject({
  title: text(200),
  angle: text(500),
  contentType: z.enum(ContentType),
  objective: text(300),
  audience: text(200),
  ctaDirection: text(200),
  rationale: text(500),
  pillarRef,
  campaignRef,
});

const briefSchema = z.strictObject({
  title: text(200),
  contentType: z.enum(ContentType),
  objective: text(500),
  audience: text(300),
  keyMessage: text(500),
  angle: text(300),
  hook: text(300),
  cta: text(200),
  tone: text(200),
  supportingPoints: z.array(text(300)).min(1).max(6),
  structure: z.array(text(300)).min(1).max(8),
  pillarRef,
  campaignRef,
});

// An advertising campaign proposal. Deliberately no money, dates or ids: the budget and
// schedule are a person's input and deterministic code; the model may only cite a media
// asset by the handle it was shown (M1…M9), which the server maps back.
const adPlanSchema = z.strictObject({
  objective: z.enum(AD_OBJECTIVES),
  campaignName: text(200),
  audience: z.strictObject({
    description: text(400),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(10),
    ageMin: z.number().int().min(18).max(65),
    ageMax: z.number().int().min(18).max(65),
    genders: z.enum(["ALL", "FEMALE", "MALE"]),
    interests: z.array(text(80)).max(10),
  }),
  placements: z.array(z.enum(AD_PLACEMENTS)).min(1).max(AD_PLACEMENTS.length),
  creative: z.strictObject({
    headline: text(120),
    primaryText: text(1000),
    callToAction: z.enum(AD_CALLS_TO_ACTION),
    assetRef: z
      .string()
      .regex(/^M[1-9]$/)
      .nullable(),
  }),
  rationale: text(600),
});

// A reply to one customer comment or message (AI Social Manager). The model also reads
// the interaction (category, sentiment) and says how sure it is and whether a person must
// take over; `reply` is null when it should not answer at all (spam, abuse).
export const SOCIAL_CATEGORIES = [
  "question",
  "complaint",
  "praise",
  "lead",
  "spam",
  "other",
] as const;
const socialReplySchema = z.strictObject({
  category: z.enum(SOCIAL_CATEGORIES),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  reply: text(1000).nullable(),
  confidence: z.number().int().min(0).max(100),
  needsHuman: z.boolean(),
  reason: text(300),
});

// The agent's self-review: a full rewrite of its guidance from the feedback it received,
// with the changes listed so a person can decide whether to apply it.
const socialLearningSchema = z.strictObject({
  guidance: text(6000),
  changes: z.array(text(300)).min(1).max(10),
  rationale: text(600),
});

const variantSchema = z.strictObject({ caption: text(3000), hook: text(300), cta: text(200) });

const copySchema = z.strictObject({
  title: text(200),
  contentType: z.enum(ContentType),
  caption: text(3000),
  hook: text(300),
  cta: text(200),
  hashtags: z.array(hashtag).max(15),
  variants: z.array(variantSchema).max(3),
});

const draftSchema = z.strictObject({
  caption: text(3000),
  hook: text(300),
  cta: text(200),
  hashtags: z.array(hashtag).max(15),
});

export const OUTPUT_SCHEMAS = {
  IDEAS: z.strictObject({ ideas: z.array(ideaSchema).min(3).max(10) }),
  BRIEF: briefSchema,
  COPY: copySchema,
  CONTENT_DRAFT: draftSchema,
  CONTENT_REWRITE: draftSchema,
  CONTENT_ALTERNATIVES: z.strictObject({ alternatives: z.array(variantSchema).min(1).max(3) }),
  CONTENT_HOOK: z.strictObject({ hooks: z.array(text(300)).min(1).max(5) }),
  CONTENT_CTA: z.strictObject({ ctas: z.array(text(200)).min(1).max(5) }),
  CONTENT_BRIEF: briefSchema,
  AD_PLAN: adPlanSchema,
  SOCIAL_REPLY: socialReplySchema,
  SOCIAL_LEARNING: socialLearningSchema,
} as const satisfies Record<AiOperation, z.ZodType>;

export type AiOutput<O extends AiOperation> = z.output<(typeof OUTPUT_SCHEMAS)[O]>;
export type AnyAiOutput = { [O in AiOperation]: AiOutput<O> }[AiOperation];
export type IdeasOutput = AiOutput<"IDEAS">;
export type BriefOutput = AiOutput<"BRIEF">;
export type CopyOutput = AiOutput<"COPY">;
export type DraftOutput = AiOutput<"CONTENT_DRAFT">;
export type AdPlanOutput = AiOutput<"AD_PLAN">;
export type SocialReplyOutput = AiOutput<"SOCIAL_REPLY">;
export type SocialLearningOutput = AiOutput<"SOCIAL_LEARNING">;

/** Operations that never become content (they belong to another area, e.g. advertising). */
export const NON_CONTENT_OPERATIONS = [
  "AD_PLAN",
  "SOCIAL_REPLY",
  "SOCIAL_LEARNING",
] as const satisfies AiOperation[];

export function isContentOperation(operation: AiOperation): boolean {
  return !(NON_CONTENT_OPERATIONS as readonly AiOperation[]).includes(operation);
}

/** Operations that create new content vs. assist an existing draft. */
export const NEW_CONTENT_OPERATIONS = ["IDEAS", "BRIEF", "COPY"] as const satisfies AiOperation[];
export const ASSIST_OPERATIONS = [
  "CONTENT_DRAFT",
  "CONTENT_REWRITE",
  "CONTENT_ALTERNATIVES",
  "CONTENT_HOOK",
  "CONTENT_CTA",
  "CONTENT_BRIEF",
] as const satisfies AiOperation[];

export type NewContentOperation = (typeof NEW_CONTENT_OPERATIONS)[number];
export type AssistOperation = (typeof ASSIST_OPERATIONS)[number];

export function isAssistOperation(operation: AiOperation): operation is AssistOperation {
  return (ASSIST_OPERATIONS as readonly AiOperation[]).includes(operation);
}

/** Output-token budget per operation. */
export const MAX_OUTPUT_TOKENS: Readonly<Record<AiOperation, number>> = {
  IDEAS: 2500,
  BRIEF: 1500,
  COPY: 2500,
  CONTENT_DRAFT: 1500,
  CONTENT_REWRITE: 1500,
  CONTENT_ALTERNATIVES: 2000,
  CONTENT_HOOK: 600,
  CONTENT_CTA: 600,
  CONTENT_BRIEF: 1500,
  AD_PLAN: 1500,
  SOCIAL_REPLY: 700,
  SOCIAL_LEARNING: 2500,
};

/**
 * How many choices a result offers when it is used (an index from 0): one idea, the main
 * copy or one of its variants, one alternative, hook or CTA. Others have one choice.
 */
export function choiceCount(operation: AiOperation, output: AnyAiOutput): number {
  const record = output as Record<string, unknown>;
  switch (operation) {
    case "IDEAS":
      return (record.ideas as unknown[]).length;
    case "COPY":
      return 1 + (record.variants as unknown[]).length;
    case "CONTENT_ALTERNATIVES":
      return (record.alternatives as unknown[]).length;
    case "CONTENT_HOOK":
      return (record.hooks as unknown[]).length;
    case "CONTENT_CTA":
      return (record.ctas as unknown[]).length;
    case "BRIEF":
    case "CONTENT_BRIEF":
    case "CONTENT_DRAFT":
    case "CONTENT_REWRITE":
    case "AD_PLAN":
    case "SOCIAL_REPLY":
    case "SOCIAL_LEARNING":
      return 1;
  }
}

/** One JSON object from the raw text; a single surrounding Markdown code fence is allowed. */
function extractJson(raw: string): unknown {
  if (raw.length > MAX_OUTPUT_CHARS) {
    throw new AiProviderError("invalid_output", "Response is too large");
  }
  let body = raw.trim();
  if (body === "") throw new AiProviderError("invalid_output", "Empty response");
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fence !== null) body = fence[1] ?? "";
  if (!body.startsWith("{")) throw new AiProviderError("invalid_output", "Not a JSON object");
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new AiProviderError("invalid_output", "Malformed JSON", { cause: error });
  }
}

/** Replaces reference handles the model was not shown with null. */
function dropUnknownReferences(value: unknown, known: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => dropUnknownReferences(item, known));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] =
      (key === "pillarRef" || key === "campaignRef" || key === "assetRef") &&
      typeof entry === "string" &&
      !known.has(entry)
        ? null
        : dropUnknownReferences(entry, known);
  }
  return result;
}

/**
 * Parses and validates a model response for `operation`. `handles` are the reference
 * handles present in the request's context. Throws `invalid_output` on any violation.
 */
export function parseOutput<O extends AiOperation>(
  operation: O,
  raw: string,
  handles: ReadonlySet<string>,
): AiOutput<O> {
  const parsed = OUTPUT_SCHEMAS[operation].safeParse(extractJson(raw));
  if (!parsed.success) {
    throw new AiProviderError("invalid_output", "Response does not match the schema", {
      cause: parsed.error,
    });
  }
  return dropUnknownReferences(parsed.data, handles) as AiOutput<O>;
}

/** Re-validates stored output (it is re-checked whenever it is read back). */
export function readStoredOutput<O extends AiOperation>(
  operation: O,
  value: unknown,
): AiOutput<O> | null {
  const parsed = OUTPUT_SCHEMAS[operation].safeParse(value);
  return parsed.success ? (parsed.data as AiOutput<O>) : null;
}

/** All user-visible strings of an output (forbidden-word checks). */
export function outputStrings(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.flatMap(outputStrings);
  if (typeof output === "object" && output !== null) {
    return Object.entries(output).flatMap(([key, value]) =>
      key === "pillarRef" || key === "campaignRef" || key === "assetRef" || key === "contentType"
        ? []
        : outputStrings(value),
    );
  }
  return [];
}

/** Brand forbidden words that appear in the output (case-insensitive), in brand order. */
export function forbiddenWordsIn(output: unknown, forbiddenWords: readonly string[]): string[] {
  const haystack = outputStrings(output).join("\n").toLocaleLowerCase();
  return forbiddenWords.filter((word) => {
    const needle = word.trim().toLocaleLowerCase();
    return needle !== "" && haystack.includes(needle);
  });
}

export const AI_OPERATIONS = Object.values(AiOperation);
