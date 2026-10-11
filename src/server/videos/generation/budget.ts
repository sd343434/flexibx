import type { VideoSpec, VideoTier } from "@/server/ai/providers/video/gateway";

// Video cost accounting rules (§4.2.8). Pure (unit tested). Money is in millionths of a
// US dollar (micros), as BigInt. The worst case — every allowed attempt billed at the
// full duration — is reserved before anything is submitted; each attempt captures what
// it was charged; the remainder is released when the job ends (never while an attempt's
// outcome is unknown).

export const VIDEO_LEDGER_CATEGORY = "VIDEO_GENERATIVE";

/** Versioned prices per provider. Every job and ledger entry stores the version used. */
export interface VideoRateCard {
  readonly version: string;
  /** Price per generated second, by tier. */
  readonly perSecondMicros: Readonly<Record<VideoTier, bigint>>;
}

/**
 * The fake provider's rate card. PLACEHOLDER prices — no money is spent; they exist so
 * the reservation, capture and release path is exercised with non-zero amounts. A real
 * provider gets its own card from its published price list (decision before use).
 */
export const FAKE_VIDEO_RATE_CARD: VideoRateCard = {
  version: "fake-2026-10-09",
  perSecondMicros: { DRAFT: 50_000n, STANDARD: 150_000n },
};

/** Per-job and per-workspace bounds (defaults; see docs). */
export interface VideoLimits {
  /** First attempt plus automatic retries. */
  readonly maxAttempts: number;
  /** Wall time from the reservation; later attempts time out. */
  readonly maxWallTimeMs: number;
  /** Largest worst-case reservation a single request may make without an approval flow. */
  readonly perRequestMaxMicros: bigint;
  /** Committed (reserved − released) video spend per workspace per UTC day. */
  readonly dailyBudgetMicros: bigint;
}

export const DEFAULT_VIDEO_LIMITS: VideoLimits = {
  maxAttempts: 2,
  maxWallTimeMs: 20 * 60 * 1000,
  perRequestMaxMicros: 5_000_000n,
  dailyBudgetMicros: 20_000_000n,
};

export function costMicros(card: VideoRateCard, tier: VideoTier, seconds: number): bigint {
  if (!Number.isInteger(seconds) || seconds < 0)
    throw new RangeError("seconds must be a whole number ≥ 0");
  return card.perSecondMicros[tier] * BigInt(seconds);
}

/** The worst case reserved for a job: every attempt billed for the full clip. */
export function reservationMicros(
  card: VideoRateCard,
  tier: VideoTier,
  spec: Pick<VideoSpec, "durationSeconds">,
  maxAttempts: number,
): bigint {
  return costMicros(card, tier, spec.durationSeconds) * BigInt(maxAttempts);
}

/**
 * What one attempt is charged: the provider-reported billed seconds when it reports
 * them, otherwise the estimate for the full clip (flagged as estimated). Never more than
 * what is still reserved and not captured.
 */
export function attemptCharge(
  card: VideoRateCard,
  tier: VideoTier,
  durationSeconds: number,
  billedSeconds: number | null,
  remainingMicros: bigint,
): { readonly micros: bigint; readonly estimated: boolean } {
  const estimated = billedSeconds === null;
  const raw = costMicros(card, tier, billedSeconds ?? durationSeconds);
  return { micros: raw < remainingMicros ? raw : remainingMicros, estimated };
}

/** The UTC calendar day of an instant (the ledger period). */
export function ledgerPeriod(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
