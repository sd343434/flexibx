import { z } from "zod";

import type {
  CampaignStatus,
  ContentStatus,
  ContentType,
  MarketingChannel,
  MetricSource,
  PerformanceMetric,
  RecommendationKind,
} from "@/generated/prisma/enums";

import { isMoneyMetric } from "./metrics";

// Summaries and recommendations from recorded observations (Pass 5). Pure and
// deterministic: the same observations, campaigns and thresholds always give the same
// result. Rules that keep the numbers honest:
// - Simulated numbers are never combined with recorded ones: every summary is computed
//   per evidence class, and recommendations use recorded numbers only (MANUAL today;
//   VERIFIED once a provider integration exists).
// - Each observation identity (provider + source reference) counts once.
// - A campaign total uses its campaign-level observations when it has any for that metric;
//   otherwise it adds up its content-level observations (never both, so nothing is counted
//   twice).
// - Money is totalled per currency and compared only with a budget in the same currency.
// - A rule that lacks evidence says so ("more data needed") instead of judging.
// - Findings describe what was recorded. They are associations, not causes, and never a
//   forecast of revenue or return.

/** Thresholds of the recommendation rules. Shown in the dashboard ("How this works"). */
export const rulesSchema = z.strictObject({
  /** A content item is compared only with at least this many impressions in the period. */
  minImpressionsPerContent: z.number().int().min(1).max(1_000_000),
  /** …observed over at least this many days (a lifetime number counts the days it spans). */
  minDaysPerContent: z.number().int().min(1).max(90),
  /** At least this many comparable content items before any of them is judged. */
  minComparableContent: z.number().int().min(3).max(100),
  /** Weak: engagement rate below this share of the campaign's median rate. */
  weakRatio: z.number().gt(0).lt(1),
  /** Strong format: median rate of a content type at least this multiple of the median. */
  strongRatio: z.number().gt(1).max(10),
  /** …with at least this many comparable items of that type, and of the other types. */
  minPerFormat: z.number().int().min(2).max(50),
  /** Recorded data older than this many days (active campaign) is stale. */
  staleAfterDays: z.number().int().min(1).max(90),
  /** A target is judged only after this share of the campaign's window has passed. */
  minElapsedShare: z.number().gt(0).max(1),
  /** Below target: recorded total under this share of the pro-rata expected value. */
  belowTargetRatio: z.number().gt(0).max(1),
  /** Spend over budget: recorded spend above this multiple of the planned budget. */
  spendBudgetRatio: z.number().gt(0).max(10),
});
export type Rules = z.output<typeof rulesSchema>;

export const DEFAULT_RULES: Rules = rulesSchema.parse({
  minImpressionsPerContent: 500,
  minDaysPerContent: 2,
  minComparableContent: 4,
  weakRatio: 0.5,
  strongRatio: 1.5,
  minPerFormat: 2,
  staleAfterDays: 7,
  minElapsedShare: 0.25,
  belowTargetRatio: 0.8,
  spendBudgetRatio: 1,
});

export type EvidenceClass = "recorded" | "simulated";

export function evidenceClass(source: MetricSource): EvidenceClass {
  return source === "SIMULATED" ? "simulated" : "recorded";
}

export interface Observation {
  readonly campaignId: string;
  readonly contentItemId: string | null;
  readonly channel: MarketingChannel;
  readonly provider: string;
  readonly source: MetricSource;
  readonly metric: PerformanceMetric;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly value: bigint;
  readonly currency: string | null;
  readonly sourceRef: string;
  /** When the value was read; of several values of one identity, the latest counts. */
  readonly observedAt: Date;
}

export interface CampaignFacts {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly budgetMinor: bigint | null;
  readonly budgetCurrency: string | null;
  readonly goals: readonly {
    readonly id: string;
    readonly title: string;
    readonly targetMetric: PerformanceMetric | null;
    readonly target: number | null;
    readonly active: boolean;
  }[];
  readonly content: readonly {
    readonly id: string;
    readonly title: string;
    readonly type: ContentType;
    readonly status: ContentStatus;
  }[];
  /** The last import attempt of each provider for this workspace. */
  readonly lastFailureAt: Date | null;
  readonly lastSuccessAt: Date | null;
}

