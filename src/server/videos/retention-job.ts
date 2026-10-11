import { recordAudit, type AuditScope } from "../audit/audit-log";
import { AppError } from "../errors/app-error";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Mailer } from "../mail/mailer";
import { resolveTimeZone } from "../marketing/time";
import {
  assertKeyBelongsToWorkspace,
  type StorageProviderId,
  type StorageRouter,
  type StorageService,
} from "../storage/storage";
import { can } from "../tenancy/permissions";
import { isRole } from "../tenancy/roles";

import type { PrismaClient } from "@/generated/prisma/client";
import { isLocale, type Locale } from "@/i18n/config";

import {
  DELETION_ALERT_ATTEMPTS,
  DELETION_LEASE_MS,
  deletionRetryDelayMs,
  formatDeletionTime,
  METADATA_RETENTION_MS,
  STORAGE_DELETE_TIMEOUT_MS,
  type ReminderHours,
} from "./retention-policy";
import { OVERDUE_GRACE_MS, type RetentionBacklog } from "./retention-observability";

// Scheduled retention job for generated videos (run by scripts/video-retention.ts on a
// schedule, e.g. every 15 minutes). Safe to run concurrently and repeatedly:
//
// - Claims use `FOR UPDATE SKIP LOCKED` plus a lease, so two runs never work on the same
//   video at once, and a crashed run's claim is retried after the lease.
// - Object deletion is idempotent (deleting a missing object succeeds) and each file is
//   tombstoned (deleted_at) as soon as its object is gone, so a retry only touches what
//   is left. The final DELETED transition is conditional, so it happens exactly once.
// - Every deletion outcome is audited inside the video's workspace without an actor
//   (system job). Audit metadata never holds storage keys, titles or addresses.
// - Bounded: with a time budget, no new phase, claim or delete starts after it runs
//   out, and each storage delete waits at most storageTimeoutMs (a timed-out delete is
//   unconfirmed and retried). The result says when a run stopped early.
//
// SYSTEM PATH (reviewed): candidate selection spans workspaces and uses the system
// client; every per-video read and write afterwards is scoped to that video's workspace
// through the guarded client, and every storage key is checked against that workspace
// before it is deleted.

export interface RetentionLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

export interface RetentionDeps {
  readonly system: PrismaClient;
  readonly db: GuardedPrismaClient;
  /** Each file is deleted from the provider it was written to (recorded on its row). */
  readonly storage: StorageRouter;
  readonly mailer: Mailer;
  /** APP_URL: origin of the links in reminder emails. */
  readonly appUrl: string;
  /**
   * Email reminders are off unless explicitly enabled (VIDEO_EXPIRY_EMAILS=enabled with a
   * real email provider). Until then the in-app notices are the warning mechanism.
   */
  readonly remindersEnabled?: boolean;
  readonly logger?: RetentionLogger;
}

export interface RetentionOptions {
  /**
   * Evaluation instant: what has expired, which leases and retries are due, the metadata
   * cutoff. Defaults to the database's now() (server-side clock) at the start of the run.
   */
  readonly now?: Date;
  /**
   * Clock for the moments the run records: claims (lease start), failures (retry start)
   * and confirmed deletions. Defaults to the database clock, read when each happens; when
   * `now` is given and `clock` is not, it is the fixed `now` (deterministic tests).
   */
  readonly clock?: () => Promise<Date>;
  readonly batchSize?: number;
  /**
   * Stop starting new work this many ms after the run starts (no limit when omitted).
   * Work already started is not interrupted, except storage deletes, which are bounded
   * by `storageTimeoutMs`.
   */
  readonly timeBudgetMs?: number;
  /** Longest wait for one storage delete (default STORAGE_DELETE_TIMEOUT_MS). */
  readonly storageTimeoutMs?: number;
}

