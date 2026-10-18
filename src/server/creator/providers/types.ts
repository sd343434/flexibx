import { z } from "zod";

// Provider boundaries of the Creator Studio. The pipeline depends only on these
// contracts; a commercial speech-to-text or translation service is added as another
// implementation (adapter + env selection), without touching the pipeline. Pure.

export interface TimedText {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface TranscriptionResult {
  /** BCP 47 language of the speech (as detected or as requested). */
  readonly language: string;
  readonly segments: readonly TimedText[];
  /** Seconds the provider billed (null when it does not say). */
  readonly billedSeconds: number | null;
}

export interface TranscriptionProvider {
  /** Stored with every transcript (e.g. `simulated`, or a vendor id). */
  readonly id: string;
  readonly model: string;
  /** True when the text does not come from the media (the built-in simulator). */
  readonly simulated: boolean;
  /** Longest media it accepts. */
  readonly maxDurationMs: number;
  readonly supportsLanguage: (language: string) => boolean;
  transcribe(input: {
    readonly audioPath: string;
    readonly durationMs: number;
    readonly languageHint: string | null;
    readonly signal: AbortSignal;
  }): Promise<TranscriptionResult>;
}

export interface TranslationProvider {
  readonly id: string;
  readonly model: string;
  readonly simulated: boolean;
  readonly supportsLanguage: (language: string) => boolean;
  /** Same cues, same timestamps, translated text. */
  translate(input: {
    readonly segments: readonly TimedText[];
    readonly from: string;
    readonly to: string;
    readonly signal: AbortSignal;
  }): Promise<readonly TimedText[]>;
}

export interface ClipSuggestion {
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** Signal codes behind the suggestion. */
  readonly reasons: readonly string[];
  /** Internal ranking 0–100 — not a probability that the clip will perform. */
  readonly score: number;
}

export interface ClipSuggestionProvider {
  readonly id: string;
  suggest(input: {
    readonly segments: readonly TimedText[];
    readonly durationMs: number;
  }): readonly ClipSuggestion[];
}

/** Why a provider call failed (codes only — never a provider's message). */
export type ProviderFailure =
  | "unsupported_language"
  | "too_long"
  | "quota_exceeded"
  | "unavailable"
  | "invalid_output"
  | "timeout";

export class CreatorProviderError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    /** Worth another attempt (a temporary outage, a timeout). */
    readonly retryable: boolean,
  ) {
    super(`Creator provider failed: ${failure}`);
    this.name = "CreatorProviderError";
  }
}

export const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;

/** Validates what any provider returns before anything is stored. */
export function validateTimedText(segments: readonly TimedText[], durationMs: number): TimedText[] {
  const schema = z
    .array(
      z.object({
        startMs: z.number().int().min(0),
        endMs: z.number().int().positive(),
        text: z.string().trim().min(1).max(2000),
      }),
    )
    .max(5000);
  const parsed = schema.safeParse(segments);
  if (!parsed.success) throw new CreatorProviderError("invalid_output", false);
  let previousEnd = 0;
  for (const segment of parsed.data) {
    // In order, inside the media (one second of tolerance for rounding), never empty.
    if (
      segment.endMs <= segment.startMs ||
      segment.startMs < previousEnd - 1 ||
      segment.endMs > durationMs + 1000
    ) {
      throw new CreatorProviderError("invalid_output", false);
    }
    previousEnd = segment.endMs;
  }
  return parsed.data.map((segment) => ({ ...segment, endMs: Math.min(segment.endMs, durationMs) }));
}