const DAY_MS = 24 * 3_600_000;
const day = (at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());

/**
 * Each identity once: its latest value (the most recent observedAt; on a tie, the first
 * given). A provider's revised number replaces the earlier one here — the earlier rows
 * stay stored as history — so nothing is counted twice. Order: first appearance.
 */
export function distinctObservations(rows: readonly Observation[]): Observation[] {
  const latest = new Map<string, Observation>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.sourceRef}`;
    const kept = latest.get(key);
    if (kept === undefined || row.observedAt.getTime() > kept.observedAt.getTime()) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

/**
 * One source per content item and metric: when a provider read the item's numbers
 * (VERIFIED), a person's numbers for the same item and metric are set aside — the two
 * describe the same views or clicks, and adding them would count them twice. Rows without
 * content (campaign-level) are kept as they are.
 */
export function preferVerified(rows: readonly Observation[]): Observation[] {
  const verified = new Set(
    rows
      .filter((row) => row.source === "VERIFIED" && row.contentItemId !== null)
      .map((row) => `${row.contentItemId ?? ""}|${row.metric}`),
  );
  return rows.filter(
    (row) =>
      row.contentItemId === null ||
      row.source === "VERIFIED" ||
      !verified.has(`${row.contentItemId}|${row.metric}`),
  );
}

export interface Total {
  readonly metric: PerformanceMetric;
  /** Null for counts. */
  readonly currency: string | null;
  readonly value: bigint;
  readonly observations: number;
  /** Earliest start and latest end of the counted periods. */
  readonly from: Date;
  readonly to: Date;
}

/**
 * Totals per metric (and currency) for one campaign's observations of one evidence class:
 * campaign-level rows when the metric has any, else content-level rows.
 */
export function campaignTotals(rows: readonly Observation[]): Total[] {
  const groups = new Map<string, Observation[]>();
  for (const row of distinctObservations(preferVerified(rows))) {
    const key = `${row.metric}|${row.currency ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const totals: Total[] = [];
  for (const group of groups.values()) {
    const campaignLevel = group.filter((row) => row.contentItemId === null);
    const counted = campaignLevel.length > 0 ? campaignLevel : group;
    const first = counted[0];
    if (first === undefined) continue;
    totals.push({
      metric: first.metric,
      currency: first.currency,
      value: counted.reduce((sum, row) => sum + row.value, 0n),
      observations: counted.length,
      from: new Date(Math.min(...counted.map((row) => row.periodStart.getTime()))),
      to: new Date(Math.max(...counted.map((row) => row.periodEnd.getTime()))),
    });
  }
  return totals.sort(
    (a, b) =>
      a.metric.localeCompare(b.metric) || (a.currency ?? "").localeCompare(b.currency ?? ""),
  );
}

/**
 * Daily totals of one count metric (each day: campaign-level rows if any, else content
 * rows). Only single-day numbers are plotted: a number over a longer period (a weekly
 * import, a post's lifetime views) is not a day's value and would show as a false spike on
 * its first day; it stays in the summaries.
 */
export function dailySeries(
  rows: readonly Observation[],
  metric: PerformanceMetric,
): { readonly day: Date; readonly value: bigint }[] {
  const byDay = new Map<number, Observation[]>();
  for (const row of distinctObservations(preferVerified(rows))) {
    if (row.metric !== metric || row.currency !== null) continue;
    if (day(row.periodStart) !== day(row.periodEnd)) continue;
    const key = day(row.periodStart);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, group]) => {
      const campaignLevel = group.filter((row) => row.contentItemId === null);
      const counted = campaignLevel.length > 0 ? campaignLevel : group;
      return { day: new Date(key), value: counted.reduce((sum, row) => sum + row.value, 0n) };
    });
}

/** What a content item's engagement rate is measured against. */
export type ExposureMetric = "IMPRESSIONS" | "VIEWS";

