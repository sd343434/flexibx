// Pass 5 — marketing intelligence on the real database, with deterministic data only:
// manual CSV imports (validation, idempotent batches, duplicates and conflicts across
// batches, voiding), the test provider adapter (simulated, failures recorded), concurrent
// imports, summaries that never mix simulated and recorded numbers, evidence-based
// recommendations, decisions with versions, a draft from a recommendation that still
// needs approval, roles and tenant isolation (services and database).
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceRole } from "@/generated/prisma/enums";
import { AppError } from "@/server/errors/app-error";
import { importManualCsv, syncFromProvider, voidImport } from "@/server/intelligence/ingestion";
import {
  actOnRecommendation,
  decideRecommendation,
  getInsights,
  type InsightFilters,
} from "@/server/intelligence/intelligence-service";
import { createTestMetricsProvider } from "@/server/intelligence/providers";
import { createCampaign } from "@/server/marketing/campaign-service";
import { createContent, getContent, transitionContent } from "@/server/marketing/content-service";
import { createGoal } from "@/server/marketing/goal-service";
import {
  campaignFieldsSchema,
  contentFieldsSchema,
  goalFieldsSchema,
} from "@/server/marketing/inputs";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

const TODAY = new Date("2030-03-20T12:00:00Z");
const HEADER = "period_start,period_end,metric,value,currency,content_id";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw error;
  return error;
}
async function expectCode(promise: Promise<unknown>, code: string, field?: string) {
  const error = await rejection(promise);
  expect(error.code).toBe(code);
  if (field !== undefined) expect(error.fields.map((f) => f.code)).toContain(field);
}

