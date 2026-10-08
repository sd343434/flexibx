import type { Prisma } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { changedFields, limitReached, notFound } from "./common";
import type { AudienceFields } from "./inputs";

// Target audiences (personas). Read: brand.view; write: brand.edit. Deleting an audience
// leaves pillars, campaigns and content that referenced it unlinked (ON DELETE SET NULL).

export const MAX_AUDIENCES = 50;

const audienceSelect = {
  id: true,
  name: true,
  description: true,
  attributes: true,
  painPoints: true,
  needs: true,
  interests: true,
  buyingIntent: true,
  objections: true,
  preferredChannels: true,
  notes: true,
  updatedAt: true,
} as const;

export interface AudienceAttribute {
  readonly label: string;
  readonly value: string;
}

export type AudienceRow = Prisma.AudienceGetPayload<{ select: typeof audienceSelect }>;

/** Stored attributes, defensively re-shaped (the column is JSON). */
export function audienceAttributes(row: { readonly attributes: unknown }): AudienceAttribute[] {
  if (!Array.isArray(row.attributes)) return [];
  return row.attributes.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { label, value } = item as Record<string, unknown>;
    return typeof label === "string" && typeof value === "string" ? [{ label, value }] : [];
  });
}

export async function listAudiences(db: Db, ctx: TenantContext): Promise<AudienceRow[]> {
  assertCan(ctx, "brand.view");
  return db.audience.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_AUDIENCES,
    select: audienceSelect,
  });
}

export async function getAudience(db: Db, ctx: TenantContext, audienceId: string) {
  assertCan(ctx, "brand.view");
  const row = await db.audience.findFirst({
    where: { workspaceId: ctx.workspaceId, id: audienceId },
    select: audienceSelect,
  });
  if (row === null) throw notFound("audience");
  return row;
}

function toData(fields: AudienceFields) {
  return { ...fields, attributes: fields.attributes as Prisma.InputJsonArray };
}

export async function createAudience(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  fields: AudienceFields,
): Promise<{ readonly audienceId: string }> {
  assertCan(ctx, "brand.edit");
  return db.$transaction(async (tx) => {
    const count = await tx.audience.count({ where: { workspaceId: ctx.workspaceId } });
    if (count >= MAX_AUDIENCES) {
      throw limitReached("audience", MAX_AUDIENCES);
    }
    const created = await tx.audience.create({
      data: { workspaceId: ctx.workspaceId, ...toData(fields) },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: "audience.created",
      entityType: "audience",
      entityId: created.id,
    });
    return { audienceId: created.id };
  });
}

export async function updateAudience(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  audienceId: string,
  fields: AudienceFields,
): Promise<{ readonly audienceId: string }> {
  assertCan(ctx, "brand.edit");
  return db.$transaction(async (tx) => {
    const existing = await tx.audience.findFirst({
      where: { workspaceId: ctx.workspaceId, id: audienceId },
      select: audienceSelect,
    });
    if (existing === null) throw notFound("audience");
    const changed = changedFields(existing, fields);
    if (changed.length > 0) {
      await tx.audience.updateMany({
        where: { workspaceId: ctx.workspaceId, id: audienceId },
        data: toData(fields),
      });
      await recordAudit(tx, ctx, {
        action: "audience.updated",
        entityType: "audience",
        entityId: audienceId,
        metadata: { fields: changed },
      });
    }
    return { audienceId };
  });
}

export async function deleteAudience(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  audienceId: string,
): Promise<{ readonly audienceId: string }> {
  assertCan(ctx, "brand.edit");
  return db.$transaction(async (tx) => {
    const { count } = await tx.audience.deleteMany({
      where: { workspaceId: ctx.workspaceId, id: audienceId },
    });
    if (count === 0) throw notFound("audience");
    await recordAudit(tx, ctx, {
      action: "audience.deleted",
      entityType: "audience",
      entityId: audienceId,
    });
    return { audienceId };
  });
}