export interface ContentResult {
  readonly contentItemId: string;
  /**
   * IMPRESSIONS when the item has any (people's imports), else VIEWS (Meta reports views
   * now); null without either. Items are only compared with items of the same measure.
   */
  readonly exposureMetric: ExposureMetric | null;
  readonly exposure: bigint;
  readonly impressions: bigint;
  readonly views: bigint;
  readonly engagements: bigint;
  readonly clicks: bigint;
  /** Distinct days covered by the exposure numbers. */
  readonly days: number;
  /** Engagements per exposure; null without exposure. */
  readonly engagementRate: number | null;
}

/** At most this many days are counted per observation (its longest allowed period). */
const MAX_COVERED_DAYS = 92;

/** Per-content totals of the count metrics used for comparisons. */
export function contentResults(rows: readonly Observation[]): ContentResult[] {
  const byContent = new Map<string, Observation[]>();
  for (const row of distinctObservations(preferVerified(rows))) {
    if (row.contentItemId === null) continue;
    byContent.set(row.contentItemId, [...(byContent.get(row.contentItemId) ?? []), row]);
  }
  return [...byContent.entries()].map(([contentItemId, group]) => {
    const sum = (metric: PerformanceMetric) =>
      group.filter((row) => row.metric === metric).reduce((total, row) => total + row.value, 0n);
    const impressions = sum("IMPRESSIONS");
    const views = sum("VIEWS");
    const engagements = sum("ENGAGEMENTS");
    const exposureMetric: ExposureMetric | null = group.some((row) => row.metric === "IMPRESSIONS")
      ? "IMPRESSIONS"
      : group.some((row) => row.metric === "VIEWS")
        ? "VIEWS"
        : null;
    const exposure = exposureMetric === "IMPRESSIONS" ? impressions : views;
    const covered = new Set<number>();
    for (const row of group) {
      if (row.metric !== exposureMetric) continue;
      const span = Math.min(
        (day(row.periodEnd) - day(row.periodStart)) / DAY_MS + 1,
        MAX_COVERED_DAYS,
      );
      for (let offset = 0; offset < span; offset += 1) {
        covered.add(day(row.periodStart) + offset * DAY_MS);
      }
    }
    return {
      contentItemId,
      exposureMetric,
      exposure,
      impressions,
      views,
      engagements,
      clicks: sum("CLICKS"),
      days: covered.size,
      engagementRate: exposure === 0n ? null : Number(engagements) / Number(exposure),
    };
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export type Sufficiency = "sufficient" | "limited";

/** One finding: what was observed, how much evidence backs it, and what to do. */
export interface Finding {
  readonly kind: RecommendationKind;
  readonly fingerprint: string;
  readonly campaignId: string;
  readonly contentItemId: string | null;
  readonly evidence: {
    /** The observed period (ISO dates), when there is one. */
    readonly from: string | null;
    readonly to: string | null;
    /** Observations used. */
    readonly sampleSize: number;
    readonly sufficiency: Sufficiency;
    /** The numbers behind the finding (strings for big integers). */
    readonly values: Readonly<Record<string, string | number | null>>;
  };
}

const isoDay = (at: Date | null) => (at === null ? null : at.toISOString().slice(0, 10));

/** Findings for one campaign from its recorded (never simulated) observations. */
export function campaignFindings(
  campaign: CampaignFacts,
  allRows: readonly Observation[],
  now: Date,
  rules: Rules = DEFAULT_RULES,
): Finding[] {
  const rows = distinctObservations(
    preferVerified(
      allRows.filter(
        (row) => row.campaignId === campaign.id && evidenceClass(row.source) === "recorded",
      ),
    ),
  );
  const findings: Finding[] = [];
  const add = (
    kind: RecommendationKind,
    key: string,
    contentItemId: string | null,
    evidence: Finding["evidence"],
  ) => {
    findings.push({
      kind,
      fingerprint: `${kind}:${campaign.id}:${key}`,
      campaignId: campaign.id,
      contentItemId,
      evidence,
    });
  };
  const today = day(now);
  const published = campaign.content.filter((item) => item.status === "PUBLISHED").length;
  const running = campaign.status === "ACTIVE" || campaign.status === "COMPLETED";

  if (rows.length === 0) {
    if (running && published > 0) {
      add("MISSING_DATA", "-", null, {
        from: isoDay(campaign.startDate),
        to: isoDay(campaign.endDate),
        sampleSize: 0,
        sufficiency: "limited",
        values: { publishedContent: published },
      });
    }
    return findings;
  }

  const totals = campaignTotals(rows);
  const from = new Date(Math.min(...rows.map((row) => row.periodStart.getTime())));
  const to = new Date(Math.max(...rows.map((row) => row.periodEnd.getTime())));

  // Stale: an active campaign whose latest recorded period ended too long ago, or whose
  // last import attempt failed after the last successful one.
  const ageDays = Math.floor((today - day(to)) / DAY_MS);
  const failedLast =
    campaign.lastFailureAt !== null &&
    (campaign.lastSuccessAt === null || campaign.lastFailureAt > campaign.lastSuccessAt);
  if (campaign.status === "ACTIVE" && (ageDays > rules.staleAfterDays || failedLast)) {
    add("STALE_DATA", "-", null, {
      from: isoDay(from),
      to: isoDay(to),
      sampleSize: rows.length,
      sufficiency: "sufficient",
      values: {
        daysSinceLatest: ageDays,
        staleAfterDays: rules.staleAfterDays,
        lastImportFailed: failedLast ? 1 : 0,
      },
    });
  }

  // Below target: compared pro rata over the campaign window, only for count metrics,
  // only after enough of the window has passed.
  if (campaign.startDate !== null && campaign.endDate !== null) {
    const span = day(campaign.endDate) - day(campaign.startDate) + DAY_MS;
    const elapsed = Math.min(1, Math.max(0, (today - day(campaign.startDate) + DAY_MS) / span));
    for (const goal of campaign.goals) {
      if (!goal.active || goal.targetMetric === null || goal.target === null || goal.target <= 0)
        continue;
      if (isMoneyMetric(goal.targetMetric)) continue;
      const total = totals.find(
        (entry) => entry.metric === goal.targetMetric && entry.currency === null,
      );
      if (total === undefined || elapsed < rules.minElapsedShare) {
        add("MORE_DATA_NEEDED", `goal:${goal.id}`, null, {
          from: isoDay(from),
          to: isoDay(to),
          sampleSize: total?.observations ?? 0,
          sufficiency: "limited",
          values: {
            goal: goal.title,
            metric: goal.targetMetric,
            target: goal.target,
            elapsedShare: Math.round(elapsed * 100) / 100,
            minElapsedShare: rules.minElapsedShare,
          },
        });
        continue;
      }
      const expected = goal.target * elapsed;
      const actual = Number(total.value);
      if (actual < expected * rules.belowTargetRatio) {
        add("BELOW_TARGET", `goal:${goal.id}`, null, {
          from: isoDay(total.from),
          to: isoDay(total.to),
          sampleSize: total.observations,
          sufficiency: "sufficient",
          values: {
            goal: goal.title,
            metric: goal.targetMetric,
            actual,
            target: goal.target,
            expectedSoFar: Math.round(expected),
            elapsedShare: Math.round(elapsed * 100) / 100,
            belowTargetRatio: rules.belowTargetRatio,
          },
        });
      }
    }
  }

  // Spend against the planned budget, in the budget's currency only.
  if (campaign.budgetMinor !== null && campaign.budgetCurrency !== null) {
    const spend = totals.find(
      (entry) => entry.metric === "SPEND" && entry.currency === campaign.budgetCurrency,
    );
    const limit = Number(campaign.budgetMinor) * rules.spendBudgetRatio;
    if (spend !== undefined && Number(spend.value) > limit) {
      add("SPEND_OVER_BUDGET", "-", null, {
        from: isoDay(spend.from),
        to: isoDay(spend.to),
        sampleSize: spend.observations,
        sufficiency: "sufficient",
        values: {
          spendMinor: spend.value.toString(),
          budgetMinor: campaign.budgetMinor.toString(),
          currency: campaign.budgetCurrency,
          spendBudgetRatio: rules.spendBudgetRatio,
        },
      });
    }
  }

  // Content comparisons: only between items with enough impressions over enough periods.
  const types = new Map(campaign.content.map((item) => [item.id, item.type]));
  const qualified = contentResults(rows).filter(
    (result) =>
      result.engagementRate !== null &&
      result.exposure >= BigInt(rules.minImpressionsPerContent) &&
      result.days >= rules.minDaysPerContent &&
      types.has(result.contentItemId),
  );
  // Only items measured the same way are compared: the larger group (impressions on a
  // tie). Views and impressions are different counts and are never mixed.
  const byImpressions = qualified.filter((result) => result.exposureMetric === "IMPRESSIONS");
  const byViews = qualified.filter((result) => result.exposureMetric === "VIEWS");
  const eligible = byViews.length > byImpressions.length ? byViews : byImpressions;
  const exposureMetric: ExposureMetric = eligible === byViews ? "VIEWS" : "IMPRESSIONS";
  const rates = eligible.map((result) => result.engagementRate ?? 0);
  const contentSample = (ids: readonly string[]) =>
    rows.filter((row) => row.contentItemId !== null && ids.includes(row.contentItemId)).length;
  if (eligible.length >= rules.minComparableContent) {
    const middle = median(rates);
    for (const result of eligible) {
      const rate = result.engagementRate ?? 0;
      if (middle > 0 && rate < middle * rules.weakRatio) {
        add("WEAK_CONTENT", `content:${result.contentItemId}`, result.contentItemId, {
          from: isoDay(from),
          to: isoDay(to),
          sampleSize: contentSample([result.contentItemId]),
          sufficiency: "sufficient",
          values: {
            engagementRate: Math.round(rate * 10_000) / 10_000,
            campaignMedianRate: Math.round(middle * 10_000) / 10_000,
            exposureMetric,
            exposure: result.exposure.toString(),
            days: result.days,
            comparedItems: eligible.length,
            weakRatio: rules.weakRatio,
          },
        });
      }
    }
    const byType = new Map<ContentType, ContentResult[]>();
    for (const result of eligible) {
      const type = types.get(result.contentItemId);
      if (type !== undefined) byType.set(type, [...(byType.get(type) ?? []), result]);
    }
    for (const [type, group] of byType) {
      const others = eligible.length - group.length;
      if (group.length < rules.minPerFormat || others < rules.minPerFormat || middle <= 0) continue;
      const typeMedian = median(group.map((result) => result.engagementRate ?? 0));
      if (typeMedian >= middle * rules.strongRatio) {
        add("STRONG_FORMAT", `type:${type}`, null, {
          from: isoDay(from),
          to: isoDay(to),
          sampleSize: contentSample(group.map((result) => result.contentItemId)),
          sufficiency: "sufficient",
          values: {
            contentType: type,
            exposureMetric,
            formatMedianRate: Math.round(typeMedian * 10_000) / 10_000,
            campaignMedianRate: Math.round(middle * 10_000) / 10_000,
            itemsOfFormat: group.length,
            otherItems: others,
            strongRatio: rules.strongRatio,
          },
        });
      }
    }
  } else if (campaign.content.length > 0 && rows.some((row) => row.contentItemId !== null)) {
    add("MORE_DATA_NEEDED", "content", null, {
      from: isoDay(from),
      to: isoDay(to),
      sampleSize: rows.filter((row) => row.contentItemId !== null).length,
      sufficiency: "limited",
      values: {
        comparableItems: eligible.length,
        minComparableContent: rules.minComparableContent,
        minImpressionsPerContent: rules.minImpressionsPerContent,
        minDaysPerContent: rules.minDaysPerContent,
      },
    });
  }
  return findings;
}

/** Kinds a person can turn into a content draft (a follow-up to write). */
export const ACTIONABLE_KINDS: ReadonlySet<RecommendationKind> = new Set([
  "BELOW_TARGET",
  "WEAK_CONTENT",
  "STRONG_FORMAT",
]);
