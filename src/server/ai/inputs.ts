import { z } from "zod";

import { ContentType } from "@/generated/prisma/enums";

import { optionalId, optionalText } from "../marketing/inputs";

import { ASSIST_OPERATIONS } from "./operations";

// Input schemas for AI actions (pure, strict). The person's text is a request, never an
// instruction to the server: it is length-bounded here and fenced as data in the prompt.
// Ids are lookup keys inside the current workspace only.

const slug = z.string().min(1).max(100);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
/** Output language; unset = the brand's content language, else the person's UI locale. */
const language = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.enum(["ar", "en"]).optional(),
);
/** The person's UI locale: the last fallback for the output language. */
const uiLocale = z.preprocess(
  (value) => (value === "" || value === undefined ? "ar" : value),
  z.enum(["ar", "en"]),
);
const integer = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === "" ? fallback : value),
    z.coerce.number().int().min(min).max(max),
  );
const optionalContentType = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z.enum(ContentType).nullable(),
);

export const generateIdeasInputSchema = z.strictObject({
  slug,
  uiLocale,
  language,
  topic: optionalText(500),
  count: integer(3, 10, 5),
  pillarId: optionalId,
  campaignId: optionalId,
});

export const generateBriefInputSchema = z.strictObject({
  slug,
  uiLocale,
  language,
  topic: requiredText(500),
  contentType: optionalContentType,
  pillarId: optionalId,
  campaignId: optionalId,
});

export const generateCopyInputSchema = z.strictObject({
  slug,
  uiLocale,
  language,
  topic: requiredText(1000),
  contentType: optionalContentType,
  campaignId: optionalId,
  variants: integer(0, 3, 2),
});

export const assistContentInputSchema = z.strictObject({
  slug,
  uiLocale,
  contentId: z.uuid(),
  operation: z.enum(ASSIST_OPERATIONS),
  language,
  instructions: optionalText(500),
});

export const applyGenerationInputSchema = z.strictObject({
  slug,
  generationId: z.uuid(),
  choice: integer(0, 9, 0),
});

export type GenerateIdeasInput = z.output<typeof generateIdeasInputSchema>;
export type GenerateBriefInput = z.output<typeof generateBriefInputSchema>;
export type GenerateCopyInput = z.output<typeof generateCopyInputSchema>;
export type AssistContentInput = z.output<typeof assistContentInputSchema>;
