import type { PrismaClient } from "@/generated/prisma/client";

import { STALE_HOLD_MS } from "../billing/credits";
import { STUCK_PUBLISH_MS } from "../social/publishing";
import { STUCK_SEND_MS } from "../social/social-runtime";

import { LEDGER_INTEGRITY_CHECK } from "./ledger-integrity";

// Operational status: counts that tell an operator (or an uptime monitor polling
// GET /api/internal/ops-status) whether the background machinery is healthy. Pure (no
// `server-only`); integration-tested on the real database.
//
// SYSTEM PATH (reviewed): cross-workspace COUNTS only (grouped by status or feature). No
// row content, no workspace ids, no customer data leaves this module.

export type CheckLevel = "ok" | "warning" | "critical";

export interface OpsCheck {
  readonly name: string;
  readonly level: CheckLevel;
  /** A count, or an age in seconds for heartbeat checks (null = never ran). */
  readonly value: number | null;
  /** Value at which the check stops being ok. */
  readonly threshold: number;
}

export interface OpsStatus {
  readonly status: CheckLevel;
  readonly checkedAt: string;
  readonly checks: readonly OpsCheck[];
}

/** The tick runs every 1–5 minutes; 15 minutes without a successful one is an outage. */
export const TICK_STALE_SECONDS = 15 * 60;
/** Holds the tick should have released (it releases after STALE_HOLD_MS). */
export const STUCK_HOLD_MS = 2 * STALE_HOLD_MS;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** AI failures per hour that suggest a provider problem. */
export const AI_FAILURES_WARNING = 5;
/** Failed sends/publishes per day worth a look. */
export const FAILED_SENDS_WARNING = 10;
/**
 * A tick started this long ago and not finished: hung (its single-flight lock expires
 * after 9 minutes, then ticks may overlap).
 */
export const TICK_RUNNING_WARNING_SECONDS = 10 * 60;
/** The video-retention job is scheduled daily; two days without a success is missed work. */
export const RETENTION_STALE_SECONDS = 48 * 3600;
/** A lease this far past its end was not taken over by recovery: the work is stuck. */
export const LEASE_OVERDUE_MS = 15 * 60_000;
/** A video job this far past its wall-time deadline should have been closed by the tick. */
export const VIDEO_OVERDUE_MS = HOUR_MS;
/** Failed or partly read Meta Insights runs per day worth a look. */
export const INSIGHTS_RUNS_WARNING = 3;
/** Consecutive failed runs after which a source needs a person (reconnect, permissions). */
export const INSIGHTS_SOURCE_FAILURES_WARNING = 3;
/** Failed video attempts per day that suggest a provider problem. */
export const VIDEO_FAILURES_WARNING = 5;

function count(name: string, value: number, threshold: number, level: CheckLevel): OpsCheck {
  return { name, value, threshold, level: value >= threshold ? level : "ok" };
}

const ageSeconds = (now: Date, at: Date | null | undefined): number | null =>
  at === null || at === undefined
    ? null
    : Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));

function overall(checks: readonly OpsCheck[]): CheckLevel {
  if (checks.some((check) => check.level === "critical")) return "critical";
  if (checks.some((check) => check.level === "warning")) return "warning";
  return "ok";
}

/** Default cadence of the ledger integrity check (LEDGER_INTEGRITY_INTERVAL_MINUTES). */
export const DEFAULT_LEDGER_INTEGRITY_INTERVAL_MS = 60 * 60_000;
const LEDGER_COUNTS = ["balance_without_ledger", "balance_mismatch", "held_mismatch"] as const;

/**
 * Ledger integrity checks from the last stored run (ledger-integrity.ts; never computed
 * here): violation counts of the last completed run (critical), a failed last run
 * (critical: the ledger state is unknown) and the age of the last completed run (warning
 * when it never ran or is older than two intervals plus the tick's own staleness).
 */
