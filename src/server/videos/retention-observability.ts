// Observability rules for the video retention job. Pure (no `server-only`) for unit tests.
// Operators alert on the log line `video_retention.run` (level and fields below) or poll
// GET /api/internal/video-retention for the same backlog figures (runbook:
// docs/runbooks/VIDEO_RETENTION_RUNBOOK.md).

import { DELETION_ALERT_ATTEMPTS } from "./retention-policy";

/** Files still stored this long after expiry count as overdue (4 missed 15-minute runs). */
export const OVERDUE_GRACE_MS = 60 * 60 * 1000;
/** Overdue this long means the job is not running or storage keeps failing: page someone. */
export const STALE_OVERDUE_MS = 24 * 60 * 60 * 1000;

export interface RetentionBacklog {
  /** Videos past expires_at + grace whose files are not all deleted. */
  readonly overdue: number;
  /** expires_at of the oldest overdue video, or null. */
  readonly oldestOverdueExpiresAt: Date | null;
  /** Videos whose deletion has failed DELETION_ALERT_ATTEMPTS times or more. */
  readonly alerting: number;
}

export interface RetentionRunFacts {
  readonly deletionFailed: number;
  /** The run used up its time budget and stopped early (partial run). */
  readonly stoppedAtDeadline?: boolean;
  /** Files skipped because their storage provider could not be resolved. */
  readonly storageUnavailableFiles?: number;
  readonly backlog: RetentionBacklog;
  readonly now: Date;
}

export type RetentionSeverity = "info" | "warn" | "error";

/**
 * info: healthy. warn: transient trouble (a failed or timed-out deletion this run, a
 * run cut short by its time budget, or a fresh overdue backlog) that later runs should
 * clear. error: needs a human (repeated failures, or expired files still stored a day
 * after expiry).
 */
export function retentionRunSeverity(facts: RetentionRunFacts): RetentionSeverity {
  const { backlog, now } = facts;
  const oldest = backlog.oldestOverdueExpiresAt;
  if (backlog.alerting > 0) return "error";
  // Storage configuration prevents deletion: needs an operator now, not after retries.
  if ((facts.storageUnavailableFiles ?? 0) > 0) return "error";
  if (oldest !== null && now.getTime() - oldest.getTime() >= STALE_OVERDUE_MS) return "error";
  if (facts.deletionFailed > 0 || facts.stoppedAtDeadline === true || backlog.overdue > 0) {
    return "warn";
  }
  return "info";
}

export { DELETION_ALERT_ATTEMPTS };
