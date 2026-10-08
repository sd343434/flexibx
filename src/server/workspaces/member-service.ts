import { WorkspaceRole } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { GuardedTransactionClient } from "../db/types";
import { AppError } from "../errors/app-error";
import type { TenantContext } from "../tenancy/context";
import { assertCan, canAssignRole, type Action } from "../tenancy/permissions";
import { isRole, type Role } from "../tenancy/roles";

import type { GRANTABLE_ROLES } from "./member-input";
import { countOwners, findMembershipByUser, lockWorkspaceMemberships } from "./member-repository";

// Member management inside one workspace. Every function takes a TenantContext from
// `requireWorkspaceAccess`; member ids and roles from the client are only lookup keys
// and requested values, checked here against the permission matrix.
//
// Each mutation runs in a transaction that first locks the workspace's memberships and
// re-reads the actor's CURRENT role, so a role change or removal that happened since the
// request started (or concurrently) is respected, and "the last OWNER" checks hold.

export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export function memberNotFound(): AppError {
  return new AppError("NOT_FOUND", { metadata: { resource: "member" } });
}

export function lastOwner(): AppError {
  return new AppError("CONFLICT", {
    message: "A workspace must keep at least one owner",
    fields: [{ path: "member", code: "last_owner" }],
    metadata: { resource: "member" },
  });
}

function forbidden(message: string, metadata: Record<string, unknown> = {}): AppError {
  return new AppError("FORBIDDEN", { message, metadata });
}

/**
 * Locks the workspace's memberships and returns the actor's current membership, checking
 * `action` against the role it has NOW. A former member gets NOT_FOUND (as for any
 * workspace they cannot open).
 */
export async function lockAndLoadActor(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  action?: Action,
): Promise<{ readonly id: string; readonly role: Role }> {
  await lockWorkspaceMemberships(tx, ctx.workspaceId);
  const actor = await findMembershipByUser(tx, ctx.workspaceId, ctx.userId);
  if (actor === null || !isRole(actor.role)) {
    throw new AppError("NOT_FOUND", { metadata: { resource: "workspace" } });
  }
  if (action !== undefined) assertCan({ role: actor.role }, action);
  return { id: actor.id, role: actor.role };
}

async function loadTarget(tx: GuardedTransactionClient, ctx: TenantContext, memberId: string) {
  const target = await tx.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspaceId, id: memberId },
    select: { id: true, userId: true, role: true },
  });
  if (target === null || !isRole(target.role)) throw memberNotFound();
  return { id: target.id, userId: target.userId, role: target.role };
}

async function assertNotLastOwner(tx: GuardedTransactionClient, ctx: TenantContext, role: Role) {
  if (role === WorkspaceRole.OWNER && (await countOwners(tx, ctx.workspaceId)) <= 1) {
    throw lastOwner();
  }
}

export interface MemberRoleChange {
  readonly memberId: string;
  readonly role: Role;
  readonly changed: boolean;
}

/**
 * Changes another member's role. Rules: `member.updateRole`; never your own role; the
 * actor must be allowed to grant both the member's current role and the new one
 * (`canAssignRole` — so ADMINs cannot touch OWNERs); the new role is never OWNER (input
 * schema); the last OWNER cannot be demoted. Foreign or unknown member → NOT_FOUND.
 */
export async function changeMemberRole(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly memberId: string; readonly role: GrantableRole },
): Promise<MemberRoleChange> {
  assertCan(ctx, "member.updateRole");
  return db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx, "member.updateRole");
    const target = await loadTarget(tx, ctx, input.memberId);
    if (target.userId === ctx.userId) throw forbidden("Members cannot change their own role");
    if (!canAssignRole(actor.role, target.role) || !canAssignRole(actor.role, input.role)) {
      throw forbidden("Role change outside the actor's authority", {
        actorRole: actor.role,
        from: target.role,
        to: input.role,
      });
    }
    if (target.role === input.role) {
      return { memberId: target.id, role: target.role, changed: false };
    }
    await assertNotLastOwner(tx, ctx, target.role);

    await tx.workspaceMember.updateMany({
      where: { workspaceId: ctx.workspaceId, id: target.id },
      data: { role: input.role },
    });
    await recordAudit(tx, ctx, {
      action: "member.role_changed",
      entityType: "member",
      entityId: target.id,
      metadata: { userId: target.userId, from: target.role, to: input.role },
    });
    return { memberId: target.id, role: input.role, changed: true };
  });
}

/**
 * Removes another member. Rules: `member.remove`; not yourself (leave instead); the
 * actor must be allowed to grant the member's role (ADMINs cannot remove OWNERs); never
 * the last OWNER. Foreign or unknown member → NOT_FOUND.
 */
export async function removeMember(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly memberId: string },
): Promise<{ readonly memberId: string }> {
  assertCan(ctx, "member.remove");
  return db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx, "member.remove");
    const target = await loadTarget(tx, ctx, input.memberId);
    if (target.userId === ctx.userId) throw forbidden("Use leave to remove yourself");
    if (!canAssignRole(actor.role, target.role)) {
      throw forbidden("Removal outside the actor's authority", {
        actorRole: actor.role,
        targetRole: target.role,
      });
    }
    await assertNotLastOwner(tx, ctx, target.role);

    await tx.workspaceMember.deleteMany({
      where: { workspaceId: ctx.workspaceId, id: target.id },
    });
    await recordAudit(tx, ctx, {
      action: "member.removed",
      entityType: "member",
      entityId: target.id,
      metadata: { userId: target.userId, role: target.role },
    });
    return { memberId: target.id };
  });
}

/**
 * The current user leaves the workspace. Any member may leave, except the last OWNER
 * (ownership transfer is not offered, so the workspace would be left without one).
 */
export async function leaveWorkspace(
  db: GuardedPrismaClient,
  ctx: TenantContext,
): Promise<{ readonly memberId: string }> {
  return db.$transaction(async (tx) => {
    const me = await lockAndLoadActor(tx, ctx);
    await assertNotLastOwner(tx, ctx, me.role);

    await tx.workspaceMember.deleteMany({ where: { workspaceId: ctx.workspaceId, id: me.id } });
    await recordAudit(tx, ctx, {
      action: "member.left",
      entityType: "member",
      entityId: me.id,
      metadata: { role: me.role },
    });
    return { memberId: me.id };
  });
}
