import { describe, expect, it } from "vitest";

import {
  ACTIONABLE_KINDS,
  campaignFindings,
  campaignTotals,
  contentResults,
  dailySeries,
  DEFAULT_RULES,
  distinctObservations,
  rulesSchema,
  type CampaignFacts,
  type Observation,
} from "@/server/intelligence/analysis";
import {
  CSV_COLUMNS,
  manualSourceRef,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  parseCsv,
  validateRow,
} from "@/server/intelligence/metrics";

// Pure rules of marketing intelligence (Pass 5): row validation, CSV parsing, identities,
// totals without double counting, and the recommendation thresholds.

const TODAY = new Date("2026-10-17T12:00:00Z");
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const ITEMS = [
  "aaaaaaaa-0000-4000-8000-000000000001",
  "aaaaaaaa-0000-4000-8000-000000000002",
  "aaaaaaaa-0000-4000-8000-000000000003",
  "aaaaaaaa-0000-4000-8000-000000000004",
  "aaaaaaaa-0000-4000-8000-000000000005",
] as const;

const raw = (over: Partial<Parameters<typeof validateRow>[0]> = {}) => ({
  periodStart: "2026-10-01",
  periodEnd: "2026-10-07",
  metric: "IMPRESSIONS",
  value: "1200",
  currency: "",
  contentItemId: "",
  ...over,
});

const issueOf = (over: Partial<Parameters<typeof validateRow>[0]>) => {
  const result = validateRow(raw(over), TODAY);
  return result.ok ? null : result.issue;
};

let ref = 0;
const obs = (over: Partial<Observation> = {}): Observation => ({
  campaignId: CAMPAIGN,
  contentItemId: null,
  channel: "FACEBOOK_PAGE",
  provider: "manual",
  source: "MANUAL",
  metric: "IMPRESSIONS",
  periodStart: new Date("2026-10-01T00:00:00Z"),
  periodEnd: new Date("2026-10-07T00:00:00Z"),
  value: 100n,
  currency: null,
  sourceRef: `ref-${String(++ref)}`,
  ...over,
});

const campaign = (over: Partial<CampaignFacts> = {}): CampaignFacts => ({
  id: CAMPAIGN,
  name: "Autumn",
  status: "ACTIVE",
  startDate: new Date("2026-10-01T00:00:00Z"),
  endDate: new Date("2026-10-31T00:00:00Z"),
  budgetMinor: null,
  budgetCurrency: null,
  goals: [],
  content: ITEMS.map((id, index) => ({
    id,
    title: `Item ${String(index + 1)}`,
    type: index < 2 ? "REEL" : "POST",
    status: "PUBLISHED",
  })),
  lastFailureAt: null,
  lastSuccessAt: new Date("2026-10-16T00:00:00Z"),
  ...over,
});

/** Impressions and engagements for one content item over two weekly periods. */
const contentRows = (id: string, impressions: bigint, engagements: bigint, source = "MANUAL") =>
  (["2026-10-01", "2026-10-08"] as const).flatMap((start, week) => {
    const periodStart = new Date(`${start}T00:00:00Z`);
    const periodEnd = new Date(periodStart.getTime() + 6 * 86_400_000);
    return [
      obs({
        contentItemId: id,
        periodStart,
        periodEnd,
        value: impressions,
        source: source as never,
        sourceRef: `${id}-i-${String(week)}`,
      }),
      obs({
        contentItemId: id,
        periodStart,
        periodEnd,
        metric: "ENGAGEMENTS",
        value: engagements,
        source: source as never,
        sourceRef: `${id}-e-${String(week)}`,
      }),
    ];
  });

