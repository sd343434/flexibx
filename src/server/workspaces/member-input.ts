import { z } from "zod";

import { LOCALES } from "@/i18n/config";

import { WorkspaceRole } from "../tenancy/roles";

import { INVITATION_TOKEN_PATTERN } from "./invitation-token";

/**
 * Roles that can be granted by invitation or role change. Never OWNER (no ownership
 * transfer or co-owner creation in this phase) and never CLIENT (an agency-client role
 * that has no meaning in a BUSINESS workspace). Who may grant which of these is still
 * decided by `canAssignRole` in the permission matrix.
 */
export const GRANTABLE_ROLES = [
  WorkspaceRole.ADMIN,
  WorkspaceRole.MANAGER,
  WorkspaceRole.EDITOR,
  WorkspaceRole.VIEWER,
] as const;

// The URL slug only selects which of the session user's memberships to act through;
// `requireWorkspaceAccess` resolves it against the database. It is never authority.
const slug = z.string().min(1).max(100);
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Strict objects: a client cannot add a workspace id, user id or acting role.
export const inviteMemberInputSchema = z.strictObject({
  slug,
  email,
  role: z.enum(GRANTABLE_ROLES),
  /** Language of the invitation email and link. */
  locale: z.enum(LOCALES),
});

export const revokeInvitationInputSchema = z.strictObject({
  slug,
  invitationId: z.uuid(),
});

export const changeMemberRoleInputSchema = z.strictObject({
  slug,
  memberId: z.uuid(),
  role: z.enum(GRANTABLE_ROLES),
});

export const removeMemberInputSchema = z.strictObject({
  slug,
  memberId: z.uuid(),
});

export const leaveWorkspaceInputSchema = z.strictObject({ slug });

export const acceptInvitationInputSchema = z.strictObject({
  token: z.string().regex(INVITATION_TOKEN_PATTERN),
});

export type InviteMemberInput = z.output<typeof inviteMemberInputSchema>;