export interface RetentionResult {
  readonly now: Date;
  /** True when the time budget ran out and the run stopped early (partial run). */
  readonly stoppedAtDeadline: boolean;
  readonly reminders: {
    readonly supported: boolean;
    readonly sent: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly deletion: {
    readonly claimed: number;
    readonly deleted: number;
    /** Attempts that failed or timed out (retried after a backoff). */
    readonly failed: number;
    /**
     * Claimed, then left mid-way because the time budget ran out: the claim is handed
     * back without counting an attempt, and the next run continues.
     */
    readonly interrupted: number;
  };
  /**
   * Files whose storage provider could not be resolved (not configured, or its settings
   * could not be read). Each counts as a failed attempt of its video (retried later, never
   * deleted from another provider). Above 0 the run is NOT a normal completion: storage
   * configuration needs an operator (runtime status "storage_unavailable").
   */
  readonly storageUnavailableFiles: number;
  readonly purged: number;
}

const silentLogger: RetentionLogger = { info: () => undefined, warn: () => undefined };

const systemScope = (workspaceId: string): AuditScope => ({ workspaceId, userId: null });

export async function databaseNow(system: PrismaClient): Promise<Date> {
  const rows = await system.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  const now = rows[0]?.now;
  if (now === undefined) throw new Error("Could not read the database clock");
  return now;
}

export async function runVideoRetention(
  deps: RetentionDeps,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const startedAt = performance.now();
  const budget = options.timeBudgetMs;
  const run: RunContext = {
    now: options.now ?? (await databaseNow(deps.system)),
    clock:
      options.clock ??
      (options.now === undefined
        ? () => databaseNow(deps.system)
        : (
            (fixed) => () =>
              Promise.resolve(fixed)
          )(options.now)),
    pastDeadline: () => budget !== undefined && performance.now() - startedAt >= budget,
    storageTimeoutMs: options.storageTimeoutMs ?? STORAGE_DELETE_TIMEOUT_MS,
    storageFor: resolveProvidersForRun(deps.storage),
    stats: { storageUnavailableFiles: 0 },
  };
  const batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 500);
  const reminders = await sendReminders(deps, run, batchSize);
  const deletion = await deleteExpiredFiles(deps, run, batchSize);
  // The purge is one short transaction; it is skipped, not cut short, after the deadline.
  const purged = run.pastDeadline() ? 0 : await purgeExpiredMetadata(deps, run.now, batchSize);
  return {
    now: run.now,
    stoppedAtDeadline: run.pastDeadline(),
    reminders,
    deletion,
    storageUnavailableFiles: run.stats.storageUnavailableFiles,
    purged,
  };
}

/**
 * Most resolution attempts per provider in one run. Each attempt starts only after a
 * passing deadline check (deleteVideoFiles), so this caps database round trips, not time.
 */
export const MAX_PROVIDER_RESOLUTIONS_PER_RUN = 3;

/** "Not configured" is a fact for the whole run; anything else may be transient. */
function isConfigurationFailure(error: unknown): boolean {
  return error instanceof AppError && error.code === "SERVICE_UNAVAILABLE";
}

/**
 * Resolves storage providers for one run (a WASABI resolution reads the settings row):
 * - a resolved service is reused for the rest of the run. Safe: Wasabi's location cannot
 *   change while it still holds files (storage-admin.ts), and these files are on it;
 * - a configuration failure ("not configured") is remembered for the rest of the run:
 *   one round trip, not one per file;
 * - any other failure (e.g. a transient database error reading the settings) is NOT
 *   remembered: a later file tries again, at most MAX_PROVIDER_RESOLUTIONS_PER_RUN times
 *   per provider, after which the failure is remembered too.
 * Every failed file is a failed attempt of its video, retried by a later run. Exported for
 * tests.
 */
export function resolveProvidersForRun(router: StorageRouter) {
  const settled = new Map<StorageProviderId, Promise<StorageService>>();
  const attempts = new Map<StorageProviderId, number>();
  return async (provider: StorageProviderId): Promise<StorageService> => {
    const known = settled.get(provider);
    if (known !== undefined) return known;
    const attempt = (attempts.get(provider) ?? 0) + 1;
    attempts.set(provider, attempt);
    const pending = router.forProvider(provider);
    try {
      await pending;
      settled.set(provider, pending);
    } catch (error) {
      if (isConfigurationFailure(error) || attempt >= MAX_PROVIDER_RESOLUTIONS_PER_RUN) {
        settled.set(provider, pending);
      }
    }
    return pending;
  };
}

interface RunContext {
  readonly now: Date;
  readonly clock: () => Promise<Date>;
  /** True once the time budget is used up: start no new work. */
  readonly pastDeadline: () => boolean;
  readonly storageTimeoutMs: number;
  /** The storage service for a recorded provider (see resolveProvidersForRun). */
  readonly storageFor: (provider: StorageProviderId) => Promise<StorageService>;
  readonly stats: { storageUnavailableFiles: number };
}

/**
 * Deletes one object, waiting at most `timeoutMs`. "timeout" means the outcome is
 * unknown: the request was aborted where the adapter supports it, but it may already
 * have reached storage, so the file is not tombstoned and a later run deletes it again
 * (idempotent). Errors before the timeout are thrown.
 */
