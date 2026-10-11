import type { AccountSnapshot, Money } from "./model";

// Optimization recommendations from an ad account's HISTORICAL results (the stored
// read-only snapshot). Pure and deterministic. They are suggestions for a person:
// nothing here changes a campaign, and none of them can raise a budget, activate anything
// or send a message — acting on one means a new plan or a separately approved action.
//
// Honesty rules: every number shown is a historical result over the snapshot's window
// (never a forecast); a campaign with too little data is not judged; a redistribution
// only moves money between campaigns (the total never grows) and stays within the
// workspace's daily cap when one is given.

/** Below this many impressions a campaign's rates are too noisy to compare. */
export const MIN_IMPRESSIONS = 1_000;
/** A campaign whose click-through rate is under this share of the account's median underperforms. */
export const UNDERPERFORMANCE_RATIO = 0.5;
/** Share of an underperformer's daily budget suggested for moving. */
export const SHIFT_SHARE = 0.2;

export interface CampaignResult {
  readonly externalId: string;
  readonly name: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: Money;
  /** Clicks per impression (historical). */
  readonly ctr: number;
  /** Spend per click in minor units, null without clicks (historical). */
  readonly cpcMinor: number | null;
}

export type Recommendation =
  | {
      readonly kind: "pause";
      readonly campaign: CampaignResult;
      /** Why: spent with no clicks, or CTR far under the account's median. */
      readonly reason: "no_clicks" | "low_ctr";
      readonly medianCtr: number;
    }
  | {
      readonly kind: "creative_refresh";
      readonly campaign: CampaignResult;
      readonly medianCtr: number;
    }
  | {
      readonly kind: "redistribute";
      readonly from: CampaignResult;
      readonly to: CampaignResult;
      /** Daily amount suggested for moving (the total daily budget stays the same). */
      readonly amount: Money;
    };

export interface OptimizationReport {
  /** "historical": results over `days` days as reported by the platform. */
  readonly basis: {
    readonly kind: "historical";
    readonly days: number;
    readonly fetchedAt: string;
  };
  readonly results: readonly CampaignResult[];
  /** Campaigns not judged for lack of data. */
  readonly insufficient: readonly string[];
  readonly recommendations: readonly Recommendation[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function recommendOptimizations(
  snapshot: AccountSnapshot,
  options: { readonly maxDailyBudgetMinor?: number | null } = {},
): OptimizationReport {
  const campaigns = new Map(snapshot.campaigns.map((campaign) => [campaign.externalId, campaign]));
  const results: CampaignResult[] = [];
  const insufficient: string[] = [];
  for (const metric of snapshot.metrics) {
    const campaign = campaigns.get(metric.campaignExternalId);
    if (campaign === undefined) continue;
    if (metric.impressions < MIN_IMPRESSIONS) {
      insufficient.push(campaign.name);
      continue;
    }
    results.push({
      externalId: campaign.externalId,
      name: campaign.name,
      impressions: metric.impressions,
      clicks: metric.clicks,
      spend: metric.spend,
      ctr: metric.clicks / metric.impressions,
      cpcMinor: metric.clicks === 0 ? null : Math.round(metric.spend.minor / metric.clicks),
    });
  }
  results.sort((a, b) => b.ctr - a.ctr || a.externalId.localeCompare(b.externalId));
  const basis = {
    kind: "historical" as const,
    days: snapshot.range.days,
    fetchedAt: snapshot.fetchedAt,
  };
  // Comparisons need at least two campaigns with enough data.
  if (results.length < 2) return { basis, results, insufficient, recommendations: [] };

  const medianCtr = median(results.map((result) => result.ctr));
  const recommendations: Recommendation[] = [];
  const weak = results.filter(
    (result) =>
      (result.clicks === 0 && result.spend.minor > 0) ||
      result.ctr < medianCtr * UNDERPERFORMANCE_RATIO,
  );
  const best = results[0];
  for (const result of weak) {
    const live = campaigns.get(result.externalId)?.status === "ACTIVE";
    if (live) {
      recommendations.push({
        kind: "pause",
        campaign: result,
        reason: result.clicks === 0 ? "no_clicks" : "low_ctr",
        medianCtr,
      });
    }
    recommendations.push({ kind: "creative_refresh", campaign: result, medianCtr });
    const fromBudget = campaigns.get(result.externalId)?.dailyBudget ?? null;
    const target = best === undefined ? undefined : campaigns.get(best.externalId);
    const toBudget = target?.dailyBudget ?? null;
    if (
      best !== undefined &&
      best.externalId !== result.externalId &&
      live &&
      target?.status === "ACTIVE" &&
      fromBudget !== null &&
      toBudget !== null &&
      fromBudget.currency === toBudget.currency
    ) {
      let amount = Math.floor(fromBudget.minor * SHIFT_SHARE);
      const cap = options.maxDailyBudgetMinor ?? null;
      if (cap !== null) amount = Math.min(amount, Math.max(0, cap - toBudget.minor));
      if (amount > 0) {
        recommendations.push({
          kind: "redistribute",
          from: result,
          to: best,
          amount: { minor: amount, currency: fromBudget.currency },
        });
      }
    }
  }
  return { basis, results, insufficient, recommendations };
}