describe("validateRow", () => {
  it("accepts a count row and a money row in minor units", () => {
    const count = validateRow(raw(), TODAY);
    expect(count).toMatchObject({
      ok: true,
      row: { value: 1200n, currency: null, contentItemId: null },
    });
    const money = validateRow(raw({ metric: "spend", value: "350.5", currency: "sar" }), TODAY);
    expect(money).toMatchObject({
      ok: true,
      row: { metric: "SPEND", value: 35050n, currency: "SAR" },
    });
  });

  it("refuses each kind of bad input with its own code", () => {
    expect(issueOf({ periodStart: "2026-02-30" })).toBe("date_invalid");
    expect(issueOf({ periodStart: "01/10/2026" })).toBe("date_invalid");
    expect(issueOf({ periodStart: "2026-10-08" })).toBe("period_order");
    expect(issueOf({ periodStart: "2026-01-01", periodEnd: "2026-04-10" })).toBe("period_too_long");
    expect(issueOf({ periodEnd: "2026-10-18" })).toBe("period_future");
    expect(issueOf({ metric: "LIKES" })).toBe("metric_unknown");
    expect(issueOf({ value: "-5" })).toBe("value_negative");
    expect(issueOf({ value: "12.5" })).toBe("value_fraction");
    expect(issueOf({ value: "1,200" })).toBe("value_invalid");
    expect(issueOf({ value: "abc" })).toBe("value_invalid");
    expect(issueOf({ value: "1000000000001" })).toBe("value_too_big");
    expect(issueOf({ metric: "REVENUE", value: "10" })).toBe("currency_missing");
    expect(issueOf({ metric: "REVENUE", value: "10", currency: "riyal" })).toBe("currency_invalid");
    expect(issueOf({ currency: "SAR" })).toBe("currency_unexpected");
    expect(issueOf({ contentItemId: "post-1" })).toBe("content_invalid");
  });

  it("allows a period of exactly the maximum and ending today", () => {
    expect(issueOf({ periodStart: "2026-07-17", periodEnd: "2026-10-17" })).toBeNull();
    expect(issueOf({ periodStart: "2026-07-16", periodEnd: "2026-10-17" })).toBe("period_too_long");
  });
});

describe("parseCsv", () => {
  const header = CSV_COLUMNS.join(",");

  it("needs the exact header and ignores blank lines, BOM and CRLF", () => {
    expect(parseCsv("a,b,c\n1,2,3").headerIssue).toBe("header_missing");
    expect(parseCsv("").headerIssue).toBe("header_missing");
    const parsed = parseCsv(
      `\uFEFF${header.toUpperCase()}\r\n\r\n2026-10-01,2026-10-07,IMPRESSIONS,5,,\r\n`,
    );
    expect(parsed.headerIssue).toBeNull();
    expect(parsed.rows).toEqual([
      { line: 3, fields: ["2026-10-01", "2026-10-07", "IMPRESSIONS", "5", "", ""] },
    ]);
  });

  it("refuses too many rows or too many bytes", () => {
    const row = "2026-10-01,2026-10-07,IMPRESSIONS,5,,";
    expect(
      parseCsv([header, ...Array<string>(MAX_IMPORT_ROWS).fill(row)].join("\n")).headerIssue,
    ).toBeNull();
    expect(
      parseCsv([header, ...Array<string>(MAX_IMPORT_ROWS + 1).fill(row)].join("\n")).headerIssue,
    ).toBe("too_many_rows");
    expect(parseCsv(header + "\n" + "x".repeat(MAX_IMPORT_BYTES)).headerIssue).toBe("too_large");
  });
});

describe("manualSourceRef", () => {
  const row = {
    contentItemId: null,
    metric: "IMPRESSIONS" as const,
    periodStart: new Date("2026-10-01T00:00:00Z"),
    periodEnd: new Date("2026-10-07T00:00:00Z"),
  };

  it("is stable for the same identity and differs on any part", () => {
    const base = manualSourceRef(CAMPAIGN, "FACEBOOK_PAGE", row);
    expect(base).toMatch(/^manual:[0-9a-f]{64}$/);
    expect(manualSourceRef(CAMPAIGN, "FACEBOOK_PAGE", { ...row })).toBe(base);
    expect(manualSourceRef(CAMPAIGN, "INSTAGRAM", row)).not.toBe(base);
    expect(manualSourceRef(CAMPAIGN, "FACEBOOK_PAGE", { ...row, metric: "REACH" })).not.toBe(base);
    expect(
      manualSourceRef(CAMPAIGN, "FACEBOOK_PAGE", { ...row, contentItemId: ITEMS[0] }),
    ).not.toBe(base);
    expect(manualSourceRef(ITEMS[1], "FACEBOOK_PAGE", row)).not.toBe(base);
  });
});

