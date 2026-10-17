import type { Prisma } from "@/generated/prisma/client";
import type { CampaignPlanStatus, MarketingChannel } from "@/generated/prisma/enums";

import { generateIdeas, type AiRuntime } from "../ai/ai-service";
import { readStoredOutput } from "../ai/operations";
import type { AiLanguage } from "../ai/provider";
import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db, GuardedTransactionClient } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import {
  assignChannels,
  briefFromIdea,
  MAX_PLAN_ITEMS,
  planTopic,
  spreadPlannedDates,
  utcDay,
  type PlanBriefFields,
  type PlanItemFields,
} from "./campaign-plan";
import { conflict, fieldError, notFound } from "./common";
import { createContentIn } from "./content-service";
import { isCampaignEditable } from "./workflow";

// Campaign content plans (Pass 4): campaign → plan → content drafts. Read: campaign.view.
// Write the brief and the items, approve or reopen: campaign.manage. Proposing items with
// AI also needs content.create (the AI engine's own rule, with its daily cap, credits,
// output validation and audit); creating drafts needs content.create (createContentIn).
//
// A plan is edited only while DRAFT. Approval accepts its included items; drafts are then
// created from them, each item exactly once (the item's content link is set under a
// condition and is unique). Every change is conditional on the plan's `version` (shown on
// the page), so two people editing at once cannot overwrite each other silently: the
// later change is refused (`plan_changed`) and nothing of it is kept. Nothing here
// submits, approves, schedules or publishes content: drafts go through the regular
// content workflow (review, approval, queue for the scheduler).

const itemSelect = {
  id: true,
  position: true,
  title: true,
  brief: true,
  contentType: true,
  channel: true,
  plannedDate: true,
  included: true,
  aiGenerated: true,
  contentItemId: true,
} as const;

const planSelect = {
  id: true,
  campaignId: true,
  status: true,
  offer: true,
  channels: true,
  budgetNotes: true,
  generationId: true,
  generation: { select: { provider: true } },
  approvedAt: true,
  approvedBy: { select: { name: true } },
  version: true,
  updatedAt: true,
  items: { select: itemSelect, orderBy: { position: "asc" } },
} as const;

export type CampaignPlanView = Prisma.CampaignPlanGetPayload<{ select: typeof planSelect }>;
export type CampaignPlanItemView = CampaignPlanView["items"][number];

/** The campaign's plan, or null when none was started. */
export async function getCampaignPlan(
  db: Db,
  ctx: TenantContext,
  campaignId: string,
): Promise<CampaignPlanView | null> {
  assertCan(ctx, "campaign.view");
  return db.campaignPlan.findFirst({
    where: { workspaceId: ctx.workspaceId, campaignId },
    select: planSelect,
  });
}

const planChanged = (metadata: Record<string, unknown> = {}) =>
  conflict("version", "plan_changed", metadata);

async function loadCampaign(tx: Db, ctx: TenantContext, campaignId: string) {
  const campaign = await tx.campaign.findFirst({
    where: { workspaceId: ctx.workspaceId, id: campaignId },
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      audienceId: true,
      goals: { select: { goal: { select: { id: true, status: true } } } },
    },
  });
  if (campaign === null) throw notFound("campaign");
  if (!isCampaignEditable(campaign.status)) {
    throw conflict("campaign", "campaign_locked", { status: campaign.status });
  }
  return campaign;
}

/**
 * Claims the plan for one change: increments its version if it is still at `version`
 * (and, when given, in `status`). The row stays locked until the transaction ends.
 */
