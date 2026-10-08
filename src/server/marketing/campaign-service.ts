import type { Prisma } from "@/generated/prisma/client";
import type { CampaignStatus } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db, GuardedTransactionClient } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import {
  changedFields,
  conflict,
  limitReached,
  notFound,
  resolveReference,
  resolveReferences,
} from "./common";
import type { CampaignFields } from "./inputs";
import { canChangeCampaignStatus, isCampaignEditable } from "./workflow";

// Campaigns: a time-boxed push towards goals, across pillars, for an audience. Read:
// campaign.view; write: campaign.manage. Campaigns are archived, never deleted.

export const MAX_CAMPAIGNS = 200;

/** "1500.5" → 150050n (two decimal places; the input schema bounds the digits). */
export function toMinorUnits(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

/** 150050n → "1500.50". */
export function fromMinorUnits(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const value = minor < 0n ? -minor : minor;
  return `${sign}${String(value / 100n)}.${String(value % 100n).padStart(2, "0")}`;
}

const campaignListSelect = {
  id: true,
  name: true,
  objective: true,
  startDate: true,
  endDate: true,
  status: true,
  budgetAmountMinor: true,
  budgetCurrency: true,
  audience: { select: { id: true, name: true } },
  _count: { select: { contentItems: true } },
  updatedAt: true,
} as const;

export type CampaignListRow = Prisma.CampaignGetPayload<{ select: typeof campaignListSelect }>;

export async function listCampaigns(
  db: Db,
  ctx: TenantContext,
  options: { readonly includeArchived?: boolean } = {},
): Promise<CampaignListRow[]> {
  assertCan(ctx, "campaign.view");
  return db.campaign.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(options.includeArchived === true ? {} : { status: { not: "ARCHIVED" } }),
    },
    orderBy: [{ startDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }],
    take: MAX_CAMPAIGNS,
    select: campaignListSelect,
  });
}

const campaignDetailSelect = {
  id: true,
  name: true,
  description: true,
  objective: true,
  startDate: true,
  endDate: true,
  status: true,
  audienceId: true,
  budgetAmountMinor: true,
  budgetCurrency: true,
  audience: { select: { id: true, name: true } },
  goals: { select: { goal: { select: { id: true, title: true, status: true } } } },
  pillars: { select: { pillar: { select: { id: true, name: true, status: true } } } },
  updatedAt: true,
} as const;

export type CampaignDetail = Prisma.CampaignGetPayload<{ select: typeof campaignDetailSelect }>;

export async function getCampaign(
  db: Db,
  ctx: TenantContext,
  campaignId: string,
): Promise<CampaignDetail> {
  assertCan(ctx, "campaign.view");
  const row = await db.campaign.findFirst({
    where: { workspaceId: ctx.workspaceId, id: campaignId },
    select: campaignDetailSelect,
  });
  if (row === null) throw notFound("campaign");
  return row;
}

interface ResolvedLinks {
  readonly audienceId: string | null;
  readonly goalIds: string[];
  readonly pillarIds: string[];
}

async function resolveLinks(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  fields: CampaignFields,
  current: { audienceId: string | null; goalIds: string[]; pillarIds: string[] } = {
    audienceId: null,
    goalIds: [],
    pillarIds: [],
  },
): Promise<ResolvedLinks> {
  return {
    audienceId: await resolveReference(
      tx,
      ctx,
      "audience",
      fields.audienceId,
      "audienceId",
      current.audienceId,
    ),
    goalIds: await resolveReferences(tx, ctx, "goal", fields.goalIds, "goalIds", current.goalIds),
    pillarIds: await resolveReferences(
      tx,
      ctx,
      "pillar",
      fields.pillarIds,
      "pillarIds",
      current.pillarIds,
    ),
  };
}

function toData(fields: CampaignFields, audienceId: string | null) {
  return {
    name: fields.name,
    description: fields.description,
    objective: fields.objective,
    startDate: fields.startDate,
    endDate: fields.endDate,
    audienceId,
    budgetAmountMinor: fields.budgetAmount === null ? null : toMinorUnits(fields.budgetAmount),
    budgetCurrency: fields.budgetCurrency,
  };
}

