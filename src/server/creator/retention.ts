import type { PrismaClient } from "@/generated/prisma/client";

import { STALE_WORK_DIR_MS } from "./media/workdir";

// Retention of Creator Studio files (Pass 10): a READ-ONLY report of what a proposed
// policy would remove. Nothing here deletes anything. Today every source and export is
// kept until its project is deleted; scratch directories are removed by the worker after
// STALE_WORK_DIR_MS; abandoned uploads expire with their session. A policy by age is the
// owner's decision (runbook § 11): once approved, enforcement is a separate change that
// queues objects through `creator_storage_deletions` like a project deletion.
//
// SYSTEM PATH (reviewed): cross-workspace COUNTS and byte totals only — no ids, names,
// keys or workspace identifiers leave this module. Pure (no `server-only`).

export interface RetentionPolicy {
  /** Keep stored source files this many days after upload (null: until project deletion). */
  readonly sourceDays: number | null;
  /** Keep rendered exports this many days after rendering (null: until project deletion). */
  readonly exportDays: number | null;
}

export interface RetentionBucket {
  readonly files: number;
  readonly bytes: number;
  /** What the policy would remove today (null: the policy keeps everything). */
  readonly beyondPolicy: { readonly files: number; readonly bytes: number } | null;
}

export interface RetentionReport {
  readonly checkedAt: string;
  /** Always false: the policy is reported, never applied, until the owner approves it. */
  readonly enforced: false;
  readonly policy: RetentionPolicy;
  readonly sources: RetentionBucket;
  readonly exports: RetentionBucket;
  readonly scratchMaxAgeHours: number;
}

const DAY_MS = 86_400_000;

export function retentionPolicyFromEnv(env: {
  readonly CREATOR_RETENTION_SOURCE_DAYS?: number | undefined;
  readonly CREATOR_RETENTION_EXPORT_DAYS?: number | undefined;
}): RetentionPolicy {
  return {
    sourceDays: env.CREATOR_RETENTION_SOURCE_DAYS ?? null,
    exportDays: env.CREATOR_RETENTION_EXPORT_DAYS ?? null,
  };
}

export async function retentionReport(
  system: PrismaClient,
  policy: RetentionPolicy,
  now: Date,
): Promise<RetentionReport> {
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  // Stored sources: uploaded and kept (pending uploads expire on their own; rejected
  // and expired ones were already queued for deletion).
  const storedSource = { status: { in: ["UPLOADED", "VERIFIED"] as ("UPLOADED" | "VERIFIED")[] } };
  const readyExport = { status: "READY" as const, storageKey: { not: null } };
  const [sources, exports, oldSources, oldExports] = await Promise.all([
    system.creatorSource.aggregate({
      where: storedSource,
      _count: { _all: true },
      _sum: { declaredBytes: true },
    }),
    system.creatorExport.aggregate({
      where: readyExport,
      _count: { _all: true },
      _sum: { byteSize: true },
    }),
    policy.sourceDays === null
      ? null
      : system.creatorSource.aggregate({
          where: { ...storedSource, createdAt: { lt: before(policy.sourceDays) } },
          _count: { _all: true },
          _sum: { declaredBytes: true },
        }),
    policy.exportDays === null
      ? null
      : system.creatorExport.aggregate({
          where: { ...readyExport, createdAt: { lt: before(policy.exportDays) } },
          _count: { _all: true },
          _sum: { byteSize: true },
        }),
  ]);
  return {
    checkedAt: now.toISOString(),
    enforced: false,
    policy,
    sources: {
      files: sources._count._all,
      bytes: sources._sum.declaredBytes ?? 0,
      beyondPolicy:
        oldSources === null
          ? null
          : { files: oldSources._count._all, bytes: oldSources._sum.declaredBytes ?? 0 },
    },
    exports: {
      files: exports._count._all,
      bytes: exports._sum.byteSize ?? 0,
      beyondPolicy:
        oldExports === null
          ? null
          : { files: oldExports._count._all, bytes: oldExports._sum.byteSize ?? 0 },
    },
    scratchMaxAgeHours: STALE_WORK_DIR_MS / 3_600_000,
  };
}