describe("totals and series", () => {
  it("count each identity once", () => {
    const one = obs({ sourceRef: "same" });
    expect(distinctObservations([one, { ...one }, obs()])).toHaveLength(2);
    expect(distinctObservations([one, { ...one, provider: "other" }])).toHaveLength(2);
  });

  it("use campaign-level rows when present, never both levels", () => {
    const rows = [
      obs({ value: 1000n }),
      obs({ contentItemId: ITEMS[0], value: 400n }),
      obs({ contentItemId: ITEMS[1], value: 500n }),
    ];
    expect(campaignTotals(rows)).toMatchObject([
      { metric: "IMPRESSIONS", value: 1000n, observations: 1 },
    ]);
    expect(campaignTotals(rows.slice(1))).toMatchObject([{ value: 900n, observations: 2 }]);
  });

  it("total money per currency, never mixed", () => {
    const totals = campaignTotals([
      obs({ metric: "SPEND", currency: "SAR", value: 1000n }),
      obs({ metric: "SPEND", currency: "SAR", value: 500n }),
      obs({ metric: "SPEND", currency: "USD", value: 200n }),
    ]);
    expect(totals.map((total) => [total.currency, total.value])).toEqual([
      ["SAR", 1500n],
      ["USD", 200n],
    ]);
  });

  it("build a daily series of one count metric", () => {
    const series = dailySeries(
      [
        obs({ periodStart: new Date("2026-10-02T00:00:00Z"), value: 5n }),
        obs({ periodStart: new Date("2026-10-01T00:00:00Z"), value: 3n }),
        obs({ periodStart: new Date("2026-10-01T00:00:00Z"), contentItemId: ITEMS[0], value: 9n }),
        obs({ metric: "CLICKS", value: 7n }),
      ],
      "IMPRESSIONS",
    );
    expect(series.map((point) => [point.day.toISOString().slice(0, 10), point.value])).toEqual([
      ["2026-10-01", 3n],
      ["2026-10-02", 5n],
    ]);
  });

  it("compute content rates and periods", () => {
    const [result] = contentResults(contentRows(ITEMS[0], 1000n, 50n));
    expect(result).toMatchObject({
      impressions: 2000n,
      engagements: 100n,
      periods: 2,
      engagementRate: 0.05,
    });
    expect(
      contentResults([obs({ contentItemId: ITEMS[0], metric: "ENGAGEMENTS" })])[0]?.engagementRate,
    ).toBeNull();
  });
});