async function replaceLinks(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  campaignId: string,
  links: ResolvedLinks,
) {
  const workspaceId = ctx.workspaceId;
  await tx.campaignGoal.deleteMany({ where: { workspaceId, campaignId } });
  await tx.campaignPillar.deleteMany({ where: { workspaceId, campaignId } });
  if (links.goalIds.length > 0) {
    await tx.campaignGoal.createMany({
      data: links.goalIds.map((goalId) => ({ workspaceId, campaignId, goalId })),
    });
  }
  if (links.pillarIds.length > 0) {
    await tx.campaignPillar.createMany({
      data: links.pillarIds.map((pillarId) => ({ workspaceId, campaignId, pillarId })),
    });
  }
}

export async function createCampaign(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  fields: CampaignFields,
): Promise<{ readonly campaignId: string }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    if ((await tx.campaign.count({ where: { workspaceId: ctx.workspaceId } })) >= MAX_CAMPAIGNS) {
      throw limitReached("campaign", MAX_CAMPAIGNS);
    }
    const links = await resolveLinks(tx, ctx, fields);
    const created = await tx.campaign.create({
      data: { workspaceId: ctx.workspaceId, ...toData(fields, links.audienceId) },
      select: { id: true },
    });
    await replaceLinks(tx, ctx, created.id, links);
    await recordAudit(tx, ctx, {
      action: "campaign.created",
      entityType: "campaign",
      entityId: created.id,
      metadata: { goals: links.goalIds.length, pillars: links.pillarIds.length },
    });
    return { campaignId: created.id };
  });
}

const sorted = (values: readonly string[]) => [...values].sort();

export async function updateCampaign(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  fields: CampaignFields,
): Promise<{ readonly campaignId: string }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.campaign.findFirst({
      where: { workspaceId: ctx.workspaceId, id: campaignId },
      select: {
        name: true,
        description: true,
        objective: true,
        startDate: true,
        endDate: true,
        audienceId: true,
        budgetAmountMinor: true,
        budgetCurrency: true,
        status: true,
        goals: { select: { goalId: true } },
        pillars: { select: { pillarId: true } },
      },
    });
    if (existing === null) throw notFound("campaign");
    if (!isCampaignEditable(existing.status)) {
      throw conflict("campaign", "campaign_locked", { status: existing.status });
    }
    const current = {
      audienceId: existing.audienceId,
      goalIds: existing.goals.map((link) => link.goalId),
      pillarIds: existing.pillars.map((link) => link.pillarId),
    };
    const links = await resolveLinks(tx, ctx, fields, current);
    const data = toData(fields, links.audienceId);
    const changed = changedFields(
      { ...existing, budgetAmountMinor: existing.budgetAmountMinor?.toString() ?? null },
      { ...data, budgetAmountMinor: data.budgetAmountMinor?.toString() ?? null },
    );
    const goalsChanged = sorted(current.goalIds).join() !== sorted(links.goalIds).join();
    const pillarsChanged = sorted(current.pillarIds).join() !== sorted(links.pillarIds).join();
    if (goalsChanged) changed.push("goalIds");
    if (pillarsChanged) changed.push("pillarIds");
    if (changed.length === 0) return { campaignId };

    await tx.campaign.updateMany({
      where: { workspaceId: ctx.workspaceId, id: campaignId, status: existing.status },
      data,
    });
    if (goalsChanged || pillarsChanged) await replaceLinks(tx, ctx, campaignId, links);
    await recordAudit(tx, ctx, {
      action: "campaign.updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { fields: changed },
    });
    return { campaignId };
  });
}

/**
 * Moves a campaign along its lifecycle (CAMPAIGN_STATUS_TRANSITIONS). The update is
 * conditional on the status read, so two concurrent changes cannot both apply.
 */
export async function changeCampaignStatus(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  status: CampaignStatus,
): Promise<{ readonly campaignId: string; readonly status: CampaignStatus }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.campaign.findFirst({
      where: { workspaceId: ctx.workspaceId, id: campaignId },
      select: { status: true },
    });
    if (existing === null) throw notFound("campaign");
    if (!canChangeCampaignStatus(existing.status, status)) {
      throw conflict("status", "invalid_transition", { from: existing.status, to: status });
    }
    const { count } = await tx.campaign.updateMany({
      where: { workspaceId: ctx.workspaceId, id: campaignId, status: existing.status },
      data: { status },
    });
    if (count === 0)
      throw conflict("status", "stale_status", { from: existing.status, to: status });
    await recordAudit(tx, ctx, {
      action: status === "ARCHIVED" ? "campaign.archived" : "campaign.updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { fields: ["status"], from: existing.status, to: status },
    });
    return { campaignId, status };
  });
}