async function memberOf(ctx: TenantContext, role: WorkspaceRole): Promise<TenantContext> {
  const user = await system.user.create({
    data: { email: `${role.toLowerCase()}-${crypto.randomUUID()}@test.flexibx.local`, name: role },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return { userId: user.id, workspaceId: ctx.workspaceId, role };
}

async function campaignWithContent(ctx: TenantContext, items = 4, budget = true) {
  const { goalId } = await createGoal(
    db,
    ctx,
    goalFieldsSchema.parse({
      type: "AWARENESS",
      title: "Reach people",
      status: "ACTIVE",
      target: "100000",
      targetMetric: "IMPRESSIONS",
    }),
  );
  const { campaignId } = await createCampaign(
    db,
    ctx,
    campaignFieldsSchema.parse({
      name: "Spring launch",
      startDate: "2030-03-01",
      endDate: "2030-03-31",
      goalIds: [goalId],
      ...(budget ? { budgetAmount: "1000", budgetCurrency: "SAR" } : {}),
    }),
  );
  const contentIds: string[] = [];
  for (let index = 0; index < items; index += 1) {
    const { contentId } = await createContent(
      db,
      ctx,
      contentFieldsSchema.parse({
        title: `Post ${String(index + 1)}`,
        type: index < 2 ? "REEL" : "POST",
        campaignId,
      }),
    );
    contentIds.push(contentId);
  }
  return { campaignId, contentIds, goalId };
}

const filters = (overrides: Partial<InsightFilters> = {}): InsightFilters => ({
  campaignId: null,
  channel: null,
  metric: "IMPRESSIONS",
  from: null,
  to: null,
  ...overrides,
});

const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const importCsv = (
  ctx: TenantContext,
  campaignId: string,
  text: string,
  batchKey: string = crypto.randomUUID(),
) =>
  importManualCsv(db, ctx, {
    campaignId,
    channel: "FACEBOOK_PAGE",
    batchKey,
    csv: text,
    today: TODAY,
  });

/** Two days of impressions and engagements for each content item (rates differ). */
function contentRows(contentIds: readonly string[], rates: readonly number[]) {
  return contentIds.flatMap((id, index) =>
    ["2030-03-10", "2030-03-11"].flatMap((day) => [
      `${day},${day},IMPRESSIONS,1000,,${id}`,
      `${day},${day},ENGAGEMENTS,${String(Math.round(1000 * (rates[index] ?? 0)))},,${id}`,
    ]),
  );
}

// ── ingestion ────────────────────────────────────────────────────────────────

describe("manual import", () => {
  it("validates every row, reports problems and stores only valid observations", async () => {
    const owner = await createTenant(system);
    const { campaignId, contentIds } = await campaignWithContent(owner, 1);
    const other = await createTenant(system);
    const { contentIds: foreign } = await campaignWithContent(other, 1);
    const result = await importCsv(
      owner,
      campaignId,
      csv(
        `2030-03-10,2030-03-10,IMPRESSIONS,1200,,${must(contentIds[0])}`,
        "2030-03-10,2030-03-10,SPEND,150.5,sar,",
        "2030-03-10,2030-03-10,CLICKS,-3,,",
        "2030-03-10,2030-03-10,CLICKS,2.5,,",
        "2030-03-10,2030-03-10,SPEND,10,,",
        "2030-03-10,2030-03-10,CLICKS,10,SAR,",
        "2030-03-12,2030-03-10,CLICKS,10,,",
        "2030-02-30,2030-03-01,CLICKS,10,,",
        "2030-03-25,2030-03-25,CLICKS,10,,",
        "2029-01-01,2030-03-01,CLICKS,10,,",
        "2030-03-10,2030-03-10,LIKES,10,,",
        "2030-03-10,2030-03-10,CLICKS,NaN,,",
        `2030-03-10,2030-03-10,CLICKS,5,,${must(foreign[0])}`,
        "2030-03-10,2030-03-10,CLICKS",
      ),
    );
    expect(result).toMatchObject({ status: "SUCCEEDED", accepted: 2, duplicates: 0, rejected: 12 });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "value_negative",
      "value_fraction",
      "currency_missing",
      "currency_unexpected",
      "period_order",
      "date_invalid",
      "period_future",
      "period_too_long",
      "metric_unknown",
      "value_invalid",
      "content_not_in_campaign",
      "columns",
    ]);
    const stored = await system.metricObservation.findMany({ orderBy: { metric: "asc" } });
    expect(stored.map((row) => [row.metric, row.value, row.currency, row.source])).toEqual([
      ["IMPRESSIONS", 1200n, null, "MANUAL"],
      ["SPEND", 15050n, "SAR", "MANUAL"],
    ]);
  });

  it("refuses a file without the expected header, and an import with no valid row fails", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 0);
    await expectCode(
      importCsv(owner, campaignId, "date,metric,value\n2030-03-10,CLICKS,1"),
      "CONFLICT",
      "metrics_csv_invalid",
    );
    const failed = await importCsv(owner, campaignId, csv("2030-03-10,2030-03-10,CLICKS,-1,,"));
    expect(failed).toMatchObject({ status: "FAILED", accepted: 0, rejected: 1 });
    // A failed attempt does not block a corrected retry of the same submission.
    const key = crypto.randomUUID();
    await importCsv(owner, campaignId, csv("2030-03-10,2030-03-10,CLICKS,x,,"), key);
    expect(
      await importCsv(owner, campaignId, csv("2030-03-10,2030-03-10,CLICKS,7,,"), key),
    ).toMatchObject({ status: "SUCCEEDED", accepted: 1, repeated: false });
    expect(
      await system.metricImport.findFirstOrThrow({ where: { id: failed.importId } }),
    ).toMatchObject({
      status: "FAILED",
      errorCode: "no_valid_rows",
    });
  });

  it("never counts the same observation twice; a different value is a conflict, not an overwrite", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 0);
    const rows = csv("2030-03-10,2030-03-10,CLICKS,40,,", "2030-03-11,2030-03-11,CLICKS,60,,");
    const key = crypto.randomUUID();
    const first = await importCsv(owner, campaignId, rows, key);
    expect(first).toMatchObject({ accepted: 2, repeated: false });
    // The same batch again: recognized, nothing stored.
    expect(await importCsv(owner, campaignId, rows, key)).toMatchObject({
      importId: first.importId,
      repeated: true,
    });
    // The same numbers in a new batch: duplicates. A different value: conflict.
    expect(await importCsv(owner, campaignId, rows)).toMatchObject({
      status: "SUCCEEDED",
      accepted: 0,
      duplicates: 2,
    });
    const changed = await importCsv(owner, campaignId, csv("2030-03-10,2030-03-10,CLICKS,45,,"));
    expect(changed).toMatchObject({ status: "FAILED", rejected: 1 });
    expect(changed.issues).toEqual([{ row: 2, code: "conflict" }]);
    // A new period is history, kept beside the old ones.
    await importCsv(owner, campaignId, csv("2030-03-12,2030-03-12,CLICKS,70,,"));
    const insights = await getInsights(db, owner, filters(), TODAY);
    const totals = must(insights.campaigns.find((c) => c.campaign.id === campaignId)).recorded;
    expect(totals).toEqual([
      expect.objectContaining({ metric: "CLICKS", value: 170n, observations: 3 }),
    ]);
  });

  it("voiding an import removes its numbers everywhere and lets corrected numbers in", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 0);
    const wrong = await importCsv(owner, campaignId, csv("2030-03-10,2030-03-10,CLICKS,400,,"));
    await voidImport(db, owner, wrong.importId);
    await expectCode(
      voidImport(db, owner, wrong.importId),
      "CONFLICT",
      "metrics_import_not_voidable",
    );
    expect(must((await getInsights(db, owner, filters(), TODAY)).campaigns[0]).recorded).toEqual(
      [],
    );
    expect(
      await importCsv(owner, campaignId, csv("2030-03-10,2030-03-10,CLICKS,40,,")),
    ).toMatchObject({
      accepted: 1,
    });
    // Observations themselves are history: never edited.
    await expect(system.metricObservation.updateMany({ data: { value: 1n } })).rejects.toThrow(
      /append-only/,
    );
  });

  it("counts each observation once when two identical imports run at the same time", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 0);
    const rows = csv(
      "2030-03-10,2030-03-10,IMPRESSIONS,1000,,",
      "2030-03-11,2030-03-11,IMPRESSIONS,2000,,",
    );
    const results = await Promise.all([
      importCsv(owner, campaignId, rows),
      importCsv(owner, campaignId, rows),
      importCsv(owner, campaignId, rows),
    ]);
    expect(results.reduce((sum, r) => sum + r.accepted, 0)).toBe(2);
    expect(results.reduce((sum, r) => sum + r.duplicates, 0)).toBe(4);
    const total = must((await getInsights(db, owner, filters(), TODAY)).campaigns[0]).recorded[0];
    expect(total?.value).toBe(3000n);
  });
  it("serializes the imports of a workspace, so overlapping batches cannot both store a row", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 0);
    const advisory = async (granted: boolean) =>
      (
        await system.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted = ${granted}`
      )[0]?.n ?? 0;
    const until = async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    // Another session holds this workspace's import lock…
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = system.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`metric-import:${owner.workspaceId}`}))`;
        await held;
      },
      { timeout: 20_000 },
    );
    expect(await until(async () => (await advisory(true)) > 0)).toBe(true);
    // …so an import waits for it instead of reading and writing alongside.
    let settled = false;
    const pending = importCsv(owner, campaignId, csv("2030-03-10,2030-03-10,CLICKS,5,,")).finally(
      () => {
        settled = true;
      },
    );
    expect(await until(async () => (await advisory(false)) > 0)).toBe(true);
    expect(settled).toBe(false);
    release?.();
    await holder;
    expect(await pending).toMatchObject({ status: "SUCCEEDED", accepted: 1 });
  });
});

