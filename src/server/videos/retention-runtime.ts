import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import { getBoundedRetentionDb, getSystemDb } from "../db/client";
import { getEnv } from "../env";
import { parseVideoRetentionEnv, type VideoRetentionEnv } from "../env-schema";
import type { Logger } from "../logger";
import { getMailer } from "../mail";
import { alert } from "../monitoring/alerts";
import { recordJobFinished } from "../monitoring/heartbeat";
import { createStorageRouter } from "../storage/providers";

import {
  databaseNow,
  measureRetentionBacklog,
  runVideoRetention,
  type RetentionResult,
} from "./retention-job";
import { retentionRunSeverity, type RetentionBacklog } from "./retention-observability";
import {
  RETENTION_CONNECT_TIMEOUT_MS,
  RETENTION_STATEMENT_TIMEOUT_MS,
  RUN_LOCK_TIMEOUT_MS,
  RUN_TIME_BUDGET_MS,
  STORAGE_DELETE_TIMEOUT_MS,
} from "./retention-policy";

// Wiring for the two ways the retention job runs in a deployment: the scheduler-facing
// endpoint (POST /api/internal/video-retention, works in the standalone production image)
// and the `pnpm video:retention` CLI (development, or hosts with the full source tree).

/** Videos handled per phase per run; a 15-minute schedule covers ~19,000 per day. */
export const SCHEDULED_BATCH_SIZE = 200;

/**
 * Cluster-wide single flight: one run at a time across every app instance, so repeated
 * or overlapping scheduler calls (retries, several replicas, a leaked secret) cannot
 * multiply the database and storage load. A transaction-level advisory lock, so it also
 * works behind transaction-mode connection poolers; released when the run ends or the
 * connection drops (crash-safe). The run uses one extra pooled connection while it lasts.
 */
export const RETENTION_LOCK_KEY = 0x7f1d_e0a5; // stable, arbitrary: "video retention"

let cached: VideoRetentionEnv | undefined;

export function getVideoRetentionEnv(): VideoRetentionEnv {
  cached ??= parseVideoRetentionEnv(process.env);
  return cached;
}

export interface RetentionRunSummary {
  /**
   * completed: the run went through every phase. partial: it ran out of its time budget
   * (RUN_TIME_BUDGET_MS) and stopped starting new work; the next run continues.
   * skipped: another run held the lock. storage_unavailable: some files could not be
   * processed because their storage provider is not configured or could not be resolved
   * - NOT a normal completion (an operator must fix the storage configuration; the files
   * are retried, never deleted elsewhere). Takes precedence over partial, so check
   * `stoppedAtDeadline` for whether the run also ran out of time.
   */
  readonly status: "completed" | "partial" | "skipped" | "storage_unavailable";
  readonly reason?: "already_running" | "deadline" | "storage_provider_unavailable";
  /**
   * Set whenever the run took the lock: true when it used up its time budget and stopped
   * starting new work - including runs reported as storage_unavailable.
   */
  readonly stoppedAtDeadline?: boolean;
  readonly now: string;
  readonly reminders?: RetentionResult["reminders"];
  readonly deletion?: RetentionResult["deletion"];
  readonly storageUnavailableFiles?: number;
  readonly purged?: number;
  readonly backlog: {
    readonly overdue: number;
    readonly oldestOverdueExpiresAt: string | null;
    readonly alerting: number;
  };
}

function backlogJson(backlog: RetentionBacklog): RetentionRunSummary["backlog"] {
  return {
    overdue: backlog.overdue,
    oldestOverdueExpiresAt: backlog.oldestOverdueExpiresAt?.toISOString() ?? null,
    alerting: backlog.alerting,
  };
}

/**
 * The run's summary (endpoint body, CLI and the `video_retention.run` log line). `result`
 * is null when another run held the lock. Pure; exported for tests.
 */
export function summarizeRetentionRun(
  result: RetentionResult | null,
  now: Date,
  backlog: RetentionBacklog,
): RetentionRunSummary {
  if (result === null) {
    return {
      status: "skipped",
      reason: "already_running",
      now: now.toISOString(),
      backlog: backlogJson(backlog),
    };
  }
  const outcome =
    result.storageUnavailableFiles > 0
      ? { status: "storage_unavailable" as const, reason: "storage_provider_unavailable" as const }
      : result.stoppedAtDeadline
        ? { status: "partial" as const, reason: "deadline" as const }
        : { status: "completed" as const };
  return {
    ...outcome,
    stoppedAtDeadline: result.stoppedAtDeadline,
    now: now.toISOString(),
    reminders: result.reminders,
    deletion: result.deletion,
    storageUnavailableFiles: result.storageUnavailableFiles,
    purged: result.purged,
    backlog: backlogJson(backlog),
  };
}

