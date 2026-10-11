import type { AiOperation } from "@/generated/prisma/enums";

// The provider boundary (Phase 4). Pure (no `server-only`) for unit tests. Application
// code never talks to a vendor directly: services build an `AiRequest`, a provider turns
// it into text, and `runProvider` (run.ts) applies the timeout, the retry rule and error
// normalization. Vendor SDKs, keys and model names stay inside a provider module, which
// is only ever imported by server code.

export type AiLanguage = "ar" | "en";

export interface AiRequest {
  readonly operation: AiOperation;
  readonly language: AiLanguage;
  /** Instructions: the application's rules for the model. */
  readonly system: string;
  /** The task, with the workspace context and the person's request fenced as data. */
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export interface AiUsage {
  /** Null when the provider does not report it (never estimated). */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface AiResponse {
  /** Raw model text; always validated by the operation's schema before use. */
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: AiUsage;
}

export interface AiProvider {
  /** Stable provider name stored with each generation (e.g. `fake`). */
  readonly name: string;
  generate(request: AiRequest): Promise<AiResponse>;
}

/** Normalized provider failures. Anything else a provider throws counts as `unavailable`. */
export const AI_FAILURES = [
  "timeout",
  "unavailable",
  "rate_limited",
  "refused",
  "invalid_output",
] as const;

export type AiFailure = (typeof AI_FAILURES)[number];

/** Failures worth one more attempt: transient, and safe because nothing was stored yet. */
export const RETRYABLE_FAILURES: ReadonlySet<AiFailure> = new Set(["timeout", "unavailable"]);

export class AiProviderError extends Error {
  readonly kind: AiFailure;

  constructor(kind: AiFailure, message: string = kind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiProviderError";
    this.kind = kind;
  }
}

export function isAiProviderError(error: unknown): error is AiProviderError {
  return error instanceof AiProviderError;
}
