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

function count(name: string, value: number, threshold: number, level: CheckLevel): OpsCheck {
  return { name, value, threshold, level: value >= threshold ? level : "ok" };
}

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
    ...ledgerChecks(
      ledger,
      now,
      options.ledgerIntegrityIntervalMs ?? DEFAULT_LEDGER_INTEGRITY_INTERVAL_MS,
    ),
  ];
  return { status: overall(checks), checkedAt: now.toISOString(), checks };
}