function ledgerChecks(
  row: { status: string; counts: unknown; completedAt: Date | null } | null,
  now: Date,
  intervalMs: number,
): OpsCheck[] {
  const counts = (row?.counts ?? {}) as Record<string, unknown>;
  const maxAgeSeconds = Math.round((2 * intervalMs) / 1000) + TICK_STALE_SECONDS;
  const completed = row?.completedAt ?? null;
  const age =
    completed === null
      ? null
      : Math.max(0, Math.round((now.getTime() - completed.getTime()) / 1000));
  return [
    ...LEDGER_COUNTS.map((name) => {
      const value = typeof counts[name] === "number" ? counts[name] : 0;
      return count(`credit_ledger_${name}`, value, 1, "critical");
    }),
    {
      name: "credit_ledger_integrity_check_failed",
      value: row?.status === "error" ? 1 : 0,
      threshold: 1,
      level: row?.status === "error" ? "critical" : "ok",
    },
    {
      name: "credit_ledger_integrity_age_seconds",
      value: age,
      threshold: maxAgeSeconds,
      level: age === null || age >= maxAgeSeconds ? "warning" : "ok",
    },
  ];
}

/** A tick that started and has not finished for longer than a tick can take: hung. */
function runningCheck(
  tick: { lastStartedAt: Date | null; lastFinishedAt: Date | null } | null,
  now: Date,
): OpsCheck {
  const started = tick?.lastStartedAt ?? null;
  const finished = tick?.lastFinishedAt ?? null;
  const running = started !== null && (finished === null || finished < started);
  const value = running ? ageSeconds(now, started) : 0;
  return {
    name: "automation_tick_running_seconds",
    value,
    threshold: TICK_RUNNING_WARNING_SECONDS,
    level: (value ?? 0) >= TICK_RUNNING_WARNING_SECONDS ? "warning" : "ok",
  };
}

