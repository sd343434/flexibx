import type { Prisma } from "@/generated/prisma/client";
import { ContentType as ContentTypes } from "@/generated/prisma/enums";
import type {
  ContentType,
  MarketingChannel,
  PerformanceMetric,
  RecommendationStatus,
} from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { conflict, fieldError, notFound } from "../marketing/common";
import { createContentIn } from "../marketing/content-service";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import {
  ACTIONABLE_KINDS,
  campaignFindings,
  campaignTotals,
  contentResults,
  dailySeries,
  DEFAULT_RULES,
  evidenceClass,
  type CampaignFacts,
  type Finding,
  type Observation,
  type Rules,
} from "./analysis";

// Marketing intelligence (Pass 5): the dashboard's data and the people's decisions on
// recommendations. Read: analytics.view. Decide (review, dismiss with a reason, snooze,
// reopen) and act (turn a finding into a content DRAFT): campaign.manage; acting also
// needs content.create. Findings are recomputed from the evidence on every read (pure
// rules, analysis.ts), so viewing never writes; a decision stores the finding's state by
// its fingerprint, with the evidence it was decided on. Nothing here publishes, spends,
// messages anyone or changes a campaign's settings: an acted-on finding becomes a draft
// that goes through the normal review and approval.

/** Most observations read for one dashboard view (newest periods first beyond that). */
export const OBSERVATION_LIMIT = 20_000;
export const IMPORT_HISTORY_LIMIT = 20;
export const MAX_SNOOZE_DAYS = 90;
const CONTENT_TYPES = Object.values(ContentTypes);

export interface InsightFilters {
  readonly campaignId: string | null;
  readonly channel: MarketingChannel | null;
  readonly metric: PerformanceMetric;
  readonly from: Date | null;
  readonly to: Date | null;
}

const observationSelect = {
  campaignId: true,
  contentItemId: true,
  channel: true,
  provider: true,
  source: true,
  metric: true,
  periodStart: true,
  periodEnd: true,
  value: true,
  currency: true,
  sourceRef: true,
  observedAt: true,
} as const;

async function loadObservations(db: Db, ctx: TenantContext, filters: InsightFilters) {
  const where: Prisma.MetricObservationWhereInput = {
    workspaceId: ctx.workspaceId,
    import: { status: { not: "VOIDED" } },
    // Campaign numbers only: a source's account-level numbers belong to no campaign and
    // are never added to one (see getSourceOverview).
    campaignId: filters.campaignId ?? { not: null },
    ...(filters.channel === null ? {} : { channel: filters.channel }),
    ...(filters.from === null ? {} : { periodStart: { gte: filters.from } }),
    ...(filters.to === null ? {} : { periodEnd: { lte: filters.to } }),
  };
  const rows = await db.metricObservation.findMany({
    where,
    orderBy: [{ periodStart: "desc" }, { createdAt: "asc" }],
    take: OBSERVATION_LIMIT,
    select: observationSelect,
  });
  const campaignRows = rows.flatMap((row): Observation[] =>
    row.campaignId === null ? [] : [{ ...row, campaignId: row.campaignId }],
  );
  return { rows: campaignRows, truncated: rows.length === OBSERVATION_LIMIT };
}

async function loadCampaigns(db: Db, ctx: TenantContext, campaignId: string | null) {
  const campaigns = await db.campaign.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      status: { not: "ARCHIVED" },
      ...(campaignId === null ? {} : { id: campaignId }),
    },
    orderBy: [{ startDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      name: true,
      status: true,
      startDate: true,
      endDate: true,
      budgetAmountMinor: true,
      budgetCurrency: true,
      goals: {
        select: {
          goal: {
            select: { id: true, title: true, targetMetric: true, target: true, status: true },
          },
        },
      },
      contentItems: {
        select: { id: true, title: true, type: true, status: true },
        take: 200,
        orderBy: { createdAt: "asc" },
      },
    },
  });
  const attempts = await db.metricImport.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
    take: IMPORT_HISTORY_LIMIT,
    select: {
      id: true,
      provider: true,
      source: true,
      status: true,
      rowsReceived: true,
      rowsAccepted: true,
      rowsDuplicate: true,
      rowsRejected: true,
      errorCode: true,
      issues: true,
      createdAt: true,
      voidedAt: true,
      observations: { select: { campaignId: true }, take: 1 },
    },
  });
  const lastSuccess = attempts.find((row) => row.status === "SUCCEEDED")?.createdAt ?? null;
  const lastFailure = attempts.find((row) => row.status === "FAILED")?.createdAt ?? null;
  const facts: CampaignFacts[] = campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    budgetMinor: campaign.budgetAmountMinor,
    budgetCurrency: campaign.budgetCurrency,
    goals: campaign.goals.map(({ goal }) => ({
      id: goal.id,
      title: goal.title,
      targetMetric: goal.targetMetric,
      target: goal.target === null ? null : Number(goal.target),
      active: goal.status === "ACTIVE",
    })),
    content: campaign.contentItems,
    lastFailureAt: lastFailure,
    lastSuccessAt: lastSuccess,
  }));
  return { facts, attempts };
}

