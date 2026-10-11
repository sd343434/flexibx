// Retention policy for AI-generated videos. Pure (no `server-only`): shared by the
// retention job, the videos page, the reminder email and unit tests.
//
// - Files are kept for exactly VIDEO_RETENTION_HOURS (168 h = 7 × 24 h) after the
//   database-side success timestamp. The database computes expires_at (trigger in the
//   video_retention migration); this module mirrors the rule for display and tests.
// - The 168 hours are absolute: a daylight-saving change in the viewer's time zone does
//   not shorten or lengthen the period. Only the displayed wall-clock time differs.
// - Job, cost and audit metadata outlive the files (METADATA_RETENTION_DAYS).

const HOUR_MS = 60 * 60 * 1000;

export const VIDEO_RETENTION_HOURS = 168;
export const VIDEO_RETENTION_MS = VIDEO_RETENTION_HOURS * HOUR_MS;

/** Reminder offsets before deletion, in hours. */
export const REMINDER_HOURS = [48, 24] as const;
export type ReminderHours = (typeof REMINDER_HOURS)[number];

/**
 * Video rows (job and cost metadata, file tombstones) are purged this long after their
 * files were deleted (files_deleted_at, database clock). APPROVED: 30 days — see
 * docs/AI_VIDEO_RETENTION_POLICY.md. Audit log entries are not affected.
 */
export const METADATA_RETENTION_DAYS = 30;
export const METADATA_RETENTION_MS = METADATA_RETENTION_DAYS * 24 * HOUR_MS;

/**
 * A claimed deletion is not picked up by another job run for this long, counted from
 * the claim itself (not from the start of the run).
 */
export const DELETION_LEASE_MS = 10 * 60 * 1000;

/**
 * A scheduled run stops starting new work this long after it begins, so it finishes
 * well inside the 10-minute transaction that holds the single-flight lock (the lock is
 * released when that transaction times out, even if work is still running). A
 * conservative starting value, not a measured production requirement.
 */
export const RUN_TIME_BUDGET_MS = 8 * 60 * 1000;

/**
 * Longest wait for one storage delete. After it the request is aborted and the file
 * counts as not confirmed deleted (retried later; deleting again is harmless).
 */
export const STORAGE_DELETE_TIMEOUT_MS = 30 * 1000;

/**
 * The retention run's own database pool (not the application's): each statement is
 * cancelled by PostgreSQL after this long (`statement_timeout`), and waiting for a pooled
 * connection fails after RETENTION_CONNECT_TIMEOUT_MS. A timed-out statement fails like
 * any other error: nothing is recorded as deleted that storage has not confirmed.
 */
export const RETENTION_STATEMENT_TIMEOUT_MS = 3 * 1000;
export const RETENTION_CONNECT_TIMEOUT_MS = 3 * 1000;

/** The single-flight lock's transaction times out (and releases the lock) after this. */
export const RUN_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The most work a run can still do after its time budget runs out, counted from the code
 * paths in retention-job.ts (reviewed, not measured). Every new claim, file delete,
 * reminder batch and purge starts only after a passing deadline check, so the worst case
 * is one check passing just before the deadline, then:
 *   one storage delete (bounded by STORAGE_DELETE_TIMEOUT_MS), then a clock read, the
 *   tombstone, a clock read and the finalizing transaction (UPDATE + audit INSERT, with
 *   BEGIN/COMMIT), then the lock transaction's COMMIT: 8 statements over at most 4 newly
 *   acquired connections.
 * Other paths after the last check (claim + file lookup + release; failure transaction;
 * purge transaction, which Prisma's 5 s interactive-transaction timeout cuts short) are
 * shorter. Storage provider resolution (one settings read for WASABI; a success or a
 * "not configured" result is kept for the run, a transient failure is retried by a later
 * file, at most MAX_PROVIDER_RESOLUTIONS_PER_RUN times per provider) always sits between
 * two deadline checks, so after the last passing check only ONE resolution can run. It
 * adds at most: resolution + release + COMMIT (3 statements), or a failed resolution +
 * clock read + failure transaction + COMMIT (7 statements over 3 connections) - both
 * within the bound below. Not covered: email reminders (no send timeout; disabled by default), a
 * network that stops answering (statement_timeout is enforced by the server), and
 * process pauses.
 */
export const MAX_STATEMENTS_AFTER_DEADLINE = 8;
export const MAX_CONNECTIONS_AFTER_DEADLINE = 4;

/**
 * Statements that run inside the lock's transaction before the time budget starts:
 * Prisma starts the 10-minute timer once BEGIN has completed, then the lock query
 * (pg_try_advisory_xact_lock) runs on that already-held connection, then the budget
 * starts (retention-runtime.ts withRunLock).
 */
export const LOCK_STATEMENTS_BEFORE_BUDGET = 1;

/**
 * A CALCULATED upper bound of the lock transaction's lifetime, valid only under the
 * assumptions above (PostgreSQL enforces statement_timeout, the network answers, the
 * process is not paused, reminders are disabled). Not an enforced or measured limit.
 */
export function worstCaseRunMs(): number {
  return (
    LOCK_STATEMENTS_BEFORE_BUDGET * RETENTION_STATEMENT_TIMEOUT_MS +
    RUN_TIME_BUDGET_MS +
    STORAGE_DELETE_TIMEOUT_MS +
    MAX_STATEMENTS_AFTER_DEADLINE * RETENTION_STATEMENT_TIMEOUT_MS +
    MAX_CONNECTIONS_AFTER_DEADLINE * RETENTION_CONNECT_TIMEOUT_MS
  );
}

/** Retry delays after a failed deletion: 5 min, 10, 20, 40 … capped at 6 h. */
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 6 * HOUR_MS;

/** After this many failed attempts each failure is flagged for operator attention. */
export const DELETION_ALERT_ATTEMPTS = 5;

export function expiresAtFor(succeededAt: Date): Date {
  return new Date(succeededAt.getTime() + VIDEO_RETENTION_MS);
}

/** Expired from the instant expires_at is reached (inclusive). */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

export type ExpiryStage = "available" | "within48h" | "within24h" | "expired";

export function expiryStage(expiresAt: Date, now: Date): ExpiryStage {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return "expired";
  if (left <= 24 * HOUR_MS) return "within24h";
  if (left <= 48 * HOUR_MS) return "within48h";
  return "available";
}

/** Whole hours left before deletion (rounded up, never negative). */
export function hoursRemaining(expiresAt: Date, now: Date): number {
  return Math.max(Math.ceil((expiresAt.getTime() - now.getTime()) / HOUR_MS), 0);
}

/** True while the `hours` reminder window is open: [expires_at − hours, expires_at). */
export function isReminderDue(hours: ReminderHours, expiresAt: Date, now: Date): boolean {
  return (
    now.getTime() >= expiresAt.getTime() - hours * HOUR_MS && now.getTime() < expiresAt.getTime()
  );
}

/** Delay before retrying a deletion that failed on attempt number `attempts` (1-based). */
export function deletionRetryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
}

/**
 * The deletion instant as people read it: date, time and time-zone name in the
 * workspace's IANA zone (the instant itself is the server-side UTC timestamp).
 */
export function formatDeletionTime(expiresAt: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(expiresAt);
}

/** The time-zone label shown next to the deletion time (e.g. "GMT+3"). */
export function timeZoneLabel(at: Date, locale: string, timeZone: string): string {
  const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}
