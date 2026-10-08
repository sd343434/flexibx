import type { Prisma } from "@/generated/prisma/client";
import type { ContentStatus, ContentType } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db, GuardedTransactionClient } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan, can } from "../tenancy/permissions";

import {
  changedFields,
  conflict,
  fieldError,
  notFound,
  resolveReference,
  toInstant,
  workspaceTimeZone,
} from "./common";
import { CONTENT_PAGE_SIZE, type ContentFields, type ContentTransition } from "./inputs";
import {
  contentDeletePermission,
  contentTransitionRule,
  isContentEditable,
  reschedulePermission,
  transitionsFrom,
} from "./workflow";

// Content items and their workflow. Read: content.view; create: content.create; edit
// (drafts only): content.edit; status changes: the permission of each transition
// (workflow.ts). Every status change is a conditional update on the status that was read,
// so concurrent changes cannot both apply, and is audited with from/to.

export interface ContentMetadata {
  readonly hashtags: string[];
  readonly callToAction: string | null;
  readonly link: string | null;
}

/** Stored metadata, defensively re-shaped (the column is JSON). */
export function contentMetadata(value: unknown): ContentMetadata {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const hashtags = Array.isArray(record.hashtags)
    ? record.hashtags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    hashtags,
    callToAction: typeof record.callToAction === "string" ? record.callToAction : null,
    link: typeof record.link === "string" ? record.link : null,
  };
}

const contentListSelect = {
  id: true,
  title: true,
  type: true,
  status: true,
  scheduledAt: true,
  publishedAt: true,
  updatedAt: true,
  campaign: { select: { id: true, name: true } },
  pillar: { select: { id: true, name: true } },
} as const;

export type ContentListRow = Prisma.ContentItemGetPayload<{ select: typeof contentListSelect }>;

export interface ContentListFilters {
  readonly status?: ContentStatus | undefined;
  readonly type?: ContentType | undefined;
  readonly campaignId?: string | undefined;
  readonly pillarId?: string | undefined;
  readonly q?: string | undefined;
  readonly page: number;
}

export async function listContent(
  db: Db,
  ctx: TenantContext,
  filters: ContentListFilters,
): Promise<{ readonly items: ContentListRow[]; readonly total: number; readonly pages: number }> {
  assertCan(ctx, "content.view");
  const where: Prisma.ContentItemWhereInput = {
    workspaceId: ctx.workspaceId,
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.type === undefined ? {} : { type: filters.type }),
    ...(filters.campaignId === undefined ? {} : { campaignId: filters.campaignId }),
    ...(filters.pillarId === undefined ? {} : { pillarId: filters.pillarId }),
    ...(filters.q === undefined || filters.q === ""
      ? {}
      : { title: { contains: filters.q, mode: "insensitive" as const } }),
  };
  const [items, total] = await Promise.all([
    db.contentItem.findMany({
      where: { ...where, workspaceId: ctx.workspaceId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * CONTENT_PAGE_SIZE,
      take: CONTENT_PAGE_SIZE,
      select: contentListSelect,
    }),
    db.contentItem.count({ where: { ...where, workspaceId: ctx.workspaceId } }),
  ]);
  return { items, total, pages: Math.max(1, Math.ceil(total / CONTENT_PAGE_SIZE)) };
}

const contentDetailSelect = {
  id: true,
  title: true,
  body: true,
  type: true,
  status: true,
  campaignId: true,
  pillarId: true,
  audienceId: true,
  goalId: true,
  scheduledAt: true,
  publishedAt: true,
  notes: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  campaign: { select: { id: true, name: true, status: true } },
  pillar: { select: { id: true, name: true, status: true } },
  audience: { select: { id: true, name: true } },
  goal: { select: { id: true, title: true, status: true } },
  createdBy: { select: { name: true } },
  assets: {
    orderBy: [{ position: "asc" }, { mediaAssetId: "asc" }],
    select: {
      mediaAsset: {
        select: { id: true, filename: true, altText: true, width: true, height: true },
      },
    },
  },
} satisfies Prisma.ContentItemSelect;

