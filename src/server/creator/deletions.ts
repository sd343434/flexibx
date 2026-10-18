import type { PrismaClient } from "@/generated/prisma/client";
import type { StorageProvider } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { Db } from "../db/types";
import { storageErrorSummary } from "../storage/storage";

import type { CreatorDeps } from "./config";

// Removing Creator Studio files from private storage (Pass 9). Pure (no `server-only`):
// the worker loop and the integration tests drive it.
//
// Every object to remove — files of a deleted project, an abandoned or rejected upload,
// an export a worker could not record — is first written to `creator_storage_deletions`
// in the same transaction that forgets it, so a crash, a storage outage or a slow
// provider never leaves a file that nothing points to. The sweep deletes each object
// (aborting an open multipart upload first), retrying with backoff until storage
// confirms; a deleted project's row is purged only once all its objects are gone. The
// queue rows are kept afterwards as the record of what was removed (keys only).

export type DeletionReason =
  "project_deleted" | "upload_expired" | "source_rejected" | "render_discarded";

export interface QueuedObject {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly reason: DeletionReason;
  readonly storageProvider: StorageProvider;
  readonly storageKey: string;
  readonly multipartUploadId?: string | null;
}

/** First retry after a failed delete; doubled each time, at most MAX_BACKOFF_MS. */
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;
/** How long a sweeper owns a row it is working on (another sweeper skips it). */
const CLAIM_MS = 5 * 60_000;
const DELETE_TIMEOUT_MS = 30_000;

/** Queues objects for deletion (inside the caller's transaction). A key queued twice stays once. */
export async function queueStorageDeletions(
  tx: Db,
  objects: readonly QueuedObject[],
  now: Date,
): Promise<void> {
  if (objects.length === 0) return;
  await tx.creatorStorageDeletion.createMany({
    data: objects.map((object) => ({
      workspaceId: object.workspaceId,
      projectId: object.projectId,
      reason: object.reason,
      storageProvider: object.storageProvider,
      storageKey: object.storageKey,
      multipartUploadId: object.multipartUploadId ?? null,
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
}

export interface SweepResult {
  readonly deleted: number;
  readonly failed: number;
  readonly purgedProjects: number;
}

/**
 * Deletes due objects, then purges deleted projects whose objects are all gone. `system`
 * finds work across workspaces (ids only); every write uses the row's own workspace.
 */
export async function processStorageDeletions(
  deps: CreatorDeps,
  system: PrismaClient,
  options: { readonly limit?: number; readonly now?: Date } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const due = await system.creatorStorageDeletion.findMany({
    where: { completedAt: null, nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: options.limit ?? 50,
    select: { id: true, workspaceId: true },
  });
  let deleted = 0;
  let failed = 0;
  for (const candidate of due) {
    // Claim: of several sweepers, one works on a row at a time.
    const claimed = await deps.db.creatorStorageDeletion.updateMany({
      where: {
        id: candidate.id,
        workspaceId: candidate.workspaceId,
        completedAt: null,
        nextAttemptAt: { lte: now },
      },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_MS), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    const row = await deps.db.creatorStorageDeletion.findFirst({
      where: { id: candidate.id, workspaceId: candidate.workspaceId },
    });
    if (row === null) continue;
    try {
      const storage = await deps.storage.forProvider(row.storageProvider);
      const signal = AbortSignal.timeout(DELETE_TIMEOUT_MS);
      if (row.multipartUploadId !== null) {
        if (storage.multipart === undefined) throw new Error("Storage has no multipart uploads");
        await storage.multipart.abort(row.storageKey, row.multipartUploadId, { signal });
      }
      await storage.delete(row.storageKey, { signal });
      await deps.db.creatorStorageDeletion.updateMany({
        where: { id: row.id, workspaceId: row.workspaceId, completedAt: null },
        data: { completedAt: new Date(), lastErrorCode: null },
      });
      deleted += 1;
    } catch (error) {
      failed += 1;
      const backoff = Math.min(
        BASE_BACKOFF_MS * 2 ** Math.max(0, row.attempts - 1),
        MAX_BACKOFF_MS,
      );
      await deps.db.creatorStorageDeletion.updateMany({
        where: { id: row.id, workspaceId: row.workspaceId, completedAt: null },
        data: {
          lastErrorCode: storageErrorSummary(error).name.slice(0, 60),
          nextAttemptAt: new Date(Date.now() + backoff),
        },
      });
      deps.logger?.warn(
        { deletionId: row.id, attempts: row.attempts, error: storageErrorSummary(error).name },
        "Could not delete a Creator Studio object; will retry",
      );
    }
  }
  return { deleted, failed, purgedProjects: await purgeDeletedProjects(deps, system) };
}

/**
 * A deleted project's row (and its event log) is removed once storage has confirmed the
 * deletion of every object queued for it. The audit trail and the credit ledger keep the
 * record that it existed, who deleted it and what was charged.
 */
async function purgeDeletedProjects(deps: CreatorDeps, system: PrismaClient): Promise<number> {
  const deleting = await system.creatorProject.findMany({
    where: { status: "DELETING" },
    orderBy: { deletedAt: "asc" },
    take: 50,
    select: { id: true, workspaceId: true },
  });
  let purged = 0;
  for (const project of deleting) {
    const removed = await deps.db.$transaction(async (tx) => {
      const pending = await tx.creatorStorageDeletion.count({
        where: { workspaceId: project.workspaceId, projectId: project.id, completedAt: null },
      });
      if (pending > 0) return false;
      const result = await tx.creatorProject.deleteMany({
        where: { id: project.id, workspaceId: project.workspaceId, status: "DELETING" },
      });
      if (result.count !== 1) return false;
      await recordAudit(
        tx,
        { workspaceId: project.workspaceId, userId: null },
        {
          action: "creator.project_purged",
          entityType: "creator_project",
          entityId: project.id,
        },
      );
      return true;
    });
    if (removed) purged += 1;
  }
  return purged;
}