describe("provider adapter (test fixture only)", () => {
  it("imports simulated numbers that are never mixed with recorded ones", async () => {
    const owner = await createTenant(system);
    const { campaignId, contentIds } = await campaignWithContent(owner, 2);
    const window = {
      campaignId,
      channel: "FACEBOOK_PAGE" as const,
      from: new Date("2030-03-10"),
      to: new Date("2030-03-11"),
      today: TODAY,
    };
    const first = await syncFromProvider(db, owner, createTestMetricsProvider(), window);
    expect(first).toMatchObject({ status: "SUCCEEDED", accepted: 8 });
    // The same batch again is recognized.
    expect(await syncFromProvider(db, owner, createTestMetricsProvider(), window)).toMatchObject({
      repeated: true,
    });
    await importCsv(
      owner,
      campaignId,
      csv(`2030-03-10,2030-03-10,IMPRESSIONS,5,,${must(contentIds[0])}`),
    );
    const insights = await getInsights(db, owner, filters(), TODAY);
    const summary = must(insights.campaigns[0]);
    expect(insights.hasSimulated).toBe(true);
    expect(summary.recorded).toEqual([
      expect.objectContaining({ metric: "IMPRESSIONS", value: 5n, observations: 1 }),
    ]);
    expect(summary.simulated.map((t) => t.metric)).toEqual(["ENGAGEMENTS", "IMPRESSIONS"]);
    expect(summary.providers.sort()).toEqual(["MANUAL:manual", "SIMULATED:test-fixture"]);
    // Recommendations never use simulated numbers.
    expect(insights.recommendations.every((r) => r.kind !== "WEAK_CONTENT")).toBe(true);
    // The import history says where each batch came from.
    expect(insights.imports.map((i) => [i.provider, i.source])).toContainEqual([
      "test-fixture",
      "SIMULATED",
    ]);
  });

  it("records a failed or timed-out sync and a contradictory batch without storing anything wrong", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 1);
    const window = {
      campaignId,
      channel: "FACEBOOK_PAGE" as const,
      from: new Date("2030-03-10"),
      to: new Date("2030-03-10"),
      today: TODAY,
    };
    expect(
      await syncFromProvider(db, owner, createTestMetricsProvider("unavailable"), window),
    ).toMatchObject({ status: "FAILED" });
    expect(
      await syncFromProvider(db, owner, createTestMetricsProvider("slow"), {
        ...window,
        timeoutMs: 50,
      }),
    ).toMatchObject({ status: "FAILED" });
    expect(
      await syncFromProvider(db, owner, createTestMetricsProvider("malformed"), window),
    ).toMatchObject({ status: "FAILED", rejected: 2 });
    const contradictory = await syncFromProvider(
      db,
      owner,
      createTestMetricsProvider("contradictory"),
      window,
    );
    expect(contradictory).toMatchObject({ accepted: 2, rejected: 1 });
    expect(contradictory.issues).toEqual([{ row: 3, code: "duplicate_in_batch" }]);
    const failures = await system.metricImport.findMany({
      where: { status: "FAILED" },
      select: { errorCode: true },
      orderBy: { createdAt: "asc" },
    });
    expect(failures.map((f) => f.errorCode)).toEqual([
      "provider_unavailable",
      "provider_timeout",
      "no_valid_rows",
    ]);
    const insights = await getInsights(db, owner, filters(), TODAY);
    expect(insights.freshness.lastFailureAt).not.toBeNull();
  });
});