const stateSelect = {
  id: true,
  fingerprint: true,
  status: true,
  dismissReason: true,
  snoozedUntil: true,
  decidedAt: true,
  decidedBy: { select: { name: true } },
  draftContentItemId: true,
  version: true,
  kind: true,
  campaignId: true,
  contentItemId: true,
  evidence: true,
} as const;

export type RecommendationState = Prisma.MarketingRecommendationGetPayload<{
  select: typeof stateSelect;
}>;

/** A finding with its stored state (OPEN when nobody decided yet, or a snooze ran out). */
export interface RecommendationView extends Finding {
  readonly status: RecommendationStatus;
  readonly state: RecommendationState | null;
}

function effectiveStatus(state: RecommendationState | null, now: Date): RecommendationStatus {
  if (state === null) return "OPEN";
  if (state.status === "SNOOZED" && state.snoozedUntil !== null && state.snoozedUntil <= now) {
    return "OPEN";
  }
  return state.status;
}

/** Everything the insights dashboard shows, for the filters given. */
export async function getInsights(
  db: Db,
  ctx: TenantContext,
  filters: InsightFilters,
  now: Date,
  rules: Rules = DEFAULT_RULES,
) {
  assertCan(ctx, "analytics.view");
  if (filters.campaignId !== null) {
    const exists = await db.campaign.findFirst({
      where: { workspaceId: ctx.workspaceId, id: filters.campaignId },
      select: { id: true },
    });
    if (exists === null) throw notFound("campaign");
  }
  const [{ rows, truncated }, { facts, attempts }] = await Promise.all([
    loadObservations(db, ctx, filters),
    loadCampaigns(db, ctx, filters.campaignId),
  ]);
  const recorded = rows.filter((row) => evidenceClass(row.source) === "recorded");
  const simulated = rows.filter((row) => evidenceClass(row.source) === "simulated");

  const campaigns = facts.map((campaign) => {
    const own = (list: readonly Observation[]) =>
      list.filter((row) => row.campaignId === campaign.id);
    return {
      campaign,
      recorded: campaignTotals(own(recorded)),
      simulated: campaignTotals(own(simulated)),
      providers: [...new Set(own(rows).map((row) => `${row.source}:${row.provider}`))],
    };
  });
  const titles = new Map(
    facts.flatMap((campaign) => campaign.content.map((item) => [item.id, item])),
  );
  const content = contentResults(recorded)
    .map((result) => ({ ...result, content: titles.get(result.contentItemId) ?? null }))
    .filter((result) => result.content !== null)
    .sort((a, b) => Number(b.exposure - a.exposure));

  // Findings come from recorded evidence of the whole campaign (not the date filter), so
  // a narrow view never hides or invents a recommendation.
  const allRows =
    filters.from === null && filters.to === null && filters.channel === null
      ? rows
      : (await loadObservations(db, ctx, { ...filters, channel: null, from: null, to: null })).rows;
  const findings = facts.flatMap((campaign) => campaignFindings(campaign, allRows, now, rules));
  const states = await db.marketingRecommendation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      fingerprint: { in: findings.map((f) => f.fingerprint) },
    },
    select: stateSelect,
  });
  const byFingerprint = new Map(states.map((state) => [state.fingerprint, state]));
  const recommendations: RecommendationView[] = findings.map((finding) => {
    const state = byFingerprint.get(finding.fingerprint) ?? null;
    return { ...finding, state, status: effectiveStatus(state, now) };
  });
  const history = await db.marketingRecommendation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      status: { not: "OPEN" },
      fingerprint: { notIn: findings.map((f) => f.fingerprint) },
      ...(filters.campaignId === null ? {} : { campaignId: filters.campaignId }),
    },
    orderBy: { decidedAt: "desc" },
    take: 20,
    select: stateSelect,
  });

  return {
    campaigns,
    content,
    series: {
      recorded: dailySeries(recorded, filters.metric),
      simulated: dailySeries(simulated, filters.metric),
    },
    recommendations,
    history,
    imports: attempts.map(({ observations, ...attempt }) => ({
      ...attempt,
      campaignId: observations[0]?.campaignId ?? null,
    })),
    freshness: {
      lastSuccessAt: attempts.find((row) => row.status === "SUCCEEDED")?.createdAt ?? null,
      lastFailureAt: attempts.find((row) => row.status === "FAILED")?.createdAt ?? null,
      latestPeriodEnd:
        recorded.length === 0
          ? null
          : new Date(Math.max(...recorded.map((row) => row.periodEnd.getTime()))),
    },
    hasSimulated: simulated.length > 0,
    truncated,
    rules,
  };
}

