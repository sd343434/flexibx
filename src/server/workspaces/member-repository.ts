import type { PrismaClient } from "@/generated/prisma/client";

import type { Db } from "../db/types";
import { scopedWhere, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

const memberSelect = {
  id: true,
  workspaceId: true,
  userId: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true, image: true } },
} as const;

/** Members of the context's workspace only. */
export async function listMembers(db: Db, ctx: TenantContext) {
  assertCan(ctx, "member.view");
  return db.workspaceMember.findMany({
    where: scopedWhere(ctx),
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
