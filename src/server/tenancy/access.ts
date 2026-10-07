import "server-only";

import { cache } from "react";

import type { PrismaClient } from "@/generated/prisma/client";

import { requireUser } from "../auth/session";
import { getSystemDb } from "../db/client";
import { AppError } from "../errors/app-error";

import type { WorkspaceSummary } from "../workspaces/landing";
import { listMembershipsForUser } from "../workspaces/member-repository";

import { createTenantContext, type TenantContext } from "./context";
import { assertCan, type Action } from "./permissions";
import { isRole } from "./roles";
import { normalizeWorkspaceSlug, WORKSPACE_SLUG_PATTERN } from "./slug";

export { WORKSPACE_SLUG_PATTERN } from "./slug";

/**
 * One response for every workspace the user cannot open — malformed slug, unknown slug,
 * soft-deleted workspace or no membership — so other workspaces' existence is never
 * revealed. The slug is not echoed into error metadata.
 */
function workspaceNotFound(): AppError {
  return new AppError("NOT_FOUND", { metadata: { resource: "workspace" } });
}

/**
 * SYSTEM PATH (reviewed): resolves a workspace slug to a TenantContext for `userId`
 * from the membership row alone. The workspace id and role come only from the
 * database — never from the client. Uses the system client because membership lookup
 * by user crosses workspaces by design; it is filtered to this one user and slug.
 */
export async function resolveWorkspaceAccess(
  systemDb: PrismaClient,
  userId: string,
  slug: unknown,
): Promise<TenantContext> {
  const normalized = typeof slug === "string" ? normalizeWorkspaceSlug(slug) : "";
  if (!WORKSPACE_SLUG_PATTERN.test(normalized)) throw workspaceNotFound();

  const membership = await systemDb.workspaceMember.findFirst({
    where: { userId, workspace: { slug: normalized, deletedAt: null } },
    select: { workspaceId: true, role: true },
  });
  if (membership === null || !isRole(membership.role)) throw workspaceNotFound();

  return createTenantContext({
    userId,
    workspaceId: membership.workspaceId,
    role: membership.role,
  });
}

/**
 * SYSTEM PATH (reviewed): the user's own memberships in non-deleted workspaces, oldest
 * first. Filtered to `userId`, which callers take from the session only.
 */
export async function listWorkspacesForUser(
  systemDb: PrismaClient,
  userId: string,
): Promise<WorkspaceSummary[]> {
  const memberships = await listMembershipsForUser(systemDb, userId);
  return memberships.flatMap(({ role, workspace }) =>
    isRole(role) ? [{ name: workspace.name, slug: workspace.slug, role }] : [],
  );
}

/** The current request's user's workspaces; throws UNAUTHENTICATED without a session. */
export async function listMyWorkspaces(): Promise<WorkspaceSummary[]> {
  const user = await requireUser();
  return listWorkspacesForUser(getSystemDb(), user.id);
}

const resolveForRequest = cache(async (slug: string): Promise<TenantContext> => {
  const user = await requireUser();
  return resolveWorkspaceAccess(getSystemDb(), user.id, slug);
});

/**
 * The only way application code obtains a TenantContext: session → membership lookup
 * by URL slug → optional permission check.
 *
 * - no valid session            → UNAUTHENTICATED (401)
 * - not a member / no such slug → NOT_FOUND (404), identical for both
 * - member without `action`     → FORBIDDEN (403)
 */
export async function requireWorkspaceAccess(
  slug: string,
  action?: Action,
): Promise<TenantContext> {
  const ctx = await resolveForRequest(slug);
  if (action !== undefined) assertCan(ctx, action);
  return ctx;
}