export type ContentDetailRow = Prisma.ContentItemGetPayload<{ select: typeof contentDetailSelect }>;

export interface ContentDetail extends ContentDetailRow {
  /** Transitions the current role may run from the current status (UI hints only). */
  readonly transitions: readonly ContentTransition[];
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canReschedule: boolean;
}

/** Transitions `role` may run from `status` (the server re-checks on every request). */
export function availableTransitions(
  ctx: Pick<TenantContext, "role">,
  status: ContentStatus,
): ContentTransition[] {
  return transitionsFrom(status).filter((transition) =>
    can(ctx.role, contentTransitionRule(transition).permission),
  );
}

export async function getContent(
  db: Db,
  ctx: TenantContext,
  contentId: string,
): Promise<ContentDetail> {
  assertCan(ctx, "content.view");
  const row = await db.contentItem.findFirst({
    where: { workspaceId: ctx.workspaceId, id: contentId },
    select: contentDetailSelect,
  });
  if (row === null) throw notFound("content");
  const reschedule = reschedulePermission(row.status);
  return {
    ...row,
    transitions: availableTransitions(ctx, row.status),
    canEdit: isContentEditable(row.status) && can(ctx.role, "content.edit"),
    canDelete: can(ctx.role, contentDeletePermission(row.status)),
    canReschedule: reschedule !== null && can(ctx.role, reschedule),
  };
}

interface ResolvedContentLinks {
  readonly campaignId: string | null;
  readonly pillarId: string | null;
  readonly audienceId: string | null;
  readonly goalId: string | null;
  readonly assetIds: string[];
}

async function resolveContentLinks(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  fields: ContentFields,
  current: Partial<Omit<ResolvedContentLinks, "assetIds">> = {},
): Promise<ResolvedContentLinks> {
  const assetIds = [...new Set(fields.assetIds)];
  if (assetIds.length > 0) {
    const found = await tx.mediaAsset.count({
      where: { workspaceId: ctx.workspaceId, id: { in: assetIds } },
    });
    if (found !== assetIds.length) throw fieldError("assetIds", "reference_not_found");
  }
  return {
    campaignId: await resolveReference(
      tx,
      ctx,
      "campaign",
      fields.campaignId,
      "campaignId",
      current.campaignId ?? null,
    ),
    pillarId: await resolveReference(
      tx,
      ctx,
      "pillar",
      fields.pillarId,
      "pillarId",
      current.pillarId ?? null,
    ),
    audienceId: await resolveReference(tx, ctx, "audience", fields.audienceId, "audienceId"),
    goalId: await resolveReference(
      tx,
      ctx,
      "goal",
      fields.goalId,
      "goalId",
      current.goalId ?? null,
    ),
    assetIds,
  };
}

function toData(fields: ContentFields, links: ResolvedContentLinks, scheduledAt: Date | null) {
  return {
    title: fields.title,
    body: fields.body,
    type: fields.type,
    campaignId: links.campaignId,
    pillarId: links.pillarId,
    audienceId: links.audienceId,
    goalId: links.goalId,
    scheduledAt,
    notes: fields.notes,
    metadata: {
      hashtags: fields.hashtags,
      callToAction: fields.callToAction,
      link: fields.link,
    } satisfies ContentMetadata as Prisma.InputJsonObject,
  };
}

async function replaceAssetLinks(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  contentItemId: string,
  assetIds: readonly string[],
) {
  const workspaceId = ctx.workspaceId;
  await tx.contentItemAsset.deleteMany({ where: { workspaceId, contentItemId } });
  if (assetIds.length > 0) {
    await tx.contentItemAsset.createMany({
      data: assetIds.map((mediaAssetId, position) => ({
        workspaceId,
        contentItemId,
        mediaAssetId,
        position,
      })),
    });
  }
}

