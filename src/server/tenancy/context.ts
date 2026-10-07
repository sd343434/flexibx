import "server-only";

import { AppError } from "../errors/app-error";
import type { Role } from "./roles";

/**
 * Proof that the current user is a member of exactly one workspace with a given role.
 * Every service/repository function that touches workspace-owned data takes one.
 *
 * Built on the server only by `requireWorkspaceAccess` (src/server/tenancy/access.ts) from:
 * session → URL workspace slug → membership row. It is never constructed from
 * client-supplied values; a static test keeps `createTenantContext` out of other code.
 */
export interface TenantContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: Role;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function createTenantContext(input: TenantContext): TenantContext {
  if (!isUuid(input.userId) || !isUuid(input.workspaceId)) {
    throw new AppError("INTERNAL", {
      message: "Invalid tenant context identifiers",
      metadata: { userId: input.userId, workspaceId: input.workspaceId },
    });
  }
  return Object.freeze({ userId: input.userId, workspaceId: input.workspaceId, role: input.role });
}

/** Adds the workspace scope to a Prisma `where` clause. Caller-provided keys cannot override it. */
export function scopedWhere<W extends object>(
  ctx: TenantContext,
  where?: W,
): W & { workspaceId: string } {
  return { ...(where ?? ({} as W)), workspaceId: ctx.workspaceId };
}

/**
 * Asserts a loaded record belongs to the context's workspace. Foreign records are
 * reported as NOT_FOUND (not FORBIDDEN) so other workspaces' data is not revealed.
 */
export function assertSameWorkspace(
  ctx: TenantContext,
  record: { readonly workspaceId: string | null } | null,
): void {
  if (record?.workspaceId !== ctx.workspaceId) {
    throw new AppError("NOT_FOUND", { metadata: { workspaceId: ctx.workspaceId } });
  }
}