async function claimPlan(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  campaignId: string,
  version: number,
  status: CampaignPlanStatus | null,
  data: Prisma.CampaignPlanUncheckedUpdateManyInput = {},
) {
  const plan = await tx.campaignPlan.findFirst({
    where: { workspaceId: ctx.workspaceId, campaignId },
    select: {
      id: true,
      status: true,
      version: true,
      channels: true,
      offer: true,
      budgetNotes: true,
    },
  });
  if (plan === null) throw notFound("campaign");
  if (status !== null && plan.status !== status) {
    throw conflict("plan", status === "DRAFT" ? "plan_locked" : "plan_not_approved", {
      status: plan.status,
    });
  }
  const { count } = await tx.campaignPlan.updateMany({
    where: {
      workspaceId: ctx.workspaceId,
      id: plan.id,
      version,
      ...(status === null ? {} : { status }),
    },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 0) throw planChanged({ expected: version, actual: plan.version });
  return plan;
}

function pickChannel(channels: readonly MarketingChannel[], index: number) {
  const channel = channels[index];
  if (channel === undefined) throw new RangeError("No channel for this item");
  return { channel };
}

async function itemCount(tx: Db, ctx: TenantContext, planId: string) {
  return tx.campaignPlanItem.count({ where: { workspaceId: ctx.workspaceId, planId } });
}

async function nextPosition(tx: Db, ctx: TenantContext, planId: string) {
  const last = await tx.campaignPlanItem.findFirst({
    where: { workspaceId: ctx.workspaceId, planId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return last === null ? 0 : last.position + 1;
}

/**
 * Saves the plan's brief (offer, channels, budget assumptions). Starts the plan when the
 * campaign has none (`version` 0); otherwise the plan must still be a DRAFT at `version`.
 */
export async function savePlanBrief(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  version: number,
  fields: PlanBriefFields,
): Promise<{ readonly planId: string }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    await loadCampaign(tx, ctx, campaignId);
    const existing = await tx.campaignPlan.findFirst({
      where: { workspaceId: ctx.workspaceId, campaignId },
      select: { id: true },
    });
    let planId: string;
    if (existing === null) {
      if (version !== 0) throw planChanged({ expected: version, actual: null });
      // Two people starting the same plan at once: the unique campaign id refuses the
      // second insert, which surfaces as a conflict (the transaction is rolled back).
      const created = await tx.campaignPlan
        .create({
          // Version 1: version 0 always means "no plan yet" to the page.
          data: { workspaceId: ctx.workspaceId, campaignId, ...fields, version: 1 },
          select: { id: true },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown }).code === "P2002") throw planChanged();
          throw error;
        });
      planId = created.id;
    } else {
      planId = (await claimPlan(tx, ctx, campaignId, version, "DRAFT", fields)).id;
    }
    await recordAudit(tx, ctx, {
      action: "campaign.plan_updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { channels: fields.channels.length, started: existing === null },
    });
    return { planId };
  });
}

/**
 * Proposes the plan's items with the AI engine (IDEAS for this campaign) and replaces the
 * items not yet turned into content. Dates and channels are assigned here, from the
 * campaign window and the person's channels — never by the model. If the plan changed
 * while the model was answering, nothing is replaced (`plan_changed`); the suggestion
 * stays in the person's AI history, unused.
 */
export async function generatePlanItems(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runtime: AiRuntime,
  campaignId: string,
  version: number,
  options: { readonly count: number; readonly uiLocale: AiLanguage; readonly today: Date },
): Promise<{ readonly items: number; readonly generationId: string }> {
  assertCan(ctx, "campaign.manage");
  assertCan(ctx, "content.create");
  const campaign = await loadCampaign(db, ctx, campaignId);
  const plan = await db.campaignPlan.findFirst({
    where: { workspaceId: ctx.workspaceId, campaignId },
    select: { status: true, version: true, channels: true, offer: true, budgetNotes: true },
  });
  if (plan === null) throw notFound("campaign");
  if (plan.status !== "DRAFT") throw conflict("plan", "plan_locked", { status: plan.status });
  if (plan.version !== version) throw planChanged({ expected: version, actual: plan.version });
  if (plan.channels.length === 0) throw fieldError("channels", "required");

  const dates = spreadPlannedDates(options.count, campaign, utcDay(options.today));
  const { generationId } = await generateIdeas(
    db,
    ctx,
    runtime,
    {
      topic: planTopic({
        offer: plan.offer,
        budgetNotes: plan.budgetNotes,
        channels: plan.channels,
        dates: { first: dates[0] ?? null, last: dates.at(-1) ?? null },
      }),
      count: options.count,
      language: undefined,
      pillarId: null,
      campaignId,
    },
    options.uiLocale,
  );

  return db.$transaction(async (tx) => {
    const claimed = await claimPlan(tx, ctx, campaignId, version, "DRAFT", { generationId });
    const generation = await tx.aiGeneration.findFirst({
      where: { workspaceId: ctx.workspaceId, id: generationId, userId: ctx.userId },
      select: { status: true, output: true, language: true },
    });
    const output =
      generation?.status === "SUCCEEDED" ? readStoredOutput("IDEAS", generation.output) : null;
    if (generation === null || output === null) {
      throw conflict("generation", "ai_not_usable", { generationId });
    }
    // Used once: the same suggestion cannot also become content through AI Studio.
    const used = await tx.aiGeneration.updateMany({
      where: { workspaceId: ctx.workspaceId, id: generationId, appliedAt: null },
      data: { appliedAt: new Date() },
    });
    if (used.count === 0) throw conflict("generation", "ai_already_used", { generationId });

    // Items already turned into content stay; every other item is replaced.
    await tx.campaignPlanItem.deleteMany({
      where: { workspaceId: ctx.workspaceId, planId: claimed.id, contentItemId: null },
    });
    const kept = await itemCount(tx, ctx, claimed.id);
    const ideas = output.ideas.slice(0, Math.max(0, MAX_PLAN_ITEMS - kept));
    const channels = assignChannels(ideas.length, claimed.channels);
    const ideaDates = spreadPlannedDates(ideas.length, campaign, utcDay(options.today));
    const start = await nextPosition(tx, ctx, claimed.id);
    await tx.campaignPlanItem.createMany({
      data: ideas.map((idea, index) => ({
        ...pickChannel(channels, index),
        workspaceId: ctx.workspaceId,
        planId: claimed.id,
        position: start + index,
        title: idea.title,
        brief: briefFromIdea(idea, generation.language),
        contentType: idea.contentType,
        plannedDate: ideaDates[index] ?? null,
        aiGenerated: true,
      })),
    });
    await recordAudit(tx, ctx, {
      action: "campaign.plan_generated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { items: ideas.length, kept, generationId },
    });
    return { items: ideas.length, generationId };
  });
}

