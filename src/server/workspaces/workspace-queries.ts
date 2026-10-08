import "server-only";

import { cookies } from "next/headers";

import { requireUser } from "../auth/session";
import { getDb } from "../db/client";
import { listMyWorkspaces, requireWorkspaceAccess } from "../tenancy/access";
import { can, canAssignRole } from "../tenancy/permissions";
import type { Role } from "../tenancy/roles";

import { listPendingInvitations, type PendingInvitation } from "./invitation-service";

import { decideWorkspaceLanding, type WorkspaceLanding, type WorkspaceSummary } from "./landing";
import { LAST_WORKSPACE_COOKIE, parseWorkspaceSlug } from "./last-workspace";
import { GRANTABLE_ROLES } from "./member-input";
import { listMembers } from "./member-repository";
import { getWorkspace } from "./workspace-service";

export interface WorkspaceOverview {
  readonly name: string;
  readonly slug: string;
  readonly role: Role;
}

/**
 * The workspace named by a URL slug, for the current user. Access is decided by
 * `requireWorkspaceAccess` (UNAUTHENTICATED / NOT_FOUND / FORBIDDEN), then the row is
 * read through the tenant-guarded client.
 */
export async function getWorkspaceOverview(slug: string): Promise<WorkspaceOverview> {
  const ctx = await requireWorkspaceAccess(slug, "workspace.view");
  const workspace = await getWorkspace(getDb(), ctx);
  return { name: workspace.name, slug: workspace.slug, role: ctx.role };
}

/** Everything the workspace shell shows. Nothing here comes from the client. */
export interface WorkspaceShell {
  readonly user: { readonly name: string; readonly email: string };
  readonly workspace: WorkspaceOverview;
  /** The user's own memberships, for the switcher. */
  readonly workspaces: readonly WorkspaceSummary[];
  /** Which navigation entries the current role may open. */
  readonly nav: { readonly members: boolean };
}

/**
 * Shell data for the workspace at `slug`: authorization first (as getWorkspaceOverview),
 * then the session user's own memberships for the switcher.
 */
export async function getWorkspaceShell(slug: string): Promise<WorkspaceShell> {
  const workspace = await getWorkspaceOverview(slug);
  const [user, workspaces] = await Promise.all([requireUser(), listMyWorkspaces()]);
  return {
    user: { name: user.name, email: user.email },
    workspace,
    workspaces,
    nav: { members: can(workspace.role, "member.view") },
  };
}

/**
 * Where `/{locale}/workspaces` goes. The last-workspace cookie is read here and only
 * counts when it names one of the user's current memberships.
 */
export async function getMyWorkspaceLanding(
  options: { readonly showList?: boolean } = {},
): Promise<WorkspaceLanding> {
  const workspaces = await listMyWorkspaces();
  const lastSlug = parseWorkspaceSlug((await cookies()).get(LAST_WORKSPACE_COOKIE)?.value);
  return decideWorkspaceLanding(workspaces, { lastSlug, showList: options.showList === true });
}

export interface MemberView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly joinedAt: Date;
  readonly isSelf: boolean;
  /** UI hints only — every action is re-authorized on the server. */
  readonly canChangeRole: boolean;
  readonly canRemove: boolean;
}

export interface MembersPage {
  readonly role: Role;
  readonly members: readonly MemberView[];
  readonly invitations: readonly PendingInvitation[];
  readonly canInvite: boolean;
  /** Roles the current user may grant (invite or role change). */
  readonly grantableRoles: readonly Role[];
  /** The current user is the only OWNER, so leaving is refused. */
  readonly isLastOwner: boolean;
}

/**
 * The members page for the workspace at `slug`. Requires `member.view` (FORBIDDEN for
 * roles without it). Pending invitations are included only for `member.invite`.
 */
export async function getMembersPage(slug: string): Promise<MembersPage> {
  const ctx = await requireWorkspaceAccess(slug, "member.view");
  const db = getDb();
  const canInvite = can(ctx.role, "member.invite");
  const [rows, invitations] = await Promise.all([
    listMembers(db, ctx),
    canInvite ? listPendingInvitations(db, ctx) : Promise.resolve([]),
  ]);
  const owners = rows.filter((row) => row.role === "OWNER").length;
  const members = rows.map((row): MemberView => {
    const isSelf = row.userId === ctx.userId;
    const manageable = !isSelf && canAssignRole(ctx.role, row.role);
    return {
      id: row.id,
      name: row.user.name,
      email: row.user.email,
      role: row.role,
      joinedAt: row.createdAt,
      isSelf,
      canChangeRole: manageable && can(ctx.role, "member.updateRole"),
      canRemove: manageable && can(ctx.role, "member.remove"),
    };
  });
  return {
    role: ctx.role,
    members,
    invitations,
    canInvite,
    grantableRoles: canInvite
      ? GRANTABLE_ROLES.filter((role) => canAssignRole(ctx.role, role))
      : [],
    isLastOwner: ctx.role === "OWNER" && owners <= 1,
  };
}
