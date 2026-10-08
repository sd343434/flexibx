import { Prisma } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError, isAppError } from "../errors/app-error";
import type { TenantContext } from "../tenancy/context";
import { assertCan, canAssignRole } from "../tenancy/permissions";
import { isRole, type Role } from "../tenancy/roles";

import type { Mailer } from "../mail/mailer";
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
} from "./invitation-token";
import type { InviteMemberInput } from "./member-input";
import { lockAndLoadActor } from "./member-service";

// Invitations, managed from inside a workspace (create, list pending, revoke).
// Acceptance crosses workspaces by token and lives in the tenancy layer
// (src/server/tenancy/invitation-acceptance.ts).

/**
 * What happened to the invitation email. `sent` only when a provider accepted it;
 * otherwise the inviter must share the link manually and the UI says so.
 */
export type InvitationDelivery =
  | { readonly status: "sent" }
  | { readonly status: "not_sent"; readonly reason: "development" | "not_configured" | "failed" };

export interface CreatedInvitation {
  readonly invitationId: string;
  readonly email: string;
  readonly role: Role;
  readonly expiresAt: Date;
  /** Contains the one-time token: show it to the inviter once, never log or store it. */
  readonly acceptUrl: string;
  readonly delivery: InvitationDelivery;
}

export interface InvitationDependencies {
  readonly mailer: Mailer;
  /** APP_URL — the only origin used in invitation links. */
  readonly appUrl: string;
  /** Display name of the inviter (the session user), for the email. */
  readonly inviterName: string;
  readonly now?: () => Date;
}

function emailConflict(code: "already_member" | "invitation_pending"): AppError {
  return new AppError("CONFLICT", {
    message: code === "already_member" ? "Already a member" : "Invitation already pending",
    fields: [{ path: "email", code }],
    metadata: { resource: "invitation" },
  });
}

function invitationNotFound(): AppError {
  return new AppError("NOT_FOUND", { metadata: { resource: "invitation" } });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function deliver(
  mailer: Mailer,
  message: Parameters<Mailer["send"]>[0],
): Promise<InvitationDelivery> {
  try {
    const { status } = await mailer.send(message);
    return status === "sent" ? { status: "sent" } : { status: "not_sent", reason: "development" };
  } catch (error) {
    const notConfigured = isAppError(error) && error.metadata.reason === "mailer_not_configured";
    return { status: "not_sent", reason: notConfigured ? "not_configured" : "failed" };
  }
}

/**
 * Invites an email address to the workspace with a non-owner role.
 *
 * Rules: `member.invite`, and the actor may grant the role (`canAssignRole`); the role is
 * one of GRANTABLE_ROLES (input schema; the DB also rejects OWNER). An address that is
 * already a member, or has a pending invitation, is a CONFLICT on `email`. An expired
 * pending invitation for the same address is replaced. The membership lock makes the
 * "already a member" check consistent with concurrent acceptance.
 *
 * The invitation is committed before any email is attempted; a mail failure never
 * undoes it, and the result says honestly whether an email was sent.
 */
export async function createInvitation(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: Pick<InviteMemberInput, "email" | "role" | "locale">,
  deps: InvitationDependencies,
): Promise<CreatedInvitation> {
  assertCan(ctx, "member.invite");
  if (!canAssignRole(ctx.role, input.role)) {
    throw new AppError("FORBIDDEN", { metadata: { actorRole: ctx.role, role: input.role } });
  }
  const now = deps.now?.() ?? new Date();
  const token = generateInvitationToken();
  const expiresAt = invitationExpiry(now);

  const created = await db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx, "member.invite");
    if (!canAssignRole(actor.role, input.role)) {
      throw new AppError("FORBIDDEN", { metadata: { actorRole: actor.role, role: input.role } });
    }
    const member = await tx.workspaceMember.findFirst({
      where: { workspaceId: ctx.workspaceId, user: { email: input.email } },
      select: { id: true },
    });
    if (member !== null) throw emailConflict("already_member");

    // An expired invitation still counts as pending for the unique index; drop it.
    await tx.workspaceInvitation.deleteMany({
      where: {
        workspaceId: ctx.workspaceId,
        email: input.email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { lte: now },
      },
    });
    const pending = await tx.workspaceInvitation.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        email: input.email,
        acceptedAt: null,
        revokedAt: null,
      },
      select: { id: true },
    });
    if (pending !== null) throw emailConflict("invitation_pending");

    const invitation = await tx.workspaceInvitation
      .create({
        data: {
          workspaceId: ctx.workspaceId,
          email: input.email,
          role: input.role,
          tokenHash: hashInvitationToken(token),
          invitedByUserId: ctx.userId,
          expiresAt,
          createdAt: now,
        },
        select: { id: true, email: true, role: true, expiresAt: true },
      })
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? emailConflict("invitation_pending") : error;
      });

    await recordAudit(tx, ctx, {
      action: "member.invited",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: {
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
      },
    });
    const workspace = await tx.workspace.findFirst({
      where: { id: ctx.workspaceId },
      select: { name: true },
    });
    return { invitation, workspaceName: workspace?.name ?? "" };
  });

  const { invitation } = created;
  const acceptUrl = buildInvitationUrl(deps.appUrl, input.locale, token);
  const delivery = await deliver(deps.mailer, {
    to: invitation.email,
    locale: input.locale,
    template: "workspace_invitation",
    data: {
      workspaceName: created.workspaceName,
      inviterName: deps.inviterName,
      role: invitation.role,
      acceptUrl,
      expiresAt: invitation.expiresAt,
    },
  });

  return {
    invitationId: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    acceptUrl,
    delivery,
  };
}