/** Current backlog without running anything (monitoring probes). */
export async function getVideoRetentionStatus(): Promise<
  Pick<RetentionRunSummary, "now" | "backlog">
> {
  const system = getSystemDb();
  const now = await databaseNow(system);
  return {
    now: now.toISOString(),
    backlog: backlogJson(await measureRetentionBacklog(system, now)),
  };
}

/**
 * The run's database clients: a separate small pool whose statements and connection waits
 * are bounded, so the work left after the time budget fits inside the lock's transaction
 * timeout (RUN_LOCK_TIMEOUT_MS; Prisma then rolls it back, which releases the lock, but
 * does not stop the run's own work). See worstCaseRunMs() in retention-policy.ts.
 */
function retentionDb() {
  return getBoundedRetentionDb({
    statementTimeoutMs: RETENTION_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: RETENTION_CONNECT_TIMEOUT_MS,
  });
}

async function withRunLock<T>(
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  // The interactive transaction pins one pooled connection and holds a transaction-level
  // advisory lock on it while the run works through other connections; the lock is
  // released on commit/rollback or when the connection drops (crash-safe).
  return retentionDb().system.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}::bigint) AS "ok"`;
      if (rows[0]?.ok !== true) return { ran: false as const };
      return { ran: true as const, value: await fn() };
    },
    { maxWait: 10_000, timeout: RUN_LOCK_TIMEOUT_MS },
  );
}

/** Heartbeat and alert for a retention run; monitoring never fails the run. */
async function recordRetentionHeartbeat(
  system: PrismaClient,
  failed: boolean,
  now: Date,
  log: Logger,
): Promise<void> {
  try {
    await recordJobFinished(system, "video-retention", failed ? ["deletion"] : [], now);
  } catch (error) {
    log.warn(
      { event: "monitoring.failed", error: error instanceof Error ? error.name : "unknown" },
      "Retention heartbeat not recorded",
    );
  }
  if (failed) {
    await alert({
      key: "video_retention_failed",
      severity: "critical",
      title: "Video retention run reported deletion failures",
    });
  }
}

/**
 * One scheduled run (single flight), logged as `video_retention.run` at a graded level.
 * The run stops starting new work after RUN_TIME_BUDGET_MS, well before the lock's
 * transaction times out (`timeBudgetMs` overrides it in tests only).
 */
export async function runScheduledVideoRetention(
  logger: Logger,
  options: { readonly timeBudgetMs?: number } = {},
): Promise<RetentionRunSummary> {
  const env = getVideoRetentionEnv();
  const { system, db } = retentionDb();
  const outcome = await withRunLock(() =>
    runVideoRetention(
      {
        system,
        db,
        // Each file is deleted from its recorded provider; settings read on the bounded pool.
        storage: createStorageRouter({ system }),
        mailer: getMailer(),
        appUrl: getEnv().APP_URL,
        remindersEnabled: env.VIDEO_EXPIRY_EMAILS === "enabled",
        logger,
      },
      {
        batchSize: SCHEDULED_BATCH_SIZE,
        timeBudgetMs: options.timeBudgetMs ?? RUN_TIME_BUDGET_MS,
        storageTimeoutMs: STORAGE_DELETE_TIMEOUT_MS,
      },
    ),
  );
  const now = outcome.ran ? outcome.value.now : await databaseNow(system);
  const backlog = await measureRetentionBacklog(system, now);
  const summary = summarizeRetentionRun(outcome.ran ? outcome.value : null, now, backlog);
  const severity = retentionRunSeverity({
    deletionFailed: outcome.ran ? outcome.value.deletion.failed : 0,
    stoppedAtDeadline: outcome.ran && outcome.value.stoppedAtDeadline,
    storageUnavailableFiles: outcome.ran ? outcome.value.storageUnavailableFiles : 0,
    backlog,
    now,
  });
  logger[severity]({ videoRetention: summary, severity }, "video_retention.run");
  await recordRetentionHeartbeat(system, severity === "error", now, logger);
  return summary;
}
