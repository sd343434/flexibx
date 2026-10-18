import "server-only";

import { z } from "zod";

import { MarketingChannel, PerformanceMetric } from "@/generated/prisma/enums";

import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { notFound } from "../marketing/common";
import { requireWorkspaceAccess } from "../tenancy/access";
import { can } from "../tenancy/permissions";

import { DEFAULT_RULES } from "./analysis";
import { importManualCsv, voidImport } from "./ingestion";
import { getInsightsDeps } from "./insights-runtime";
import { disableSource, enableSource, getSourceOverview, syncSourceNow } from "./insights-sync";
import {
  actOnRecommendation,
  decideRecommendation,
  getInsights,
  MAX_SNOOZE_DAYS,
  type InsightFilters,
} from "./intelligence-service";
import { MAX_IMPORT_BYTES } from "./metrics";

// Server actions and page data for marketing intelligence (Pass 5). Each action: strict
// input → session → `requireWorkspaceAccess(slug, action)` → the service, which re-checks
// the permission, scopes every query to the workspace and refuses stale versions.

const slug = z.string().min(1).max(100);
const fingerprint = z
  .string()
  .max(200)
  .regex(/^[A-Z_]+:[0-9a-f-]{36}:[A-Za-z0-9_:-]+$/);
const version = z.coerce.number().int().min(0).max(2_147_483_647);

export const importMetricsAction = withAction({
  name: "metrics.import",
  input: z.strictObject({
    slug,
    campaignId: z.uuid(),
    channel: z.enum(MarketingChannel),
    batchKey: z.uuid(),
    csv: z.string().min(1).max(MAX_IMPORT_BYTES),
  }),
  handler: async ({ slug: workspace, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "campaign.manage");
    return importManualCsv(getDb(), ctx, { ...input, today: new Date() });
  },
});

export const voidImportAction = withAction({
  name: "metrics.void",
  input: z.strictObject({ slug, importId: z.uuid() }),
  handler: async ({ slug: workspace, importId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "campaign.manage");
    await voidImport(getDb(), ctx, importId);
  },
});

export const decideRecommendationAction = withAction({
  name: "recommendation.decide",
  input: z.discriminatedUnion("action", [
    z.strictObject({ slug, fingerprint, version, action: z.literal("review") }),
    z.strictObject({ slug, fingerprint, version, action: z.literal("reopen") }),
    z.strictObject({
      slug,
      fingerprint,
      version,
      action: z.literal("dismiss"),
      reason: z.string().trim().min(1).max(500),
    }),
    z.strictObject({
      slug,
      fingerprint,
      version,
      action: z.literal("snooze"),
      days: z.coerce.number().int().min(1).max(MAX_SNOOZE_DAYS),
    }),
  ]),
  handler: async (input) => {
    const ctx = await requireWorkspaceAccess(input.slug, "campaign.manage");
    const decision =
      input.action === "dismiss"
        ? { action: "dismiss" as const, reason: input.reason }
        : input.action === "snooze"
          ? { action: "snooze" as const, days: input.days }
          : { action: input.action };
    await decideRecommendation(
      getDb(),
      ctx,
      { fingerprint: input.fingerprint, version: input.version, decision },
      new Date(),
    );
  },
});

export const actOnRecommendationAction = withAction({
  name: "recommendation.act",
  input: z.strictObject({ slug, fingerprint, version }),
  handler: async ({ slug: workspace, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "campaign.manage");
    return actOnRecommendation(getDb(), ctx, input, new Date());
  },
});

// Meta Insights sources (Pass 6): choosing them needs social.manage (the same people who
// manage the workspace's Meta channels); a person's "Sync now" needs campaign.manage. The
// services re-check both, and every id is resolved inside the caller's workspace.

export const enableInsightsSourceAction = withAction({
  name: "insights.source_enable",
  input: z.strictObject({ slug, channelId: z.uuid() }),
  handler: async ({ slug: workspace, channelId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    return enableSource(getInsightsDeps(), ctx, channelId);
  },
});

export const disableInsightsSourceAction = withAction({
  name: "insights.source_disable",
  input: z.strictObject({ slug, sourceId: z.uuid() }),
  handler: async ({ slug: workspace, sourceId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    await disableSource(getDb(), ctx, sourceId);
  },
});

export const syncInsightsSourceAction = withAction({
  name: "insights.sync",
  input: z.strictObject({ slug, sourceId: z.uuid() }),
  handler: async ({ slug: workspace, sourceId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "campaign.manage");
    const outcome = await syncSourceNow(getInsightsDeps(), ctx, sourceId);
    // Counts and codes only (never what Meta answered).
    return {
      status: outcome.status,
      errorCode: outcome.errorCode,
      accepted: outcome.accepted,
      revised: outcome.revised,
      duplicates: outcome.duplicates,
    };
  },
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string | undefined) => {
  if (value === undefined || !DATE.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return at.toISOString().startsWith(value) ? at : null;
};

/** Filters from the page's query string; anything invalid falls back to "all". */
export function parseInsightFilters(
  query: Readonly<Record<string, string | undefined>>,
): InsightFilters {
  const campaign = z.uuid().safeParse(query.campaign);
  const channel = z.enum(MarketingChannel).safeParse(query.channel);
  const metric = z.enum(PerformanceMetric).safeParse(query.metric);
  const from = day(query.from);
  const to = day(query.to);
  return {
    campaignId: campaign.success ? campaign.data : null,
    channel: channel.success ? channel.data : null,
    metric: metric.success ? metric.data : "IMPRESSIONS",
    from,
    to: from !== null && to !== null && to < from ? null : to,
  };
}

/** The insights page: data for the filters, and what this person may do. */
export async function getInsightsPage(workspaceSlug: string, filters: InsightFilters) {
  const ctx = await requireWorkspaceAccess(workspaceSlug, "analytics.view");
  const db = getDb();
  const [insights, campaigns, sources] = await Promise.all([
    getInsights(db, ctx, filters, new Date(), DEFAULT_RULES),
    db.campaign.findMany({
      where: { workspaceId: ctx.workspaceId, status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, name: true },
    }),
    getSourceOverview(getInsightsDeps(), ctx),
  ]);
  if (filters.campaignId !== null && !campaigns.some((row) => row.id === filters.campaignId)) {
    throw notFound("campaign");
  }
  return {
    ...insights,
    campaignOptions: campaigns,
    sources,
    now: new Date(),
    can: {
      manage: can(ctx.role, "campaign.manage"),
      createContent: can(ctx.role, "content.create"),
      manageSources: can(ctx.role, "social.manage"),
      connectMeta: can(ctx.role, "ads.manage"),
    },
  };
}