async function deleteObjectWithin(
  storage: StorageService,
  key: string,
  timeoutMs: number,
): Promise<"deleted" | "timeout"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      // Settle first: an adapter may reject synchronously on abort.
      resolve("timeout");
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      storage.delete(key, { signal: controller.signal }).then(() => "deleted" as const),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Deletion ────────────────────────────────────────────────────────────────────────

interface Claimed {
  readonly id: string;
  readonly workspaceId: string;
  readonly attempts: number;
}

/**
 * Marks the next expired, due video DELETING and leases it to this run for
 * DELETION_LEASE_MS from `claimedAt` (the moment of the claim, so a video claimed late in
 * a run keeps its full lease). One video per claim: nothing is claimed that the run
 * might not start before its deadline.
 */
async function claimNextExpired(
  system: PrismaClient,
  now: Date,
  claimedAt: Date,
): Promise<Claimed | null> {
  const leaseSeconds = DELETION_LEASE_MS / 1000;
  const rows = await system.$queryRaw<Claimed[]>`
    UPDATE "generated_videos" AS v
    SET "status" = 'DELETING',
        "deletion_attempts" = v."deletion_attempts" + 1,
        "next_deletion_attempt_at" = ${claimedAt}::timestamptz + make_interval(secs => ${leaseSeconds}),
        "updated_at" = now()
    WHERE v."id" IN (
      SELECT "id" FROM "generated_videos"
      WHERE "status" IN ('AVAILABLE', 'DELETING')
        AND "expires_at" <= ${now}::timestamptz
        AND ("next_deletion_attempt_at" IS NULL OR "next_deletion_attempt_at" <= ${now}::timestamptz)
      ORDER BY "expires_at", "id"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING v."id" AS "id", v."workspace_id" AS "workspaceId", v."deletion_attempts" AS "attempts"`;
  return rows[0] ?? null;
}

type VideoOutcome = "deleted" | "failed" | "interrupted";

/**
 * Undoes this run's claim of a video it had to leave because of the deadline: the
 * attempt is not counted and the lease is cleared (the video was due when claimed).
 * Only while it is still this run's claim (same attempt); otherwise nothing changes.
 */
async function releaseInterruptedClaim(db: GuardedPrismaClient, video: Claimed): Promise<void> {
  await db.generatedVideo.updateMany({
    where: {
      workspaceId: video.workspaceId,
      id: video.id,
      status: "DELETING",
      deletionAttempts: video.attempts,
    },
    data: { deletionAttempts: { decrement: 1 }, nextDeletionAttemptAt: null },
  });
}

async function deleteExpiredFiles(deps: RetentionDeps, run: RunContext, limit: number) {
  const log = deps.logger ?? silentLogger;
  const counts = { claimed: 0, deleted: 0, failed: 0, interrupted: 0 };
  while (counts.claimed < limit && !run.pastDeadline()) {
    const claimedAt = await run.clock();
    // Reading the clock is a database round trip: check again, so that no claim starts
    // after the deadline.
    if (run.pastDeadline()) break;
    const video = await claimNextExpired(deps.system, run.now, claimedAt);
    if (video === null) break;
    counts.claimed += 1;
    counts[await deleteVideoFiles(deps, video, run, log)] += 1;
  }
  return counts;
}

