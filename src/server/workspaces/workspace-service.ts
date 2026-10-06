import { recordAudit } from "../audit/audit-log";
import type { Db } from "../db/types";
import type { GuardedPrismaClient } from "../db/prisma";
import { AppError } from "../errors/app-error";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

/** Loads the context's workspace. Soft-deleted workspaces are treated as not found. */
export async function getWorkspace(db: Db, ctx: TenantContext) {
  assertCan(ctx, "workspace.view");
  const workspace = await db.workspace.findFirst({
    where: { id: ctx.workspaceId, deletedAt: null },
  });
  if (workspace === null)
    throw new AppError("NOT_FOUND", { metadata: { workspaceId: ctx.workspaceId } });
  return workspace;
}

/**
 * Soft-deletes the context's workspace and records the audit entry atomically.
 * Data is retained (including audit history). Permanent deletion is reserved for a
 * future, controlled purge job — it is intentionally not implemented in Phase 1.
 */
export async function softDeleteWorkspace(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  request: { readonly ip?: string | null; readonly userAgent?: string | null } = {},
) {
  assertCan(ctx, "workspace.delete");
  const deletedAt = new Date();

  await db.$transaction(async (tx) => {
    const { count } = await tx.workspace.updateMany({
      where: { id: ctx.workspaceId, deletedAt: null },
      data: { deletedAt },
    });
    if (count === 0)
      throw new AppError("NOT_FOUND", { metadata: { workspaceId: ctx.workspaceId } });

    await recordAudit(tx, ctx, {
      action: "workspace.soft_deleted",
      entityType: "workspace",
      entityId: ctx.workspaceId,
      metadata: { deletedAt: deletedAt.toISOString() },
      ip: request.ip ?? null,
      userAgent: request.userAgent ?? null,
    });
  });

  return { workspaceId: ctx.workspaceId, deletedAt };
}