// ── recommendations ──────────────────────────────────────────────────────────

describe("recommendations", () => {
  it("explains weak content and a strong format with evidence, and nothing without enough data", async () => {
    const owner = await createTenant(system);
    const { campaignId, contentIds } = await campaignWithContent(owner, 5);
    // Not enough comparable items yet (3 < 4): more data needed, nobody judged.
    await importCsv(
      owner,
      campaignId,
      csv(...contentRows(contentIds.slice(0, 3), [0.1, 0.1, 0.02])),
    );
    let recs = (await getInsights(db, owner, filters(), TODAY)).recommendations;
    expect(recs.map((r) => r.kind)).toContain("MORE_DATA_NEEDED");
    expect(recs.some((r) => r.kind === "WEAK_CONTENT")).toBe(false);

    await importCsv(owner, campaignId, csv(...contentRows(contentIds.slice(3), [0.03, 0.01])));
    recs = (await getInsights(db, owner, filters(), TODAY)).recommendations;
    const weak = recs.filter((r) => r.kind === "WEAK_CONTENT");
    expect(weak.map((r) => r.contentItemId)).toEqual([contentIds[4]]);
    expect(weak[0]?.evidence).toMatchObject({
      from: "2030-03-10",
      to: "2030-03-11",
      sampleSize: 4,
      sufficiency: "sufficient",
      values: { engagementRate: 0.01, campaignMedianRate: 0.03, comparedItems: 5 },
    });
    // REELs (posts 1–2, 10%) against the median (3%).
    const strong = must(recs.find((r) => r.kind === "STRONG_FORMAT"));
    expect(strong.evidence.values).toMatchObject({
      contentType: "REEL",
      itemsOfFormat: 2,
      otherItems: 3,
    });
    expect(strong.status).toBe("OPEN");
  });

  it("compares a target pro rata, spend with the budget in its currency, and flags stale data", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 0);
    await system.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });
    // 20 of 31 days passed: expected 64 516 impressions; 20 000 recorded.
    await importCsv(
      owner,
      campaignId,
      csv(
        "2030-03-01,2030-03-10,IMPRESSIONS,20000,,",
        "2030-03-01,2030-03-10,SPEND,1200,SAR,",
        "2030-03-01,2030-03-10,SPEND,9999,USD,",
      ),
    );
    const recs = (await getInsights(db, owner, filters(), TODAY)).recommendations;
    const kinds = recs.map((r) => r.kind).sort();
    expect(kinds).toEqual(["BELOW_TARGET", "SPEND_OVER_BUDGET", "STALE_DATA"]);
    expect(must(recs.find((r) => r.kind === "BELOW_TARGET")).evidence.values).toMatchObject({
      actual: 20000,
      target: 100000,
      expectedSoFar: 64516,
    });
    // Compared in SAR only; the USD spend is not converted or added.
    expect(must(recs.find((r) => r.kind === "SPEND_OVER_BUDGET")).evidence.values).toMatchObject({
      spendMinor: "120000",
      budgetMinor: "100000",
      currency: "SAR",
    });
    expect(must(recs.find((r) => r.kind === "STALE_DATA")).evidence.values).toMatchObject({
      daysSinceLatest: 10,
    });
    // Not every finding is a draft to write: these call for checking, not content.
    for (const kind of ["SPEND_OVER_BUDGET", "STALE_DATA"]) {
      const finding = must(recs.find((r) => r.kind === kind));
      await expectCode(
        actOnRecommendation(db, owner, { fingerprint: finding.fingerprint, version: 0 }, TODAY),
        "CONFLICT",
        "recommendation_not_actionable",
      );
    }
  });

  it("asks for data when published content has none, and draws no conclusion from empty data", async () => {
    const owner = await createTenant(system);
    const { campaignId, contentIds } = await campaignWithContent(owner, 1, false);
    let recs = (await getInsights(db, owner, filters(), TODAY)).recommendations;
    expect(recs).toEqual([]);
    await system.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });
    await system.contentItem.update({
      where: { id: must(contentIds[0]) },
      data: { status: "PUBLISHED", publishedAt: TODAY },
    });
    recs = (await getInsights(db, owner, filters(), TODAY)).recommendations;
    expect(recs.map((r) => [r.kind, r.evidence.sampleSize])).toEqual([["MISSING_DATA", 0]]);
  });

  it("records decisions with versions, and turns a finding into a draft that still needs approval", async () => {
    const owner = await createTenant(system);
    const { campaignId, contentIds } = await campaignWithContent(owner, 5);
    await importCsv(
      owner,
      campaignId,
      csv(...contentRows(contentIds, [0.1, 0.1, 0.02, 0.03, 0.01])),
    );
    const recs = (await getInsights(db, owner, filters(), TODAY)).recommendations;
    const weak = must(recs.find((r) => r.kind === "WEAK_CONTENT"));
    const strong = must(recs.find((r) => r.kind === "STRONG_FORMAT"));

    await expectCode(
      decideRecommendation(
        db,
        owner,
        { fingerprint: weak.fingerprint, version: 0, decision: { action: "dismiss", reason: " " } },
        TODAY,
      ),
      "VALIDATION_FAILED",
      "required",
    );
    await decideRecommendation(
      db,
      owner,
      { fingerprint: weak.fingerprint, version: 0, decision: { action: "snooze", days: 7 } },
      TODAY,
    );
    // Stale version refused.
    await expectCode(
      decideRecommendation(
        db,
        owner,
        { fingerprint: weak.fingerprint, version: 0, decision: { action: "review" } },
        TODAY,
      ),
      "CONFLICT",
      "recommendation_changed",
    );
    const later = new Date(TODAY.getTime() + 8 * 24 * 3_600_000);
    // The snooze ran out: open again.
    expect(
      must(
        (await getInsights(db, owner, filters(), later)).recommendations.find(
          (r) => r.fingerprint === weak.fingerprint,
        ),
      ).status,
    ).toBe("OPEN");
    await decideRecommendation(
      db,
      owner,
      {
        fingerprint: weak.fingerprint,
        version: 1,
        decision: { action: "dismiss", reason: "Seasonal post" },
      },
      TODAY,
    );

    const { contentId } = await actOnRecommendation(
      db,
      owner,
      { fingerprint: strong.fingerprint, version: 0 },
      TODAY,
    );
    await expectCode(
      actOnRecommendation(db, owner, { fingerprint: strong.fingerprint, version: 1 }, TODAY),
      "CONFLICT",
      "recommendation_not_actionable",
    );
    // A finding turned into a draft is settled: it cannot be dismissed or reopened.
    await expectCode(
      decideRecommendation(
        db,
        owner,
        { fingerprint: strong.fingerprint, version: 1, decision: { action: "reopen" } },
        TODAY,
      ),
      "CONFLICT",
      "recommendation_not_actionable",
    );
    const draft = await getContent(db, owner, contentId);
    expect(draft).toMatchObject({ status: "DRAFT", type: "REEL" });
    expect(draft.campaign?.id).toBe(campaignId);
    expect(draft.notes).toContain("n=");
    // The normal workflow applies: an editor submits, only an approver can approve.
    const editor = await memberOf(owner, "EDITOR");
    await transitionContent(db, editor, { contentId, transition: "submit", scheduledAt: null });
    await expectCode(
      transitionContent(db, editor, { contentId, transition: "approve", scheduledAt: null }),
      "FORBIDDEN",
    );
    const states = await system.marketingRecommendation.findMany({
      select: { kind: true, status: true },
    });
    expect(states.map((s) => [s.kind, s.status]).sort()).toEqual([
      ["STRONG_FORMAT", "ACTED"],
      ["WEAK_CONTENT", "DISMISSED"],
    ]);
    const audit = await system.auditLog.findMany({
      where: { workspaceId: owner.workspaceId, action: { startsWith: "recommendation." } },
      select: { action: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      "recommendation.acted",
      "recommendation.dismissed",
      "recommendation.snoozed",
    ]);
  });

  it("refuses decisions on findings the evidence no longer supports", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithContent(owner, 0);
    await expectCode(
      decideRecommendation(
        db,
        owner,
        {
          fingerprint: `WEAK_CONTENT:${campaignId}:content:${crypto.randomUUID()}`,
          version: 0,
          decision: { action: "review" },
        },
        TODAY,
      ),
      "CONFLICT",
      "recommendation_changed",
    );
  });
});

