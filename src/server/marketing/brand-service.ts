import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { changedFields } from "./common";
import type { BrandFields } from "./inputs";

// The workspace's brand profile (one per workspace). Read: brand.view; write: brand.edit.

const brandSelect = {
  id: true,
  name: true,
  description: true,
  website: true,
  industry: true,
  market: true,
  language: true,
  mission: true,
  positioning: true,
  valueProposition: true,
  toneOfVoice: true,
  personality: true,
  keywords: true,
  forbiddenWords: true,
  ctaStyle: true,
  updatedAt: true,
} as const;

export type BrandView = Awaited<ReturnType<typeof findBrand>>;

function findBrand(db: Db, ctx: TenantContext) {
  return db.brand.findFirst({ where: { workspaceId: ctx.workspaceId }, select: brandSelect });
}

/** The brand profile, or null before it is first saved. */
export async function getBrand(db: Db, ctx: TenantContext) {
  assertCan(ctx, "brand.view");
  return findBrand(db, ctx);
}

/**
 * Creates or updates the brand profile. Audit metadata lists the changed field names
 * only — brand text is business content, not something to copy into the audit trail.
 */
export async function saveBrand(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  fields: BrandFields,
): Promise<{ readonly brandId: string; readonly created: boolean }> {
  assertCan(ctx, "brand.edit");
  return db.$transaction(async (tx) => {
    // Serialize concurrent first saves on the workspace row (one brand per workspace).
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId}::uuid FOR UPDATE`;
    const existing = await findBrand(tx, ctx);
    if (existing === null) {
      const created = await tx.brand.create({
        data: { workspaceId: ctx.workspaceId, ...fields },
        select: { id: true },
      });
      await recordAudit(tx, ctx, {
        action: "brand.created",
        entityType: "brand",
        entityId: created.id,
        metadata: { fields: Object.keys(fields) },
      });
      return { brandId: created.id, created: true };
    }

    const changed = changedFields(existing, fields);
    if (changed.length > 0) {
      await tx.brand.updateMany({
        where: { workspaceId: ctx.workspaceId, id: existing.id },
        data: fields,
      });
      await recordAudit(tx, ctx, {
        action: "brand.updated",
        entityType: "brand",
        entityId: existing.id,
        metadata: { fields: changed },
      });
    }
    return { brandId: existing.id, created: false };
  });
}
