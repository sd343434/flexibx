import type { Prisma } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { changedFields, limitReached, notFound, resolveReference } from "./common";
import type { PillarFields } from "./inputs";

// Content pillars: the recurring themes content is planned around. Read: brand.view;
// write: brand.edit. Pillars are archived, not deleted, so existing content keeps them.

export const MAX_PILLARS = 30;

const pillarSelect = {
  id: true,
  name: true,
  description: true,
  objective: true,
  audienceId: true,
  audience: { select: { id: true, name: true } },
  status: true,
  position: true,
  updatedAt: true,
} as const;

export type PillarRow = Prisma.ContentPillarGetPayload<{ select: typeof pillarSelect }>;

const order = [
  { position: "asc" },
  { id: "asc" },
] as const satisfies Prisma.ContentPillarOrderByWithRelationInput[];

export async function listPillars(db: Db, ctx: TenantContext): Promise<PillarRow[]> {
  assertCan(ctx, "brand.view");
  return db.contentPillar.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [...order],
    take: MAX_PILLARS,
    select: pillarSelect,
  });
}

export async function getPillar(db: Db, ctx: TenantContext, pillarId: string): Promise<PillarRow> {
  assertCan(ctx, "brand.view");
  const row = await db.contentPillar.findFirst({
    where: { workspaceId: ctx.workspaceId, id: pillarId },
    select: pillarSelect,
  });
  if (row === null) throw notFound("pillar");
  return row;
}

function toData(fields: PillarFields, audienceId: string | null) {
  return {
    name: fields.name,
    description: fields.description,
    objective: fields.objective,
    audienceId,
    status: fields.archived ? ("ARCHIVED" as const) : ("ACTIVE" as const),
  };
}

export async function createPillar(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  fields: PillarFields,
): Promise<{ readonly pillarId: string }> {
  assertCan(ctx, "brand.edit");
  return db.$transaction(async (tx) => {
    const audienceId = await resolveReference(tx, ctx, "audience", fields.audienceId, "audienceId");
    const stats = await tx.contentPillar.aggregate({
      where: { workspaceId: ctx.workspaceId },
      _count: { _all: true },
      _max: { position: true },
    });
    if (stats._count._all >= MAX_PILLARS) throw limitReached("pillar", MAX_PILLARS);
    const created = await tx.contentPillar.create({
      data: {
        workspaceId: ctx.workspaceId,
        ...toData(fields, audienceId),
        position: (stats._max.position ?? -1) + 1,
      },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: "pillar.created",
      entityType: "pillar",
      entityId: created.id,
    });
    return { pillarId: created.id };
  });
}

export async function updatePillar(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  pillarId: string,
  fields: PillarFields,
): Promise<{ readonly pillarId: string }> {
  assertCan(ctx, "brand.edit");
  return db.$transaction(async (tx) => {
    const existing = await tx.contentPillar.findFirst({
      where: { workspaceId: ctx.workspaceId, id: pillarId },
      select: { name: true, description: true, objective: true, audienceId: true, status: true },
    });
    if (existing === null) throw notFound("pillar");
    const audienceId = await resolveReference(
      tx,
      ctx,
      "audience",
      fields.audienceId,
      "audienceId",
      existing.audienceId,
    );
    const data = toData(fields, audienceId);
    const changed = changedFields(existing, data);
    if (changed.length > 0) {
      await tx.contentPillar.updateMany({
        where: { workspaceId: ctx.workspaceId, id: pillarId },
        data,
      });
      await recordAudit(tx, ctx, {
        action: "pillar.updated",
        entityType: "pillar",
        entityId: pillarId,
        metadata: { fields: changed },
      });
    }
    return { pillarId };
  });
}

/** Swaps a pillar with its neighbour in the display order. At either end it is a no-op. */
export async function movePillar(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  pillarId: string,
  direction: "up" | "down",
): Promise<{ readonly moved: boolean }> {
  assertCan(ctx, "brand.edit");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId}::uuid FOR UPDATE`;
    const rows = await tx.contentPillar.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [...order],
      select: { id: true },
    });
    const index = rows.findIndex((row) => row.id === pillarId);
    if (index < 0) throw notFound("pillar");
    const target = direction === "up" ? index - 1 : index + 1;
    const neighbour = rows[target];
    if (neighbour === undefined) return { moved: false };

    const ids = rows.map((row) => row.id);
    ids[index] = neighbour.id;
    ids[target] = pillarId;
    // Renumber densely so earlier gaps or ties cannot make the order ambiguous.
    for (const [position, id] of ids.entries()) {
      await tx.contentPillar.updateMany({
        where: { workspaceId: ctx.workspaceId, id },
        data: { position },
      });
    }
    await recordAudit(tx, ctx, {
      action: "pillar.updated",
      entityType: "pillar",
      entityId: pillarId,
      metadata: { fields: ["position"], direction },
    });
    return { moved: true };
  });
}
