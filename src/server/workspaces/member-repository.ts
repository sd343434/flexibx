import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { WorkspaceRole } from "@/generated/prisma/enums";

import type { Db, GuardedTransactionClient } from "../db/types";
import { scopedWhere, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

const memberSelect = {
  id: true,
  workspaceId: true,
  userId: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true, image: true } },
} satisfies Prisma.WorkspaceMemberSelect;

export type MemberRow = Prisma.WorkspaceMemberGetPayload<{ select: typeof memberSelect }>;

/** Members of the context's workspace only. */
export async function listMembers(db: Db, ctx: TenantContext): Promise<MemberRow[]> {
  assertCan(ctx, "member.view");
  return db.workspaceMember.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: memberSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** A member by id, or null when it does not exist in the context's workspace. */
export async function findMember(db: Db, ctx: TenantContext, memberId: string) {
  assertCan(ctx, "member.view");
  return db.workspaceMember.findFirst({
    where: scopedWhere(ctx, { id: memberId }),
    select: memberSelect,
  });
}

/**
 * Serializes membership changes in one workspace: takes a row lock on the workspace
 * for the rest of the transaction. Every operation that adds, removes or re-roles a
 * member (and invitation acceptance) calls this first, so checks such as "at least one
 * OWNER remains" cannot be raced by a concurrent change. Raw SQL because Prisma has no
 * SELECT … FOR UPDATE; the workspace id comes from a TenantContext or a database row.
 */
export async function lockWorkspaceMemberships(
  tx: GuardedTransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
}

/** Number of OWNER members of a workspace (call under lockWorkspaceMemberships). */
export async function countOwners(db: Db, workspaceId: string): Promise<number> {
  return db.workspaceMember.count({ where: { workspaceId, role: WorkspaceRole.OWNER } });
}

/** A user's membership row in one workspace, or null. */
export async function findMembershipByUser(db: Db, workspaceId: string, userId: string) {
  return db.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true, workspaceId: true, userId: true, role: true },
  });
}

/**
 * SYSTEM PATH (unguarded client): a user's memberships across workspaces, used to
 * resolve which workspaces they may open (Phase 2 `requireWorkspaceAccess`). Only ever
 * called with the authenticated user's own id. Soft-deleted workspaces are excluded.
 */
export async function listMembershipsForUser(systemDb: PrismaClient, userId: string) {
  return systemDb.workspaceMember.findMany({
    where: { userId, workspace: { deletedAt: null } },
    select: {
      role: true,
      workspace: {
        select: { id: true, name: true, slug: true, type: true, parentWorkspaceId: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}
