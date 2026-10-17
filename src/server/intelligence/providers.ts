import type { MetricSource } from "@/generated/prisma/enums";

import { stableHash } from "../ai/fake-provider";

// The boundary for analytics providers (Pass 5). No real provider is connected: reading
// Page or ad insights from Meta needs App Review approval of the insights permissions
// and a connected Page token (docs/runbooks/PRODUCTION_READINESS_GAPS.md § 10). What
// exists is this interface and a deterministic test adapter that produces SIMULATED
// observations for tests and local demos only — it refuses to start in production, and
// its numbers are labelled as simulated everywhere they appear.

/** One observation as a provider reports it (text, validated like any import). */
export interface ProviderRow {
  /** The provider's own identity of this observation (deduplication key). */
  readonly ref: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly metric: string;
  readonly value: string;
  readonly currency: string;
  readonly contentItemId: string;
}

export interface ProviderBatch {
  /** The provider's identity of this batch: repeating it imports nothing new. */
  readonly batchId: string;
  readonly rows: readonly ProviderRow[];
}

export interface MetricsProvider {
  /** Stable name stored with each import (e.g. "test-fixture"). */
  readonly name: string;
  /** What its numbers are: only a verified integration may ever say VERIFIED. */
  readonly source: Exclude<MetricSource, "VERIFIED" | "MANUAL">;
  fetch(request: {
    readonly campaignId: string;
    readonly contentItemIds: readonly string[];
    readonly from: Date;
    readonly to: Date;
    readonly signal: AbortSignal;
  }): Promise<ProviderBatch>;
}

/** A provider failure, normalized (never the provider's own message or response). */
export class MetricsProviderError extends Error {
  readonly code: "provider_timeout" | "provider_unavailable" | "provider_malformed";

  constructor(code: MetricsProviderError["code"]) {
    super(code);
    this.name = "MetricsProviderError";
    this.code = code;
  }
}

export type TestScenario = "ok" | "unavailable" | "slow" | "malformed" | "contradictory";

const iso = (at: Date) => at.toISOString().slice(0, 10);
const DAY_MS = 24 * 3_600_000;

/**
 * Deterministic test adapter: one observation per content item, metric and day, with
 * values derived from a hash of the ids (the same request always gives the same numbers).
 * Never available in production.
 */
export function createTestMetricsProvider(scenario: TestScenario = "ok"): MetricsProvider {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The test metrics provider is not available in production");
  }
  return {
    name: "test-fixture",
    source: "SIMULATED",
    async fetch(request) {
      if (scenario === "unavailable") throw new MetricsProviderError("provider_unavailable");
      if (scenario === "slow") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 60_000);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new MetricsProviderError("provider_timeout"));
          });
        });
      }
      const rows: ProviderRow[] = [];
      for (let at = request.from.getTime(); at <= request.to.getTime(); at += DAY_MS) {
        const day = iso(new Date(at));
        for (const contentItemId of request.contentItemIds) {
          const seed = stableHash(`${contentItemId}|${day}`);
          const impressions = 400 + (seed % 900);
          const engagements = Math.round(impressions * (0.01 + (seed % 7) / 100));
          for (const [metric, value] of [
            ["IMPRESSIONS", impressions],
            ["ENGAGEMENTS", engagements],
          ] as const) {
            rows.push({
              ref: `test:${contentItemId}:${day}:${metric}`,
              periodStart: day,
              periodEnd: day,
              metric,
              value: scenario === "malformed" ? "not-a-number" : String(value),
              currency: "",
              contentItemId,
            });
          }
        }
      }
      // A provider that reports the same observation twice with different values.
      if (scenario === "contradictory" && rows[0] !== undefined) {
        rows.push({ ...rows[0], value: String(Number(rows[0].value) + 1) });
      }
      return {
        batchId: `test:${request.campaignId}:${iso(request.from)}:${iso(request.to)}`,
        rows,
      };
    },
  };
}