async function deleteVideoFiles(
  deps: RetentionDeps,
  video: Claimed,
  run: RunContext,
  log: RetentionLogger,
): Promise<VideoOutcome> {
  const { db } = deps;
  const scope = { workspaceId: video.workspaceId, videoId: video.id };
  const files = await db.generatedVideoFile.findMany({
    where: { ...scope, deletedAt: null },
    select: { id: true, storageKey: true, storageProvider: true, kind: true, byteSize: true },
  });
  let failedFiles = 0;
  let timedOutFiles = 0;
  let deletedBytes = 0;
  let providerFailures = 0;
  // Out of time: start no new work. Files already deleted stay tombstoned.
  const stopAtDeadline = async (): Promise<"interrupted" | "record_failure"> => {
    // A genuine failure or timeout in this attempt is still recorded as one (below).
    if (failedFiles > 0 || timedOutFiles > 0) return "record_failure";
    // Otherwise the deadline alone stopped it: not a failed attempt. Hand the claim
    // back, so it neither counts toward the repeated-failure alert nor lengthens the
    // backoff, and the next run continues at once. No audit entry.
    await releaseInterruptedClaim(db, video);
    return "interrupted";
  };
  for (const file of files) {
    // Checked BEFORE resolving the provider, which may read the database.
    if (run.pastDeadline()) {
      if ((await stopAtDeadline()) === "interrupted") return "interrupted";
      break;
    }
    // A provider that cannot be resolved (not configured, settings unreadable) is a
    // failed attempt, retried later - never a confirmed deletion, never another provider.
    let target: StorageService;
    try {
      target = await run.storageFor(file.storageProvider);
    } catch (error) {
      failedFiles += 1;
      providerFailures += 1;
      run.stats.storageUnavailableFiles += 1;
      log.warn(
        { video: { id: video.id, fileId: file.id, kind: file.kind }, err: error },
        "Generated video file storage provider is unavailable; it will be retried",
      );
      continue;
    }
    // Checked AGAIN after the (possibly slow) resolution: nothing asynchronous runs
    // between a passing check and the start of the delete.
    if (run.pastDeadline()) {
      if ((await stopAtDeadline()) === "interrupted") return "interrupted";
      break;
    }
    try {
      // Never delete an object outside this video's workspace, whatever the row says.
      assertKeyBelongsToWorkspace(file.storageKey, video.workspaceId);
      const outcome = await deleteObjectWithin(target, file.storageKey, run.storageTimeoutMs);
      if (outcome === "timeout") {
        timedOutFiles += 1;
        log.warn(
          { video: { id: video.id, fileId: file.id, kind: file.kind } },
          "Generated video file deletion timed out (outcome unknown); it will be retried",
        );
        continue;
      }
      // Tombstoned only after storage confirmed the delete, at the time it was confirmed.
      await db.generatedVideoFile.updateMany({
        where: { workspaceId: video.workspaceId, id: file.id, deletedAt: null },
        data: { deletedAt: await run.clock() },
      });
      deletedBytes += file.byteSize;
    } catch (error) {
      failedFiles += 1;
      log.warn(
        { video: { id: video.id, fileId: file.id, kind: file.kind }, err: error },
        "Generated video file deletion failed; it will be retried",
      );
    }
  }

  if (failedFiles === 0 && timedOutFiles === 0) {
    // After every delete was confirmed: files_deleted_at never precedes the deletion.
    const confirmedAt = await run.clock();
    return db.$transaction(async (tx) => {
      const done = await tx.generatedVideo.updateMany({
        where: { workspaceId: video.workspaceId, id: video.id, status: "DELETING" },
        data: {
          status: "DELETED",
          filesDeletedAt: confirmedAt,
          nextDeletionAttemptAt: null,
          lastDeletionError: null,
        },
      });
      // Another run finished it first: nothing to record twice.
      if (done.count === 0) return "deleted";
      await recordAudit(tx, systemScope(video.workspaceId), {
        action: "video.files_deleted",
        entityType: "generated_video",
        entityId: video.id,
        metadata: {
          reason: "retention_expired",
          filesDeleted: files.length,
          bytesDeleted: deletedBytes,
          attempts: video.attempts,
        },
      });
      return "deleted" as const;
    });
  }

  // The backoff starts from this failed attempt, not from the start of the run.
  const failedAt = await run.clock();
  const nextAttemptAt = new Date(failedAt.getTime() + deletionRetryDelayMs(video.attempts));
  await db.$transaction(async (tx) => {
    // Only while the video is still this run's claim (same attempt): if another run has
    // claimed or finished it meanwhile, its state wins and nothing is recorded here.
    const updated = await tx.generatedVideo.updateMany({
      where: {
        workspaceId: video.workspaceId,
        id: video.id,
        status: "DELETING",
        deletionAttempts: video.attempts,
      },
      data: {
        lastDeletionError:
          providerFailures > 0
            ? "storage_provider_unavailable"
            : failedFiles > 0
              ? "storage_delete_failed"
              : "storage_delete_timeout",
        nextDeletionAttemptAt: nextAttemptAt,
      },
    });
    if (updated.count === 0) return;
    await recordAudit(tx, systemScope(video.workspaceId), {
      action: "video.deletion_failed",
      entityType: "generated_video",
      entityId: video.id,
      metadata: {
        attempts: video.attempts,
        failedFiles,
        timedOutFiles,
        nextAttemptAt: nextAttemptAt.toISOString(),
        alert: video.attempts >= DELETION_ALERT_ATTEMPTS,
      },
    });
  });
  return "failed";
}

// ── Reminders ───────────────────────────────────────────────────────────────────────