/** Adds a hand-written item to a DRAFT plan. */
export async function addPlanItem(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  version: number,
  fields: PlanItemFields,
): Promise<{ readonly itemId: string }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    await loadCampaign(tx, ctx, campaignId);
    const plan = await claimPlan(tx, ctx, campaignId, version, "DRAFT");
    if ((await itemCount(tx, ctx, plan.id)) >= MAX_PLAN_ITEMS) {
      throw conflict("items", "too_big", { maximum: MAX_PLAN_ITEMS });
    }
    const created = await tx.campaignPlanItem.create({
      data: {
        workspaceId: ctx.workspaceId,
        planId: plan.id,
        position: await nextPosition(tx, ctx, plan.id),
        ...fields,
        aiGenerated: false,
      },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: "campaign.plan_updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { itemAdded: created.id },
    });
    return { itemId: created.id };
  });
}

async function editableItem(tx: Db, ctx: TenantContext, planId: string, itemId: string) {
  const item = await tx.campaignPlanItem.findFirst({
    where: { workspaceId: ctx.workspaceId, planId, id: itemId },
    select: { id: true, contentItemId: true },
  });
  if (item === null) throw notFound("campaign");
  if (item.contentItemId !== null) {
    throw conflict("item", "plan_item_converted", { itemId });
  }
  return item;
}

/** Edits an item of a DRAFT plan that has not become content. */
export async function updatePlanItem(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  itemId: string,
  version: number,
  fields: PlanItemFields,
): Promise<{ readonly itemId: string }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    await loadCampaign(tx, ctx, campaignId);
    const plan = await claimPlan(tx, ctx, campaignId, version, "DRAFT");
    await editableItem(tx, ctx, plan.id, itemId);
    await tx.campaignPlanItem.updateMany({
      where: { workspaceId: ctx.workspaceId, planId: plan.id, id: itemId, contentItemId: null },
      data: fields,
    });
    await recordAudit(tx, ctx, {
      action: "campaign.plan_updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { itemUpdated: itemId },
    });
    return { itemId };
  });
}

/** Removes an item of a DRAFT plan that has not become content. */
export async function removePlanItem(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  itemId: string,
  version: number,
): Promise<void> {
  assertCan(ctx, "campaign.manage");
  await db.$transaction(async (tx) => {
    await loadCampaign(tx, ctx, campaignId);
    const plan = await claimPlan(tx, ctx, campaignId, version, "DRAFT");
    await editableItem(tx, ctx, plan.id, itemId);
    await tx.campaignPlanItem.deleteMany({
      where: { workspaceId: ctx.workspaceId, planId: plan.id, id: itemId, contentItemId: null },
    });
    await recordAudit(tx, ctx, {
      action: "campaign.plan_updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { itemRemoved: itemId },
    });
  });
}

/** Accepts a DRAFT plan with at least one included item. */
export async function approvePlan(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  version: number,
): Promise<void> {
  assertCan(ctx, "campaign.manage");
  await db.$transaction(async (tx) => {
    await loadCampaign(tx, ctx, campaignId);
    const plan = await claimPlan(tx, ctx, campaignId, version, "DRAFT", {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByUserId: ctx.userId,
    });
    const included = await tx.campaignPlanItem.count({
      where: { workspaceId: ctx.workspaceId, planId: plan.id, included: true },
    });
    if (included === 0) throw conflict("items", "plan_empty", {});
    await recordAudit(tx, ctx, {
      action: "campaign.plan_approved",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { included },
    });
  });
}

