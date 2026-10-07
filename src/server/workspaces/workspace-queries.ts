import "server-only";

import { cookies } from "next/headers";

import { requireUser } from "../auth/session";
import { getDb } from "../db/client";
import { listMyWorkspaces, requireWorkspaceAccess } from "../tenancy/access";
import type { Role } from "../tenancy/roles";

import { decideWorkspaceLanding, type WorkspaceLanding, type WorkspaceSummary } from "./landing";
import { LAST_WORKSPACE_COOKIE, parseWorkspaceSlug } from "./last-workspace";
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
}

/**
 * Shell data for the workspace at `slug`: authorization first (as getWorkspaceOverview),
 * then the session user's own memberships for the switcher.
 */
export async function getWorkspaceShell(slug: string): Promise<WorkspaceShell> {
  const workspace = await getWorkspaceOverview(slug);
  const [user, workspaces] = await Promise.all([requireUser(), listMyWorkspaces()]);
  return { user: { name: user.name, email: user.email }, workspace, workspaces };
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
