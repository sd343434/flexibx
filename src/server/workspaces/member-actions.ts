import "server-only";

import { requireUser } from "../auth/session";
import { getDb } from "../db/client";
import { getEnv } from "../env";
import { withAction } from "../http/action-handler";
import { getMailer } from "../mail";
import { requireWorkspaceAccess } from "../tenancy/access";
import { acceptInvitationForCurrentUser } from "../tenancy/invitation-acceptance";

import { createInvitation, revokeInvitation } from "./invitation-service";
import {
  acceptInvitationInputSchema,
  changeMemberRoleInputSchema,
  inviteMemberInputSchema,
  leaveWorkspaceInputSchema,
  removeMemberInputSchema,
  revokeInvitationInputSchema,
} from "./member-input";
import { changeMemberRole, leaveWorkspace, removeMember } from "./member-service";

// Server actions for members and invitations. Each one: strict Zod input → session →
// `requireWorkspaceAccess(slug, action)` (membership and role from the database) →
// service (which re-checks the role under a lock). Results carry no secrets except the
// invitation link returned once to its creator; withAction never logs results.

export const inviteMemberAction = withAction({
  name: "member.invite",
  input: inviteMemberInputSchema,
  handler: async ({ slug, ...input }, { logger }) => {
    const user = await requireUser();
    const ctx = await requireWorkspaceAccess(slug, "member.invite");
    const created = await createInvitation(getDb(), ctx, input, {
      mailer: getMailer(),
      appUrl: getEnv().APP_URL,
      inviterName: user.name,
    });
    if (created.delivery.status === "not_sent" && created.delivery.reason !== "development") {
      logger.warn(
        { invitationId: created.invitationId, reason: created.delivery.reason },
        "Invitation email not sent; the inviter must share the link manually",
      );
    }
    return {
      email: created.email,
      role: created.role,
      expiresAt: created.expiresAt.toISOString(),
      acceptUrl: created.acceptUrl,
      delivery: created.delivery,
    };
  },
});

export const revokeInvitationAction = withAction({
  name: "invitation.revoke",
  input: revokeInvitationInputSchema,
  handler: async ({ slug, invitationId }) => {
    const ctx = await requireWorkspaceAccess(slug, "member.invite");
    return revokeInvitation(getDb(), ctx, { invitationId });
  },
});

export const changeMemberRoleAction = withAction({
  name: "member.updateRole",
  input: changeMemberRoleInputSchema,
  handler: async ({ slug, memberId, role }) => {
    const ctx = await requireWorkspaceAccess(slug, "member.updateRole");
    return changeMemberRole(getDb(), ctx, { memberId, role });
  },
});

export const removeMemberAction = withAction({
  name: "member.remove",
  input: removeMemberInputSchema,
  handler: async ({ slug, memberId }) => {
    const ctx = await requireWorkspaceAccess(slug, "member.remove");
    return removeMember(getDb(), ctx, { memberId });
  },
});

export const leaveWorkspaceAction = withAction({
  name: "member.leave",
  input: leaveWorkspaceInputSchema,
  handler: async ({ slug }) => {
    const ctx = await requireWorkspaceAccess(slug);
    return leaveWorkspace(getDb(), ctx);
  },
});

export const acceptInvitationAction = withAction({
  name: "invitation.accept",
  input: acceptInvitationInputSchema,
  handler: async ({ token }) => acceptInvitationForCurrentUser(token),
});