export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly expired: boolean;
  readonly invitedBy: string | null;
}

/**
 * Open (not accepted, not revoked) invitations of the workspace, newest first, including
 * expired ones (flagged). Only for `member.invite`: the list shows non-members' emails.
 */
export async function listPendingInvitations(
  db: Db,
  ctx: TenantContext,
  now: Date = new Date(),
): Promise<PendingInvitation[]> {
  assertCan(ctx, "member.invite");
  const rows = await db.workspaceInvitation.findMany({
    where: { workspaceId: ctx.workspaceId, acceptedAt: null, revokedAt: null },
    select: {
      id: true,
      email: true,
      role: true,
      createdAt: true,
      expiresAt: true,
      invitedBy: { select: { name: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
  });
  return rows.flatMap((row) =>
    isRole(row.role)
      ? [
          {
            id: row.id,
            email: row.email,
            role: row.role,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            expired: row.expiresAt.getTime() <= now.getTime(),
            invitedBy: row.invitedBy?.name ?? null,
          },
        ]
      : [],
  );
}

/**
 * Revokes an open invitation; its link stops working immediately. `member.invite`, and
 * the actor must be allowed to grant the invitation's role. Unknown, foreign, accepted
 * or already revoked → NOT_FOUND.
 */
export async function revokeInvitation(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly invitationId: string },
  now: Date = new Date(),
): Promise<{ readonly invitationId: string }> {
  assertCan(ctx, "member.invite");
  return db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx, "member.invite");
    const open = {
      workspaceId: ctx.workspaceId,
      id: input.invitationId,
      acceptedAt: null,
      revokedAt: null,
    };
    const invitation = await tx.workspaceInvitation.findFirst({
      where: open,
      select: { id: true, email: true, role: true },
    });
    if (invitation === null || !isRole(invitation.role)) throw invitationNotFound();
    if (!canAssignRole(actor.role, invitation.role)) {
      throw new AppError("FORBIDDEN", {
        metadata: { actorRole: actor.role, role: invitation.role },
      });
    }
    const { count } = await tx.workspaceInvitation.updateMany({
      where: open,
      data: { revokedAt: now },
    });
    if (count !== 1) throw invitationNotFound();
    await recordAudit(tx, ctx, {
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
    });
    return { invitationId: invitation.id };
  });
}