interface ReminderClaim {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly title: string;
  readonly expiresAt: Date;
  /** For 24 h claims: the 48 h marker before this claim (restored if sending fails). */
  readonly previous48h: Date | null;
}

/**
 * Claims videos whose reminder window is open and not yet handled, by setting the
 * marker to `now`. The 24 h claim also marks a still-unsent 48 h reminder as handled,
 * so someone whose 48 h window was missed (job down) gets one reminder, not two.
 */
async function claimReminders(
  system: PrismaClient,
  hours: ReminderHours,
  now: Date,
  limit: number,
): Promise<ReminderClaim[]> {
  if (hours === 24) {
    return system.$queryRaw<ReminderClaim[]>`
      WITH c AS (
        SELECT "id", "reminder_48h_at" AS "previous48h" FROM "generated_videos"
        WHERE "status" = 'AVAILABLE' AND "reminder_24h_at" IS NULL
          AND "expires_at" > ${now}::timestamptz
          AND "expires_at" - interval '24 hours' <= ${now}::timestamptz
        ORDER BY "expires_at", "id" LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "generated_videos" AS v
      SET "reminder_24h_at" = ${now}::timestamptz,
          "reminder_48h_at" = COALESCE(v."reminder_48h_at", ${now}::timestamptz),
          "updated_at" = now()
      FROM c WHERE v."id" = c."id"
      RETURNING v."id", v."workspace_id" AS "workspaceId", v."user_id" AS "userId", v."title",
                v."expires_at" AS "expiresAt", c."previous48h"`;
  }
  return system.$queryRaw<ReminderClaim[]>`
    WITH c AS (
      SELECT "id" FROM "generated_videos"
      WHERE "status" = 'AVAILABLE' AND "reminder_48h_at" IS NULL
        AND "expires_at" - interval '24 hours' > ${now}::timestamptz
        AND "expires_at" - interval '48 hours' <= ${now}::timestamptz
      ORDER BY "expires_at", "id" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "generated_videos" AS v
    SET "reminder_48h_at" = ${now}::timestamptz, "updated_at" = now()
    FROM c WHERE v."id" = c."id"
    RETURNING v."id", v."workspace_id" AS "workspaceId", v."user_id" AS "userId", v."title",
              v."expires_at" AS "expiresAt", NULL::timestamptz AS "previous48h"`;
}

async function releaseReminder(
  db: GuardedPrismaClient,
  hours: ReminderHours,
  claim: ReminderClaim,
) {
  const where = { workspaceId: claim.workspaceId, id: claim.id };
  await db.generatedVideo.updateMany({
    where,
    data:
      hours === 24
        ? { reminder24hAt: null, reminder48hAt: claim.previous48h }
        : { reminder48hAt: null },
  });
}

async function sendReminders(deps: RetentionDeps, run: RunContext, limit: number) {
  const { now } = run;
  const log = deps.logger ?? silentLogger;
  // Email reminders are opt-in and need a provider. Otherwise nothing is claimed and the
  // in-app notices (videos page, AI Studio banner) are the only warning.
  if (deps.remindersEnabled !== true || deps.mailer.transport === "none") {
    return { supported: false, sent: 0, skipped: 0, failed: 0 };
  }
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  // 24 h first, so a video already inside its last day is not sent a "48 hours" email.
  for (const hours of [24, 48] as const) {
    if (run.pastDeadline()) break;
    const claims = await claimReminders(deps.system, hours, now, limit);
    for (const [index, claim] of claims.entries()) {
      if (run.pastDeadline()) {
        // Out of time: hand the unsent claims back so a later run sends them.
        for (const unsent of claims.slice(index)) await releaseReminder(deps.db, hours, unsent);
        break;
      }
      const outcome = await deliverReminder(deps, hours, claim, now, log);
      if (outcome === "failed") {
        failed += 1;
        await releaseReminder(deps.db, hours, claim);
        continue;
      }
      if (outcome === "no_recipient") skipped += 1;
      else sent += 1;
      await recordAudit(deps.db, systemScope(claim.workspaceId), {
        action: "video.expiry_reminder",
        entityType: "generated_video",
        entityId: claim.id,
        metadata: { hours, outcome, expiresAt: claim.expiresAt.toISOString() },
      });
    }
  }
  return { supported: true, sent, skipped, failed };
}

type ReminderOutcome = "sent" | "logged" | "captured" | "no_recipient" | "failed";