/** Creates a draft. The status is always DRAFT; the creator is the session user. */
export async function createContent(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  fields: ContentFields,
): Promise<{ readonly contentId: string }> {
  assertCan(ctx, "content.create");
  return db.$transaction(async (tx) => {
    const zone = await workspaceTimeZone(tx, ctx);
    const scheduledAt = toInstant(fields.plannedAt, zone, "plannedAt");
    const links = await resolveContentLinks(tx, ctx, fields);
    const created = await tx.contentItem.create({
      data: {
        workspaceId: ctx.workspaceId,
        ...toData(fields, links, scheduledAt),
        status: "DRAFT",
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await replaceAssetLinks(tx, ctx, created.id, links.assetIds);
    await recordAudit(tx, ctx, {
      action: "content.created",
      entityType: "content",
      entityId: created.id,
      metadata: { type: fields.type, assets: links.assetIds.length },
    });
    return { contentId: created.id };
  });
}

/** Edits a draft. Content past DRAFT must be moved back (withdraw/reopen) first. */
export async function updateContent(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  contentId: string,
  fields: ContentFields,
): Promise<{ readonly contentId: string }> {
  assertCan(ctx, "content.edit");
  return db.$transaction(async (tx) => {
    const existing = await tx.contentItem.findFirst({
      where: { workspaceId: ctx.workspaceId, id: contentId },
      select: {
        title: true,
        body: true,
        type: true,
        status: true,
        campaignId: true,
        pillarId: true,
        audienceId: true,
        goalId: true,
        scheduledAt: true,
        notes: true,
        metadata: true,
        assets: { orderBy: { position: "asc" }, select: { mediaAssetId: true } },
      },
    });
    if (existing === null) throw notFound("content");
    if (!isContentEditable(existing.status)) {
      throw conflict("content", "content_locked", { status: existing.status });
    }
    const zone = await workspaceTimeZone(tx, ctx);
    const scheduledAt = toInstant(fields.plannedAt, zone, "plannedAt");
    const links = await resolveContentLinks(tx, ctx, fields, existing);
    const data = toData(fields, links, scheduledAt);
    const changed = changedFields(
      { ...existing, metadata: contentMetadata(existing.metadata) },
      data,
    );
    const currentAssets = existing.assets.map((link) => link.mediaAssetId);
    const assetsChanged = currentAssets.join() !== links.assetIds.join();
    if (assetsChanged) changed.push("assetIds");
    if (changed.length === 0) return { contentId };

    const { count } = await tx.contentItem.updateMany({
      where: { workspaceId: ctx.workspaceId, id: contentId, status: "DRAFT" },
      data,
    });
    if (count === 0) throw conflict("content", "stale_status", { status: existing.status });
    if (assetsChanged) await replaceAssetLinks(tx, ctx, contentId, links.assetIds);
    await recordAudit(tx, ctx, {
      action: "content.updated",
      entityType: "content",
      entityId: contentId,
      metadata: { fields: changed },
    });
    return { contentId };
  });
}

/**
 * Runs one workflow transition. The client names the transition, never the resulting
 * status; the rule decides the permission, the allowed starting statuses and the result.
 * `schedule` needs a future time (`scheduledAt`, workspace time zone; the planned time is
 * used when none is given). `publish` records that the content went out (no external
 * publishing happens in Flexibx yet).
 */
export async function transitionContent(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: {
    readonly contentId: string;
    readonly transition: ContentTransition;
    readonly scheduledAt: string | null;
  },
  now: Date = new Date(),
): Promise<{ readonly contentId: string; readonly status: ContentStatus }> {
  const rule = contentTransitionRule(input.transition);
  assertCan(ctx, "content.view");
  assertCan(ctx, rule.permission);
  return db.$transaction(async (tx) => {
    const existing = await tx.contentItem.findFirst({
      where: { workspaceId: ctx.workspaceId, id: input.contentId },
      select: { status: true, scheduledAt: true },
    });
    if (existing === null) throw notFound("content");
    if (!rule.from.includes(existing.status)) {
      throw conflict("transition", "invalid_transition", {
        from: existing.status,
        transition: input.transition,
      });
    }

    const data: Prisma.ContentItemUpdateManyMutationInput = { status: rule.to };
    if (input.transition === "schedule") {
      const zone = await workspaceTimeZone(tx, ctx);
      const requested = toInstant(input.scheduledAt, zone, "scheduledAt");
      const when = requested ?? existing.scheduledAt;
      if (when === null) throw fieldError("scheduledAt", "schedule_required");
      if (when.getTime() <= now.getTime()) throw fieldError("scheduledAt", "schedule_in_past");
      data.scheduledAt = when;
    }
    if (rule.to === "PUBLISHED") data.publishedAt = now;

    const { count } = await tx.contentItem.updateMany({
      where: { workspaceId: ctx.workspaceId, id: input.contentId, status: existing.status },
      data,
    });
    if (count === 0) {
      throw conflict("transition", "stale_status", { from: existing.status, to: rule.to });
    }
    await recordAudit(tx, ctx, {
      action: "content.status_changed",
      entityType: "content",
      entityId: input.contentId,
      metadata: { transition: input.transition, from: existing.status, to: rule.to },
    });
    return { contentId: input.contentId, status: rule.to };
  });
}

/**
 * Moves content on the calendar. A SCHEDULED item needs content.publish and a future
 * time; unscheduled work needs content.edit and may also clear its planned time.
 * Published content cannot be moved.
 */
export async function rescheduleContent(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly contentId: string; readonly scheduledAt: string | null },
  now: Date = new Date(),
): Promise<{ readonly contentId: string; readonly scheduledAt: Date | null }> {
  assertCan(ctx, "content.view");
  return db.$transaction(async (tx) => {
    const existing = await tx.contentItem.findFirst({
      where: { workspaceId: ctx.workspaceId, id: input.contentId },
      select: { status: true, scheduledAt: true },
    });
    if (existing === null) throw notFound("content");
    const permission = reschedulePermission(existing.status);
    if (permission === null) {
      throw conflict("scheduledAt", "invalid_transition", { from: existing.status });
    }
    assertCan(ctx, permission);

    const zone = await workspaceTimeZone(tx, ctx);
    const scheduledAt = toInstant(input.scheduledAt, zone, "scheduledAt");
    if (existing.status === "SCHEDULED") {
      if (scheduledAt === null) throw fieldError("scheduledAt", "schedule_required");
      if (scheduledAt.getTime() <= now.getTime()) {
        throw fieldError("scheduledAt", "schedule_in_past");
      }
    }
    if ((existing.scheduledAt?.getTime() ?? null) === (scheduledAt?.getTime() ?? null)) {
      return { contentId: input.contentId, scheduledAt };
    }

    const { count } = await tx.contentItem.updateMany({
      where: { workspaceId: ctx.workspaceId, id: input.contentId, status: existing.status },
      data: { scheduledAt },
    });
    if (count === 0) throw conflict("scheduledAt", "stale_status", { from: existing.status });
    await recordAudit(tx, ctx, {
      action: "content.updated",
      entityType: "content",
      entityId: input.contentId,
      metadata: { fields: ["scheduledAt"], status: existing.status },
    });
    return { contentId: input.contentId, scheduledAt };
  });
}

/** Deletes a content item (its asset links go with it; the media itself stays). */
export async function deleteContent(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  contentId: string,
): Promise<{ readonly contentId: string }> {
  assertCan(ctx, "content.edit");
  return db.$transaction(async (tx) => {
    const existing = await tx.contentItem.findFirst({
      where: { workspaceId: ctx.workspaceId, id: contentId },
      select: { status: true, type: true },
    });
    if (existing === null) throw notFound("content");
    assertCan(ctx, contentDeletePermission(existing.status));
    const { count } = await tx.contentItem.deleteMany({
      where: { workspaceId: ctx.workspaceId, id: contentId, status: existing.status },
    });
    if (count === 0) throw conflict("content", "stale_status", { status: existing.status });
    await recordAudit(tx, ctx, {
      action: "content.deleted",
      entityType: "content",
      entityId: contentId,
      metadata: { status: existing.status, type: existing.type },
    });
    return { contentId };
  });
}
