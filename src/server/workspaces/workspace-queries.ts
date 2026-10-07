import "server-only";

import { getDb } from "../db/client";
import { requireWorkspaceAccess } from "../tenancy/access";
import type { Role } from "../tenancy/roles";

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