/** Moves an APPROVED plan back to DRAFT for changes. Drafts already created stay linked. */
export async function reopenPlan(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  version: number,
): Promise<void> {
  assertCan(ctx, "campaign.manage");
  await db.$transaction(async (tx) => {
    await loadCampaign(tx, ctx, campaignId);
    await claimPlan(tx, ctx, campaignId, version, "APPROVED", {
      status: "DRAFT",
      approvedAt: null,
      approvedByUserId: null,
    });
    await recordAudit(tx, ctx, {
      action: "campaign.plan_reopened",
      entityType: "campaign",
      entityId: campaignId,
    });
  });
}

/** "2026-11-03" + 10:00 in the workspace's time zone (createContentIn converts it). */
const plannedLocal = (day: Date) => `${day.toISOString().slice(0, 10)}T10:00`;

/**
 * Creates a content DRAFT for every included item of an APPROVED plan that has none yet,
 * linked to the campaign, its audience and its first active goal. All in one transaction:
 * either every missing draft is created, or none. Repeating it creates nothing new.
 */
export async function createDraftsFromPlan(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  campaignId: string,
  version: number,
): Promise<{ readonly created: number }> {
  assertCan(ctx, "campaign.manage");
  assertCan(ctx, "content.create");
  return db.$transaction(async (tx) => {
    const campaign = await loadCampaign(tx, ctx, campaignId);
    const plan = await claimPlan(tx, ctx, campaignId, version, "APPROVED");
    const items = await tx.campaignPlanItem.findMany({
      where: { workspaceId: ctx.workspaceId, planId: plan.id, included: true, contentItemId: null },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: itemSelect,
    });
    const goalId = campaign.goals.find((link) => link.goal.status === "ACTIVE")?.goal.id ?? null;
    for (const item of items) {
      const { contentId } = await createContentIn(tx, ctx, {
        title: item.title,
        body: "",
        type: item.contentType,
        campaignId,
        pillarId: null,
        audienceId: campaign.audienceId,
        goalId,
        plannedAt: item.plannedDate === null ? null : plannedLocal(item.plannedDate),
        notes: item.brief === "" ? null : item.brief,
        hashtags: [],
        callToAction: null,
        link: null,
        assetIds: [],
      });
      // Set once: a concurrent run that linked this item first makes this one roll back.
      const linked = await tx.campaignPlanItem.updateMany({
        where: { workspaceId: ctx.workspaceId, id: item.id, contentItemId: null, included: true },
        data: { contentItemId: contentId },
      });
      if (linked.count === 0) throw planChanged({ itemId: item.id });
    }
    if (items.length > 0) {
      await recordAudit(tx, ctx, {
        action: "campaign.plan_drafts_created",
        entityType: "campaign",
        entityId: campaignId,
        metadata: { created: items.length },
      });
    }
    return { created: items.length };
  });
}

/** Most content items read for one campaign's progress (newest first beyond that). */
export const PROGRESS_CONTENT_LIMIT = 200;

/**
 * The recorded facts a campaign's progress is computed from (campaign-progress.ts): the
 * plan, the campaign's content with its latest review decision and its Page posts.
 * Read-only; content.view is needed for the content part.
 */
export async function campaignProgressFacts(db: Db, ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "campaign.view");
  assertCan(ctx, "content.view");
  const workspaceId = ctx.workspaceId;
  const campaign = await db.campaign.findFirst({
    where: { workspaceId, id: campaignId },
    select: { status: true, endDate: true },
  });
  if (campaign === null) throw notFound("campaign");
  const [plan, content] = await Promise.all([
    db.campaignPlan.findFirst({
      where: { workspaceId, campaignId },
      select: {
        status: true,
        items: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            title: true,
            channel: true,
            plannedDate: true,
            included: true,
            contentItemId: true,
          },
        },
      },
    }),
    db.contentItem.findMany({
      where: { workspaceId, campaignId },
      orderBy: { updatedAt: "desc" },
      take: PROGRESS_CONTENT_LIMIT,
      select: { id: true, title: true, status: true, scheduledAt: true },
    }),
  ]);
  const ids = content.map((item) => item.id);
  const [reviews, posts] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db.contentReview.findMany({
            where: { workspaceId, contentItemId: { in: ids } },
            orderBy: { createdAt: "desc" },
            distinct: ["contentItemId"],
            select: { contentItemId: true, decision: true },
          }),
          db.socialPost.findMany({
            where: { workspaceId, contentItemId: { in: ids } },
            orderBy: { updatedAt: "desc" },
            select: { contentItemId: true, status: true, errorCode: true, externalPostId: true },
          }),
        ]);
  const latest = new Map(reviews.map((review) => [review.contentItemId, review.decision]));
  return {
    campaign,
    plan,
    content: content.map((item) => ({
      ...item,
      latestReview: latest.get(item.id) ?? null,
      posts: posts.filter((post) => post.contentItemId === item.id),
    })),
  };
}