// ── Decisions ────────────────────────────────────────────────────────────────

/** The current finding with this fingerprint (recomputed), or not found. */
async function currentFinding(
  db: Db,
  ctx: TenantContext,
  fingerprint: string,
  now: Date,
): Promise<Finding> {
  const campaignId = fingerprint.split(":")[1] ?? "";
  if (!/^[0-9a-f-]{36}$/.test(campaignId)) throw notFound("campaign");
  const [{ rows }, { facts }] = await Promise.all([
    loadObservations(db, ctx, {
      campaignId,
      channel: null,
      metric: "IMPRESSIONS",
      from: null,
      to: null,
    }),
    loadCampaigns(db, ctx, campaignId),
  ]);
  const campaign = facts[0];
  if (campaign === undefined) throw notFound("campaign");
  const finding = campaignFindings(campaign, rows, now).find((f) => f.fingerprint === fingerprint);
  if (finding === undefined)
    throw conflict("recommendation", "recommendation_changed", { fingerprint });
  return finding;
}

export type Decision =
  | { readonly action: "review" }
  | { readonly action: "dismiss"; readonly reason: string }
  | { readonly action: "snooze"; readonly days: number }
  | { readonly action: "reopen" };

const AUDIT = {
  review: "recommendation.reviewed",
  dismiss: "recommendation.dismissed",
  snooze: "recommendation.snoozed",
  reopen: "recommendation.reviewed",
} as const;

/**
 * Records a person's decision on a finding. `version` is the state's version as shown
 * (0 when it had none yet); a stale version is refused (`recommendation_changed`).
 */
export async function decideRecommendation(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly fingerprint: string; readonly version: number; readonly decision: Decision },
  now: Date,
): Promise<void> {
  assertCan(ctx, "campaign.manage");
  const { decision } = input;
  if (decision.action === "dismiss" && decision.reason.trim() === "") {
    throw fieldError("reason", "required");
  }
  if (decision.action === "snooze" && !(decision.days >= 1 && decision.days <= MAX_SNOOZE_DAYS)) {
    throw fieldError("days", "too_big", { maximum: MAX_SNOOZE_DAYS });
  }
  const finding = await currentFinding(db, ctx, input.fingerprint, now);
  const data = {
    status: (decision.action === "review"
      ? "REVIEWED"
      : decision.action === "dismiss"
        ? "DISMISSED"
        : decision.action === "snooze"
          ? "SNOOZED"
          : "OPEN") as RecommendationStatus,
    dismissReason: decision.action === "dismiss" ? decision.reason.trim() : null,
    snoozedUntil:
      decision.action === "snooze"
        ? new Date(now.getTime() + decision.days * 24 * 3_600_000)
        : null,
    decidedAt: decision.action === "reopen" ? null : now,
    decidedByUserId: decision.action === "reopen" ? null : ctx.userId,
    evidence: finding.evidence as Prisma.InputJsonValue,
    computedAt: now,
  };
  await db.$transaction(async (tx) => {
    const state = await tx.marketingRecommendation.findFirst({
      where: { workspaceId: ctx.workspaceId, fingerprint: input.fingerprint },
      select: { id: true, version: true, status: true },
    });
    if (state === null) {
      if (input.version !== 0) throw conflict("version", "recommendation_changed", {});
      await tx.marketingRecommendation
        .create({
          data: {
            workspaceId: ctx.workspaceId,
            campaignId: finding.campaignId,
            contentItemId: finding.contentItemId,
            kind: finding.kind,
            fingerprint: finding.fingerprint,
            ...data,
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown }).code === "P2002") {
            throw conflict("version", "recommendation_changed", {});
          }
          throw error;
        });
    } else {
      if (state.status === "ACTED") {
        throw conflict("recommendation", "recommendation_not_actionable", { status: state.status });
      }
      const { count } = await tx.marketingRecommendation.updateMany({
        where: { workspaceId: ctx.workspaceId, id: state.id, version: input.version },
        data: { ...data, version: { increment: 1 } },
      });
      if (count === 0) throw conflict("version", "recommendation_changed", {});
    }
    await recordAudit(tx, ctx, {
      action: AUDIT[decision.action],
      entityType: "campaign",
      entityId: finding.campaignId,
      metadata: { kind: finding.kind, decision: decision.action },
    });
  });
}

