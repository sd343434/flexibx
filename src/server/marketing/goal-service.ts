import type { Prisma } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { changedFields, limitReached, notFound } from "./common";
import type { GoalFields } from "./inputs";

// Marketing goals. Read: campaign.view; write: campaign.manage. Goals are never
// hard-deleted — they are archived through their status, so campaign history keeps them.

export const MAX_GOALS = 100;

const goalSelect = {
  id: true,
  type: true,
  title: true,
  description: true,
  kpi: true,
  target: true,
  startDate: true,
  endDate: true,
  status: true,
  updatedAt: true,
} as const;

export type GoalRow = Prisma.MarketingGoalGetPayload<{ select: typeof goalSelect }>;

export async function listGoals(db: Db, ctx: TenantContext): Promise<GoalRow[]> {
  assertCan(ctx, "campaign.view");
  return db.marketingGoal.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    take: MAX_GOALS,
    select: goalSelect,
  });
}

export async function getGoal(db: Db, ctx: TenantContext, goalId: string): Promise<GoalRow> {
  assertCan(ctx, "campaign.view");
  const row = await db.marketingGoal.findFirst({
    where: { workspaceId: ctx.workspaceId, id: goalId },
    select: goalSelect,
  });
  if (row === null) throw notFound("goal");
  return row;
}

const dateKey = (value: Date | null) => (value === null ? null : value.toISOString().slice(0, 10));

/** Comparable form of a goal for change detection (Decimal and Date to strings). */
function comparable(fields: Pick<GoalFields, keyof GoalFields> | GoalRow) {
  return {
    type: fields.type,
    title: fields.title,
    description: fields.description,
    kpi: fields.kpi,
    target: fields.target === null ? null : Number(String(fields.target)).toFixed(2),
    startDate: dateKey(fields.startDate),
    endDate: dateKey(fields.endDate),
    status: fields.status,
  };
}

export async function createGoal(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  fields: GoalFields,
): Promise<{ readonly goalId: string }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    if ((await tx.marketingGoal.count({ where: { workspaceId: ctx.workspaceId } })) >= MAX_GOALS) {
      throw limitReached("goal", MAX_GOALS);
    }
    const created = await tx.marketingGoal.create({
      data: { workspaceId: ctx.workspaceId, ...fields },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: "goal.created",
      entityType: "goal",
      entityId: created.id,
      metadata: { type: fields.type, status: fields.status },
    });
    return { goalId: created.id };
  });
}

export async function updateGoal(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  goalId: string,
  fields: GoalFields,
): Promise<{ readonly goalId: string }> {
  assertCan(ctx, "campaign.manage");
  return db.$transaction(async (tx) => {
    const existing = await tx.marketingGoal.findFirst({
      where: { workspaceId: ctx.workspaceId, id: goalId },
      select: goalSelect,
    });
    if (existing === null) throw notFound("goal");
    const changed = changedFields(comparable(existing), comparable(fields));
    if (changed.length > 0) {
      await tx.marketingGoal.updateMany({
        where: { workspaceId: ctx.workspaceId, id: goalId },
        data: fields,
      });
      await recordAudit(tx, ctx, {
        action: "goal.updated",
        entityType: "goal",
        entityId: goalId,
        metadata: {
          fields: changed,
          ...(existing.status === fields.status
            ? {}
            : { from: existing.status, to: fields.status }),
        },
      });
    }
    return { goalId };
  });
}