describe("campaignFindings", () => {
  const kinds = (findings: ReturnType<typeof campaignFindings>) =>
    findings.map((f) => f.kind).sort();
  const fiveItems = (weakEngagements = 50n) => [
    ...contentRows(ITEMS[0], 1000n, 50n),
    ...contentRows(ITEMS[1], 1000n, 50n),
    ...contentRows(ITEMS[2], 1000n, 20n),
    ...contentRows(ITEMS[3], 1000n, 20n),
    ...contentRows(ITEMS[4], 1000n, weakEngagements),
  ];

  it("returns nothing from empty data unless published content has no results", () => {
    expect(campaignFindings(campaign({ status: "DRAFT" }), [], TODAY)).toEqual([]);
    expect(kinds(campaignFindings(campaign(), [], TODAY))).toEqual(["MISSING_DATA"]);
  });

  it("flags weak content and a strong format with sufficient evidence", () => {
    const findings = campaignFindings(campaign(), fiveItems(5n), TODAY);
    const weak = findings.find((f) => f.kind === "WEAK_CONTENT");
    expect(weak).toMatchObject({
      contentItemId: ITEMS[4],
      fingerprint: `WEAK_CONTENT:${CAMPAIGN}:content:${ITEMS[4]}`,
    });
    expect(weak?.evidence).toMatchObject({
      sufficiency: "sufficient",
      sampleSize: 4,
      from: "2026-10-01",
      to: "2026-10-14",
    });
    expect(findings.find((f) => f.kind === "STRONG_FORMAT")?.fingerprint).toBe(
      `STRONG_FORMAT:${CAMPAIGN}:type:REEL`,
    );
  });

  it("does not judge content below the comparison thresholds", () => {
    const three = fiveItems(5n).filter(
      (row) => row.contentItemId !== ITEMS[0] && row.contentItemId !== ITEMS[2],
    );
    expect(kinds(campaignFindings(campaign(), three, TODAY))).toEqual(["MORE_DATA_NEEDED"]);
    const fewImpressions = fiveItems(5n).map((row) =>
      row.metric === "IMPRESSIONS" ? { ...row, value: 200n } : row,
    );
    expect(kinds(campaignFindings(campaign(), fewImpressions, TODAY))).toEqual([
      "MORE_DATA_NEEDED",
    ]);
    const onePeriod = fiveItems(5n).filter((row) => row.periodStart.getUTCDate() === 8);
    expect(kinds(campaignFindings(campaign(), onePeriod, TODAY))).toEqual(["MORE_DATA_NEEDED"]);
  });

  it("ignores simulated rows entirely", () => {
    const simulated = fiveItems(5n).map((row) => ({ ...row, source: "SIMULATED" as const }));
    expect(campaignFindings(campaign(), simulated, TODAY)).toEqual(
      campaignFindings(campaign(), [], TODAY),
    );
  });

  it("compares a goal pro rata and only after enough of the window", () => {
    const goal = {
      id: "g1",
      title: "Reach",
      targetMetric: "IMPRESSIONS" as const,
      target: 10_000,
      active: true,
    };
    const rows = [obs({ value: 2000n, periodEnd: new Date("2026-10-16T00:00:00Z") })];
    // 17 of 31 days elapsed: expected ≈ 5,484; 2,000 < 0.8 × that.
    const below = campaignFindings(campaign({ goals: [goal] }), rows, TODAY).find(
      (f) => f.kind === "BELOW_TARGET",
    );
    expect(below?.evidence.values).toMatchObject({
      actual: 2000,
      expectedSoFar: 5484,
      target: 10_000,
    });
    const onTrack = [obs({ value: 5000n, periodEnd: new Date("2026-10-16T00:00:00Z") })];
    expect(kinds(campaignFindings(campaign({ goals: [goal] }), onTrack, TODAY))).toEqual([]);
    const early = campaignFindings(
      campaign({ goals: [goal] }),
      rows,
      new Date("2026-10-03T00:00:00Z"),
    );
    expect(kinds(early)).toEqual(["MORE_DATA_NEEDED"]);
  });

  it("compares spend with the budget in the same currency only", () => {
    const over = [
      obs({
        metric: "SPEND",
        currency: "SAR",
        value: 150_000n,
        periodEnd: new Date("2026-10-16T00:00:00Z"),
      }),
    ];
    const facts = campaign({ budgetMinor: 100_000n, budgetCurrency: "SAR" });
    expect(kinds(campaignFindings(facts, over, TODAY))).toEqual(["SPEND_OVER_BUDGET"]);
    const usd = over.map((row) => ({ ...row, currency: "USD" }));
    expect(kinds(campaignFindings(facts, usd, TODAY))).toEqual([]);
  });

  it("reports stale data for an active campaign, or after a failed import", () => {
    const old = [obs({ periodEnd: new Date("2026-10-07T00:00:00Z") })];
    expect(kinds(campaignFindings(campaign(), old, TODAY))).toEqual(["STALE_DATA"]);
    expect(kinds(campaignFindings(campaign({ status: "COMPLETED" }), old, TODAY))).toEqual([]);
    const fresh = [obs({ periodEnd: new Date("2026-10-16T00:00:00Z") })];
    expect(kinds(campaignFindings(campaign(), fresh, TODAY))).toEqual([]);
    const failed = campaign({ lastFailureAt: new Date("2026-10-17T00:00:00Z") });
    expect(kinds(campaignFindings(failed, fresh, TODAY))).toEqual(["STALE_DATA"]);
  });

  it("is deterministic", () => {
    const rows = fiveItems(5n);
    expect(campaignFindings(campaign(), rows, TODAY)).toEqual(
      campaignFindings(campaign(), [...rows].reverse(), TODAY),
    );
  });
});

describe("rules", () => {
  it("validates thresholds", () => {
    expect(rulesSchema.parse(DEFAULT_RULES)).toEqual(DEFAULT_RULES);
    expect(rulesSchema.safeParse({ ...DEFAULT_RULES, weakRatio: 1 }).success).toBe(false);
    expect(rulesSchema.safeParse({ ...DEFAULT_RULES, strongRatio: 1 }).success).toBe(false);
    expect(rulesSchema.safeParse({ ...DEFAULT_RULES, minComparableContent: 2 }).success).toBe(
      false,
    );
    expect(rulesSchema.safeParse({ ...DEFAULT_RULES, extra: 1 }).success).toBe(false);
  });

  it("only lets people draft from findings that suggest content", () => {
    expect([...ACTIONABLE_KINDS].sort()).toEqual(["BELOW_TARGET", "STRONG_FORMAT", "WEAK_CONTENT"]);
  });
});
