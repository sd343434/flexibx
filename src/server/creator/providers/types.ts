import { z } from "zod";

// Provider boundaries of the Creator Studio. The pipeline depends only on these
// contracts; a speech-to-text or translation service is one implementation (adapter +
// env selection) — today the declared simulator and OpenAI. Pure.

/** Where a provider runs, for the person deciding to send media to it. */
export interface ProviderProcessing {
  /** True when audio or text leaves the deployment (an external service). */
  readonly external: boolean;
  /** Processing region as documented by the vendor (null: not external / unknown). */
  readonly region: string | null;
}

export interface TimedText {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface TranscriptionResult {
  /** BCP 47 language of the speech (as detected or as requested). */
  readonly language: string;
  readonly segments: readonly TimedText[];
  /** Seconds of audio the provider processed (null when it does not say). */
  readonly billedSeconds: number | null;
}

export interface TranscriptionProvider extends ProviderProcessing {
  /** Stored with every transcript (e.g. `simulated`, or a vendor id). */
  readonly id: string;
  readonly model: string;
  /** True when the text does not come from the media (the built-in simulator). */
  readonly simulated: boolean;
  /** Longest media it accepts. */
  readonly maxDurationMs: number;
  readonly supportsLanguage: (language: string) => boolean;
  /**
   * When set, the pipeline sends the audio in consecutive pieces of at most this length
   * (encoded as small Opus files) and offsets the timestamps itself; each piece's result
   * is kept, so a retried step never pays for a piece twice. Null: the whole 16 kHz WAV
   * in one call.
   */
  readonly chunkMs: number | null;
  /** Estimated price per second of audio in micro-USD (null: free or unknown). */
  readonly costMicroUsdPerAudioSecond: number | null;
  transcribe(input: {
    readonly audioPath: string;
    readonly durationMs: number;
    readonly languageHint: string | null;
    readonly signal: AbortSignal;
  }): Promise<TranscriptionResult>;
}

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface TranslationProvider extends ProviderProcessing {
  readonly id: string;
  readonly model: string;
  readonly simulated: boolean;
  readonly supportsLanguage: (language: string) => boolean;
  /**
   * Cues per call. The pipeline translates in batches of this size and keeps each
   * batch's result, so a retried step resumes after the last batch it paid for.
   */
  readonly batchSize: number;
  /** Same cues, same timestamps, translated text. */
  translate(input: {
    readonly segments: readonly TimedText[];
    readonly from: string;
    readonly to: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly segments: readonly TimedText[]; readonly usage: ProviderUsage | null }>;
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

/**
 * Why a provider call failed (codes only — never a provider's message).
 * - `rate_limited`, `unavailable`: the provider answered that it did not do the work
 *   (429, 5xx) or could not be reached; worth another attempt later.
 * - `outcome_unknown`: the request was sent and no answer came back (connection reset,
 *   the request's own timeout). The provider may have done — and billed — the work, so
 *   it is NOT retried automatically; a person decides.
 * - `rejected` (the request itself was refused: 400, 413, 415…), `auth` (401/403: key or
 *   permissions), `invalid_output`: retrying the same request cannot help.
 */
export type ProviderFailure =
  | "unsupported_language"
  | "too_long"
  | "quota_exceeded"
  | "unavailable"
  | "invalid_output"
  | "timeout"
  | "rate_limited"
  | "rejected"
  | "auth"
  | "outcome_unknown";

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
