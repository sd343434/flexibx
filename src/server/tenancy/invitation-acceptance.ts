import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import { isEmailVerificationRequired } from "../auth/auth";
import { requireUser, type AuthUser } from "../auth/session";
import { hasRequiredEmailVerification, requireVerifiedEmail } from "../auth/verified-email";
import { getDb, getSystemDb } from "../db/client";
import type { GuardedPrismaClient } from "../db/prisma";
import { AppError } from "../errors/app-error";
import { hashInvitationToken, isInvitationToken } from "../workspaces/invitation-token";
import { GRANTABLE_ROLES } from "../workspaces/member-input";
import { lockWorkspaceMemberships } from "../workspaces/member-repository";

import { createTenantContext } from "./context";
import type { Role } from "./roles";

// Accepting an invitation. The invitee is not a member yet, so there is no
// TenantContext to start from: the token is the only key, and it identifies the
// workspace. That lookup crosses workspaces by design, so it is a reviewed SYSTEM PATH
// (unguarded client, one row by unique token hash). Everything after it — the
// single-use claim, the membership insert and the audit entries — runs in one
// transaction on the tenant-guarded client, scoped to that workspace.
//
// Invalid, unknown, expired, revoked and already-used tokens all produce the same
// result ("invalid"), so a token holder learns nothing about which case applies.

export type InvitationUser = Pick<AuthUser, "id" | "email">;

export type InvitationPreview =
  | { readonly status: "invalid" }
  /** Verification policy applies and the account's email is not verified (C6). */
  | { readonly status: "email_unverified" }
  | { readonly status: "email_mismatch" }
  | { readonly status: "already_member"; readonly slug: string }
  | {
      readonly status: "valid";
      readonly workspaceName: string;
      readonly role: Role;
      readonly inviterName: string | null;
      readonly expiresAt: Date;
    };

export function invalidInvitation(): AppError {
  return new AppError("NOT_FOUND", {
    message: "Invitation is invalid, expired, revoked or already used",
    fields: [{ path: "token", code: "invitation_invalid" }],
    metadata: { resource: "invitation" },
  });
}

export function invitationEmailMismatch(): AppError {
  return new AppError("FORBIDDEN", {
    message: "Invitation belongs to another email address",
    fields: [{ path: "token", code: "invitation_email_mismatch" }],
    metadata: { resource: "invitation", reason: "email_mismatch" },
  });
}

function alreadyMember(): AppError {
  return new AppError("CONFLICT", {
    message: "Already a member of this workspace",
    fields: [{ path: "token", code: "already_member" }],
    metadata: { resource: "invitation" },
  });
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const isGrantable = (role: string): role is (typeof GRANTABLE_ROLES)[number] =>
  (GRANTABLE_ROLES as readonly string[]).includes(role);

/** SYSTEM PATH: the open invitation behind `token`, or null for every unusable case. */
async function findOpenInvitation(systemDb: PrismaClient, token: unknown, now: Date) {
  if (!isInvitationToken(token)) return null;
  const invitation = await systemDb.workspaceInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
      id: true,
      workspaceId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      invitedBy: { select: { name: true } },
      workspace: { select: { name: true, slug: true, deletedAt: true } },
    },
  });
  if (invitation === null) return null;
  if (
    invitation.acceptedAt !== null ||
    invitation.revokedAt !== null ||
    invitation.expiresAt.getTime() <= now.getTime() ||
    invitation.workspace.deletedAt !== null ||
    !isGrantable(invitation.role)
  ) {
    return null;
  }
  return { ...invitation, role: invitation.role };
}

/**
 * What the accept page shows to the signed-in `user`. Workspace details are revealed only
 * to the invited address; any other account sees "email_mismatch" and nothing else.
 */