const DRAFT_TEXT = {
  ar: {
    BELOW_TARGET: (goal: string) => `متابعة: النتائج دون هدف «${goal}»`,
    WEAK_CONTENT: (title: string) => `مراجعة وتحسين: ${title}`,
    STRONG_FORMAT: (type: string) => `فكرة جديدة بصيغة ${type}`,
    note: "مسودة أنشأها شخص من توصية مبنية على أرقام مسجلة. الأرقام ارتباط وليست سببًا مثبتًا؛ راجعها قبل الاعتماد.",
  },
  en: {
    BELOW_TARGET: (goal: string) => `Follow-up: results below the "${goal}" target`,
    WEAK_CONTENT: (title: string) => `Review and improve: ${title}`,
    STRONG_FORMAT: (type: string) => `New idea in the ${type} format`,
    note: "Draft created by a person from a recommendation based on recorded numbers. The numbers show an association, not a proven cause; review before approving.",
  },
} as const;

/**
 * Turns an actionable finding into a content DRAFT in its campaign (with the evidence in
 * the notes). The draft goes through the normal review and approval; nothing is
 * scheduled or published. Each finding is acted on once.
 */
export async function actOnRecommendation(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly fingerprint: string; readonly version: number },
  now: Date,
): Promise<{ readonly contentId: string }> {
  assertCan(ctx, "campaign.manage");
  assertCan(ctx, "content.create");
  const finding = await currentFinding(db, ctx, input.fingerprint, now);
  if (!ACTIONABLE_KINDS.has(finding.kind)) {
    throw conflict("recommendation", "recommendation_not_actionable", { kind: finding.kind });
  }
  return db.$transaction(async (tx) => {
    const workspace = await tx.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { defaultLocale: true },
    });
    const text = DRAFT_TEXT[workspace?.defaultLocale ?? "ar"];
    const values = finding.evidence.values;
    const subject =
      finding.contentItemId === null
        ? null
        : await tx.contentItem.findFirst({
            where: { workspaceId: ctx.workspaceId, id: finding.contentItemId },
            select: { title: true, type: true },
          });
    const title =
      finding.kind === "BELOW_TARGET"
        ? text.BELOW_TARGET(String(values.goal ?? ""))
        : finding.kind === "WEAK_CONTENT"
          ? text.WEAK_CONTENT(subject?.title ?? "")
          : text.STRONG_FORMAT(String(values.contentType ?? ""));
    const evidence = [
      text.note,
      `${finding.evidence.from ?? "?"} → ${finding.evidence.to ?? "?"} · n=${String(finding.evidence.sampleSize)}`,
      ...Object.entries(values).map(([key, value]) => `${key}: ${String(value)}`),
    ].join("\n");
    const formatType = CONTENT_TYPES.find((type) => type === values.contentType);
    const draftType: ContentType =
      finding.kind === "STRONG_FORMAT" ? (formatType ?? "POST") : (subject?.type ?? "POST");
    const { contentId } = await createContentIn(tx, ctx, {
      title: title.slice(0, 200),
      body: "",
      type: draftType,
      campaignId: finding.campaignId,
      pillarId: null,
      audienceId: null,
      goalId: null,
      plannedAt: null,
      notes: evidence.slice(0, 4000),
      hashtags: [],
      callToAction: null,
      link: null,
      assetIds: [],
    });
    const state = await tx.marketingRecommendation.findFirst({
      where: { workspaceId: ctx.workspaceId, fingerprint: finding.fingerprint },
      select: { id: true, version: true, status: true },
    });
    const data = {
      status: "ACTED" as const,
      draftContentItemId: contentId,
      decidedAt: now,
      decidedByUserId: ctx.userId,
      dismissReason: null,
      snoozedUntil: null,
      evidence: finding.evidence as Prisma.InputJsonValue,
      computedAt: now,
    };
    if (state === null) {
      if (input.version !== 0) throw conflict("version", "recommendation_changed", {});
      await tx.marketingRecommendation
        .create({
          data: {
            workspaceId: ctx.workspaceId,
            campaignId: finding.campaignId,
            contentItemId: finding.contentItemId,
            kind: finding.kind,
            fingerprint: finding.fingerprint,
            ...data,
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown }).code === "P2002") {
            throw conflict("version", "recommendation_changed", {});
          }
          throw error;
        });
    } else {
      if (state.status === "ACTED") {
        throw conflict("recommendation", "recommendation_not_actionable", { status: state.status });
      }
      const { count } = await tx.marketingRecommendation.updateMany({
        where: {
          workspaceId: ctx.workspaceId,
          id: state.id,
          version: input.version,
          status: { not: "ACTED" },
        },
        data: { ...data, version: { increment: 1 } },
      });
      if (count === 0) throw conflict("version", "recommendation_changed", {});
    }
    await recordAudit(tx, ctx, {
      action: "recommendation.acted",
      entityType: "campaign",
      entityId: finding.campaignId,
      metadata: { kind: finding.kind, contentId },
    });
    return { contentId };
  });
}