// ── roles and tenants ────────────────────────────────────────────────────────

describe("permissions and isolation", () => {
  it("lets viewers and clients read, and only managers import, void and decide", async () => {
    const owner = await createTenant(system);
    const { campaignId, contentIds } = await campaignWithContent(owner, 5);
    const imported = await importCsv(
      owner,
      campaignId,
      csv(...contentRows(contentIds, [0.1, 0.1, 0.02, 0.03, 0.01])),
    );
    for (const role of ["VIEWER", "CLIENT", "EDITOR"] as const) {
      const ctx = await memberOf(owner, role);
      expect((await getInsights(db, ctx, filters(), TODAY)).campaigns).toHaveLength(1);
      await expectCode(
        importCsv(ctx, campaignId, csv("2030-03-10,2030-03-10,CLICKS,1,,")),
        "FORBIDDEN",
      );
      await expectCode(voidImport(db, ctx, imported.importId), "FORBIDDEN");
      const rec = must((await getInsights(db, ctx, filters(), TODAY)).recommendations[0]);
      await expectCode(
        decideRecommendation(
          db,
          ctx,
          { fingerprint: rec.fingerprint, version: 0, decision: { action: "review" } },
          TODAY,
        ),
        "FORBIDDEN",
      );
      await expectCode(
        actOnRecommendation(db, ctx, { fingerprint: rec.fingerprint, version: 0 }, TODAY),
        "FORBIDDEN",
      );
    }
  });

  it("never reads, imports into, voids or decides on another workspace's data", async () => {
    const owner = await createTenant(system);
    const other = await createTenant(system);
    const { campaignId, contentIds } = await campaignWithContent(owner, 5);
    const imported = await importCsv(
      owner,
      campaignId,
      csv(...contentRows(contentIds, [0.1, 0.1, 0.02, 0.03, 0.01])),
    );
    const rec = must((await getInsights(db, owner, filters(), TODAY)).recommendations[0]);

    expect((await getInsights(db, other, filters(), TODAY)).campaigns).toEqual([]);
    await expectCode(getInsights(db, other, filters({ campaignId }), TODAY), "NOT_FOUND");
    await expectCode(
      importCsv(other, campaignId, csv("2030-03-10,2030-03-10,CLICKS,1,,")),
      "NOT_FOUND",
    );
    await expectCode(voidImport(db, other, imported.importId), "NOT_FOUND");
    await expectCode(
      decideRecommendation(
        db,
        other,
        { fingerprint: rec.fingerprint, version: 0, decision: { action: "review" } },
        TODAY,
      ),
      "NOT_FOUND",
    );
    await expectCode(
      actOnRecommendation(db, other, { fingerprint: rec.fingerprint, version: 0 }, TODAY),
      "NOT_FOUND",
    );
    expect(await system.metricImport.count({ where: { workspaceId: other.workspaceId } })).toBe(0);

    // The database refuses cross-workspace references too.
    const theirImport = await system.metricImport.create({
      data: {
        workspaceId: other.workspaceId,
        provider: "manual",
        source: "MANUAL",
        externalId: "x",
        status: "SUCCEEDED",
        rowsReceived: 0,
        rowsAccepted: 0,
        rowsDuplicate: 0,
        rowsRejected: 0,
      },
    });
    await expect(
      system.metricObservation.create({
        data: {
          workspaceId: other.workspaceId,
          importId: theirImport.id,
          campaignId,
          channel: "OTHER",
          provider: "manual",
          source: "MANUAL",
          metric: "CLICKS",
          periodStart: new Date("2030-03-10"),
          periodEnd: new Date("2030-03-10"),
          value: 1n,
          sourceRef: "x",
        },
      }),
    ).rejects.toThrow();
    // No VERIFIED numbers can be written while no verified integration exists.
    await expect(
      system.metricImport.create({
        data: {
          workspaceId: owner.workspaceId,
          provider: "meta",
          source: "VERIFIED",
          externalId: "y",
          status: "SUCCEEDED",
          rowsReceived: 0,
          rowsAccepted: 0,
          rowsDuplicate: 0,
          rowsRejected: 0,
        },
      }),
    ).rejects.toThrow();
  });
});