export async function previewInvitation(
  systemDb: PrismaClient,
  user: InvitationUser,
  token: unknown,
  now: Date = new Date(),
): Promise<InvitationPreview> {
  const invitation = await findOpenInvitation(systemDb, token, now);
  if (invitation === null) return { status: "invalid" };
  if (!sameEmail(invitation.email, user.email)) return { status: "email_mismatch" };
  const membership = await systemDb.workspaceMember.findFirst({
    where: { workspaceId: invitation.workspaceId, userId: user.id },
    select: { id: true },
  });
  if (membership !== null) return { status: "already_member", slug: invitation.workspace.slug };
  return {
    status: "valid",
    workspaceName: invitation.workspace.name,
    role: invitation.role,
    inviterName: invitation.invitedBy?.name ?? null,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * Accepts the invitation behind `token` for `user` and returns the workspace slug.
 *
 * - unusable token (any reason)       → NOT_FOUND `invitation_invalid`
 * - signed in with a different email  → FORBIDDEN `invitation_email_mismatch`
 * - already a member                  → CONFLICT  `already_member` (invitation stays open)
 *
 * Single use under concurrency: inside the transaction the invitation is claimed with a
 * conditional update (still open and unexpired → accepted). Only one transaction can
 * win that update; a replay or a concurrent second accept sees zero rows and gets the
 * same NOT_FOUND. The membership lock serializes this with removals and role changes.
 */
export async function acceptInvitation(
  systemDb: PrismaClient,
  db: GuardedPrismaClient,
  user: InvitationUser,
  token: unknown,
  now: Date = new Date(),
): Promise<{ readonly slug: string }> {
  const invitation = await findOpenInvitation(systemDb, token, now);
  if (invitation === null) throw invalidInvitation();
  if (!sameEmail(invitation.email, user.email)) throw invitationEmailMismatch();
  const { workspaceId } = invitation;

  await db.$transaction(async (tx) => {
    await lockWorkspaceMemberships(tx, workspaceId);
    const open = { workspaceId, id: invitation.id, acceptedAt: null, revokedAt: null };
    const claim = await tx.workspaceInvitation.updateMany({
      where: { ...open, expiresAt: { gt: now } },
      data: { acceptedAt: now },
    });
    if (claim.count !== 1) throw invalidInvitation();

    const workspace = await tx.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (workspace === null) throw invalidInvitation();

    const existing = await tx.workspaceMember.findFirst({
      where: { workspaceId, userId: user.id },
      select: { id: true },
    });
    if (existing !== null) throw alreadyMember();

    const membership = await tx.workspaceMember.create({
      data: { workspaceId, userId: user.id, role: invitation.role },
      select: { id: true, workspaceId: true, userId: true, role: true },
    });
    const ctx = createTenantContext(membership);
    await recordAudit(tx, ctx, {
      action: "invitation.accepted",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: { role: membership.role, memberId: membership.id },
    });
    await recordAudit(tx, ctx, {
      action: "member.added",
      entityType: "member",
      entityId: membership.id,
      metadata: {
        userId: user.id,
        role: membership.role,
        via: "invitation",
        invitationId: invitation.id,
      },
    });
  });

  return { slug: invitation.workspace.slug };
}

/**
 * The accept page's view for the current session user. Under the email-verification
 * policy (C6) an unverified account sees only "email_unverified": the token is not even
 * looked up, so it learns nothing about the invitation.
 */
export async function previewInvitationForCurrentUser(token: unknown): Promise<InvitationPreview> {
  const user = await requireUser();
  const policy = { requireEmailVerification: isEmailVerificationRequired() };
  if (!hasRequiredEmailVerification(user, policy)) return { status: "email_unverified" };
  return previewInvitation(getSystemDb(), user, token);
}

/**
 * Accepts for the current session user (never a user id from input). Verified-only
 * under the C6 policy: the invited address is the only proof of identity (C4), so an
 * unverified account gets FORBIDDEN `email_not_verified` before the token is looked up.
 */
export async function acceptInvitationForCurrentUser(
  token: unknown,
): Promise<{ readonly slug: string }> {
  const user = await requireUser();
  requireVerifiedEmail(user, { requireEmailVerification: isEmailVerificationRequired() });
  return acceptInvitation(getSystemDb(), getDb(), user, token);
}