export async function collectOpsStatus(
  system: PrismaClient,
  now: Date,
  options: { readonly ledgerIntegrityIntervalMs?: number } = {},
): Promise<OpsStatus> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const [
    tick,
    stuckHolds,
    repliesSending,
    repliesUncertain,
    repliesFailed,
    postsPublishing,
    postsUncertain,
    postsFailed,
    whatsappSending,
    whatsappUncertain,
    aiFailures,
    ledger,
    retention,
    videoOverdue,
    videoReconciliation,
    videoAttemptsFailed,
    agentTasksStuck,
    insightsLeasesStuck,
    insightsRunsFailed,
    insightsRunsPartial,
    insightsSourcesFailing,
  ] = await Promise.all([
    system.systemHeartbeat.findUnique({ where: { name: "automation-tick" } }),
    system.creditHold.count({ where: { status: "HELD", createdAt: { lt: ago(STUCK_HOLD_MS) } } }),
    system.socialReply.count({
      where: { sendStatus: "SENDING", updatedAt: { lt: ago(2 * STUCK_SEND_MS) } },
    }),
    system.socialReply.count({ where: { sendStatus: "UNCERTAIN" } }),
    system.socialReply.count({
      where: {
        sendStatus: "FAILED",
        updatedAt: { gte: ago(DAY_MS) },
        // Expected outcomes, not delivery failures.
        NOT: { sendError: { in: ["superseded", "stale"] } },
      },
    }),
    system.socialPost.count({
      where: { status: "PUBLISHING", updatedAt: { lt: ago(2 * STUCK_PUBLISH_MS) } },
    }),
    system.socialPost.count({ where: { status: "UNCERTAIN" } }),
    system.socialPost.count({ where: { status: "FAILED", updatedAt: { gte: ago(DAY_MS) } } }),
    system.whatsAppMessage.count({
      where: { status: "SENDING", updatedAt: { lt: ago(HOUR_MS) } },
    }),
    system.whatsAppMessage.count({ where: { status: "UNCERTAIN" } }),
    system.aiGeneration.count({ where: { status: "FAILED", createdAt: { gte: ago(HOUR_MS) } } }),
    system.opsCheckResult.findUnique({
      where: { name: LEDGER_INTEGRITY_CHECK },
      select: { status: true, counts: true, completedAt: true },
    }),
    system.systemHeartbeat.findUnique({ where: { name: "video-retention" } }),
    // Still active long after their wall-time deadline: no runner is closing them.
    system.videoGenerationJob.count({
      where: {
        state: { in: ["RESERVED", "IN_PROGRESS"] },
        deadlineAt: { lt: ago(VIDEO_OVERDUE_MS) },
      },
    }),
    system.videoGenerationJob.count({ where: { state: "NEEDS_RECONCILIATION" } }),
    system.videoGenerationAttempt.count({
      where: {
        state: { in: ["FAILED_RETRYABLE", "FAILED_PERMANENT", "TIMED_OUT"] },
        updatedAt: { gte: ago(DAY_MS) },
      },
    }),
    // Recovery hands an expired lease back within one tick; this far past it, it did not.
    system.agentTask.count({
      where: { state: "RUNNING", leaseExpiresAt: { lt: ago(LEASE_OVERDUE_MS) } },
    }),
    system.insightsSource.count({
      where: { leaseRunId: { not: null }, leaseUntil: { lt: ago(LEASE_OVERDUE_MS) } },
    }),
    system.insightsSyncRun.count({
      where: { status: { in: ["FAILED", "ABANDONED"] }, startedAt: { gte: ago(DAY_MS) } },
    }),
    system.insightsSyncRun.count({ where: { status: "PARTIAL", startedAt: { gte: ago(DAY_MS) } } }),
    system.insightsSource.count({
      where: { enabled: true, failureCount: { gte: INSIGHTS_SOURCE_FAILURES_WARNING } },
    }),
  ]);

  const succeededAt = tick?.lastSucceededAt ?? null;
  const tickAge =
    succeededAt === null
      ? null
      : Math.max(0, Math.round((now.getTime() - succeededAt.getTime()) / 1000));
  const checks: OpsCheck[] = [
    {
      name: "automation_tick_last_success_age_seconds",
      value: tickAge,
      threshold: TICK_STALE_SECONDS,
      level: tickAge === null || tickAge >= TICK_STALE_SECONDS ? "critical" : "ok",
    },
    {
      name: "automation_tick_last_run_failed",
      value: tick?.lastStatus === "failed" ? 1 : 0,
      threshold: 1,
      level: tick?.lastStatus === "failed" ? "critical" : "ok",
    },
    {
      // Stopped at its time budget with work left over (the next tick goes on).
      name: "automation_tick_last_run_partial",
      value: tick?.lastStatus === "partial" ? 1 : 0,
      threshold: 1,
      level: tick?.lastStatus === "partial" ? "warning" : "ok",
    },
    runningCheck(tick, now),
    {
      name: "video_retention_last_success_age_seconds",
      value: ageSeconds(now, retention?.lastSucceededAt),
      threshold: RETENTION_STALE_SECONDS,
      level:
        (ageSeconds(now, retention?.lastSucceededAt) ?? Infinity) >= RETENTION_STALE_SECONDS
          ? "warning"
          : "ok",
    },
    count("credit_holds_stuck", stuckHolds, 1, "critical"),
    count("social_replies_sending_stuck", repliesSending, 1, "critical"),
    count("social_posts_publishing_stuck", postsPublishing, 1, "critical"),
    count("whatsapp_messages_sending_stuck", whatsappSending, 1, "critical"),
    count("social_replies_uncertain", repliesUncertain, 1, "warning"),
    count("social_posts_uncertain", postsUncertain, 1, "warning"),
    count("whatsapp_messages_uncertain", whatsappUncertain, 1, "warning"),
    count("social_replies_failed_24h", repliesFailed, FAILED_SENDS_WARNING, "warning"),
    count("social_posts_failed_24h", postsFailed, FAILED_SENDS_WARNING, "warning"),
    count("ai_generations_failed_1h", aiFailures, AI_FAILURES_WARNING, "warning"),
    count("video_jobs_overdue", videoOverdue, 1, "critical"),
    count("agent_tasks_lease_expired", agentTasksStuck, 1, "critical"),
    count("insights_sources_lease_expired", insightsLeasesStuck, 1, "warning"),
    count("video_jobs_needs_reconciliation", videoReconciliation, 1, "warning"),
    count("video_attempts_failed_24h", videoAttemptsFailed, VIDEO_FAILURES_WARNING, "warning"),
    count("insights_sync_runs_failed_24h", insightsRunsFailed, INSIGHTS_RUNS_WARNING, "warning"),
    count("insights_sync_runs_partial_24h", insightsRunsPartial, INSIGHTS_RUNS_WARNING, "warning"),
    count("insights_sources_failing", insightsSourcesFailing, 1, "warning"),
    ...ledgerChecks(
      ledger,
      now,
      options.ledgerIntegrityIntervalMs ?? DEFAULT_LEDGER_INTEGRITY_INTERVAL_MS,
    ),
  ];
  return { status: overall(checks), checkedAt: now.toISOString(), checks };
}
