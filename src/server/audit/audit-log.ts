import type { Prisma } from "@/generated/prisma/client";

import type { Db } from "../db/types";
import { redactSecrets } from "../redact";
import type { TenantContext } from "../tenancy/context";

/** Audit actions. Extend as modules ship; names are `<entity>.<past_tense_verb>`. */
export const AUDIT_ACTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.soft_deleted",
  "member.added",
  "member.role_changed",
  "member.removed",
  "member.left",
  "member.invited",
  "invitation.revoked",
  "invitation.accepted",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Who/where: a workspace context, or a platform-level actor (workspaceId = null). */
export type AuditScope =
  TenantContext | { readonly workspaceId: null; readonly userId: string | null };

const MAX_USER_AGENT_LENGTH = 512;

/**
 * Appends an audit record. Pass a transaction client to make the audit entry atomic
 * with the change it describes. Metadata is redacted before it is stored. Audit rows
 * are append-only (enforced by the tenant guard) and survive workspace deletion
 * (AuditLog → Workspace is ON DELETE RESTRICT).
 */
export async function recordAudit(db: Db, scope: AuditScope, entry: AuditEntry) {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    workspaceId: scope.workspaceId,
    actorUserId: scope.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: redactSecrets(entry.metadata ?? {}) as Prisma.InputJsonObject,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
  };
  return db.auditLog.create({ data });
}

/** Lists a workspace's audit trail, newest first, with cursor pagination. */
export async function listAuditLogs(
  db: Db,
  ctx: TenantContext,
  options: { readonly limit?: number; readonly cursor?: string } = {},
) {
  const take = Math.min(Math.max(options.limit ?? 50, 1), 100);
  return db.auditLog.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
  });
}