async function deliverReminder(
  deps: RetentionDeps,
  hours: ReminderHours,
  claim: ReminderClaim,
  now: Date,
  log: RetentionLogger,
): Promise<ReminderOutcome> {
  const { db, system } = deps;
  const workspace = await db.workspace.findUnique({
    where: { id: claim.workspaceId },
    select: { name: true, slug: true, timezone: true, deletedAt: true },
  });
  if (workspace?.deletedAt !== null || claim.userId === null) {
    return "no_recipient";
  }
  // The requester must still be a member who may view content: former members, or a
  // role that cannot see the video, get nothing about the workspace.
  const membership = await db.workspaceMember.findFirst({
    where: { workspaceId: claim.workspaceId, userId: claim.userId },
    select: { role: true },
  });
  if (membership === null || !isRole(membership.role) || !can(membership.role, "content.view")) {
    return "no_recipient";
  }
  // SYSTEM PATH: the user row is global; read only the fields the email needs.
  const user = await system.user.findUnique({
    where: { id: claim.userId },
    select: { email: true, locale: true },
  });
  if (user === null) return "no_recipient";

  const locale: Locale = isLocale(user.locale) ? user.locale : "ar";
  const url = new URL(`/${locale}/w/${workspace.slug}/ai/videos`, deps.appUrl).toString();
  try {
    const result = await deps.mailer.send({
      to: user.email,
      locale,
      template: "video_expiry_reminder",
      data: {
        workspaceName: workspace.name,
        videoTitle: claim.title,
        hoursLeft: hours,
        deletionTime: formatDeletionTime(
          claim.expiresAt,
          locale,
          resolveTimeZone(workspace.timezone),
        ),
        url,
      },
    });
    return result.status;
  } catch (error) {
    log.warn(
      { video: { id: claim.id, hours }, at: now.toISOString(), err: error },
      "Video expiry reminder could not be sent; it will be retried while the window is open",
    );
    return "failed";
  }
}

// ── Metadata retention ──────────────────────────────────────────────────────────────

/**
 * Deletes video rows (job and cost metadata, file tombstones) METADATA_RETENTION_DAYS
 * after their files were deleted. Audit log entries are kept under the audit policy.
 */
async function purgeExpiredMetadata(deps: RetentionDeps, now: Date, limit: number) {
  const cutoff = new Date(now.getTime() - METADATA_RETENTION_MS);
  // One transaction: a purged row always has its audit entry, or nothing happens.
  return deps.db.$transaction(async (tx) => {
    const purged = await tx.$queryRaw<{ id: string; workspaceId: string }[]>`
    DELETE FROM "generated_videos"
    WHERE "id" IN (
      SELECT "id" FROM "generated_videos"
      WHERE "status" = 'DELETED' AND "files_deleted_at" <= ${cutoff}::timestamptz
      ORDER BY "files_deleted_at", "id" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "workspace_id" AS "workspaceId"`;
    for (const row of purged) {
      await recordAudit(tx, systemScope(row.workspaceId), {
        action: "video.metadata_purged",
        entityType: "generated_video",
        entityId: row.id,
        metadata: { reason: "metadata_retention_expired" },
      });
    }
    return purged.length;
  });
}

// ── Backlog (observability) ─────────────────────────────────────────────────────────

/**
 * Aggregate health of the retention backlog across all workspaces (counts and one
 * timestamp only — no ids, titles or keys). SYSTEM PATH: aggregate read, no tenant data
 * leaves this function.
 */
export async function measureRetentionBacklog(
  system: PrismaClient,
  now: Date,
): Promise<RetentionBacklog> {
  const graceSeconds = OVERDUE_GRACE_MS / 1000;
  const rows = await system.$queryRaw<{ overdue: number; oldest: Date | null; alerting: number }[]>`
    SELECT
      count(*) FILTER (
        WHERE "status" <> 'DELETED'
          AND "expires_at" <= ${now}::timestamptz - make_interval(secs => ${graceSeconds})
      )::int AS "overdue",
      min("expires_at") FILTER (
        WHERE "status" <> 'DELETED'
          AND "expires_at" <= ${now}::timestamptz - make_interval(secs => ${graceSeconds})
      ) AS "oldest",
      count(*) FILTER (
        WHERE "status" = 'DELETING' AND "deletion_attempts" >= ${DELETION_ALERT_ATTEMPTS}
      )::int AS "alerting"
    FROM "generated_videos"
    WHERE "status" <> 'DELETED'`;
  const row = rows[0];
  return {
    overdue: row?.overdue ?? 0,
    oldestOverdueExpiresAt: row?.oldest ?? null,
    alerting: row?.alerting ?? 0,
  };
}
