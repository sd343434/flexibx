import "server-only";

import type { AiRuntime } from "../ai/ai-service";
import { providerFromEnv } from "../ai/configured-provider";
import { creditsSettingsFromEnv } from "../billing/config";
import { releaseStaleHolds } from "../billing/credits";
import { getDb, getSystemDb, getTickLockDb } from "../db/client";
import { getAiEnv, getVideoEnv } from "../env";
import { logger } from "../logger";
import { recordAlertDelivery } from "../monitoring/alert-delivery";
import type { Alert } from "../monitoring/alert-sink";
import { alert } from "../monitoring/alerts";
import { recordJobFinished, recordJobStarted } from "../monitoring/heartbeat";
import { runLedgerIntegrityCheck } from "../monitoring/ledger-integrity";
import { collectOpsStatus } from "../monitoring/ops-status";
import { ledgerIntegrityIntervalMs } from "../monitoring/ops-status-service";

import type { AdAdapters } from "../ads/adapter";
import {
  adsExecutionEnabled,
  adTokenKey,
  getAdAdapters,
  getWhatsAppAdapter,
  whatsappSendingEnabled,
} from "../ads/registry";
import { readMedia } from "../marketing/media-service";
import { getStorageRouter } from "../storage/providers";

import type { OrchestrationDeps } from "./engine";
import { automationTick } from "./scheduler";
import { adActivateWorkflow } from "./workflows/ad-activate";
import { adLaunchWorkflow } from "./workflows/ad-launch";
import {
  contentPlanningWorkflow,
  CONTENT_PLANNING_WORKFLOW,
  type PlanningServices,
} from "./workflows/content-planning";
import { whatsappSendWorkflow, type WhatsAppSendServices } from "./workflows/whatsapp-send";

// The application's orchestration dependencies: the workflows that exist and the
// services their tasks use. The AI provider comes from AI_PROVIDER (disabled by default;
// `fake` is the deterministic local adapter; `openai` calls OpenAI's Responses API).

/** Services every workflow may use (each workflow declares the part it needs). */
export type AppServices = PlanningServices & WhatsAppSendServices;

export const WORKFLOWS = {
  [CONTENT_PLANNING_WORKFLOW]: contentPlanningWorkflow,
  [adLaunchWorkflow.id]: adLaunchWorkflow,
  [adActivateWorkflow.id]: adActivateWorkflow,
  [whatsappSendWorkflow.id]: whatsappSendWorkflow,
} as const;

export function getAiRuntimeForAutomation(): AiRuntime {
  const env = getAiEnv();
  return {
    provider: providerFromEnv(env),
    timeoutMs: env.AI_TIMEOUT_MS,
  };
}

export function getOrchestrationDeps(): OrchestrationDeps<AppServices> & {
  readonly adapters: AdAdapters;
  readonly executionEnabled: boolean;
  readonly tokenKey: string | null;
} {
  return {
    db: getDb(),
    // Resolved on use, so a misconfigured advertising platform never breaks automation.
    get adapters() {
      return getAdAdapters();
    },
    get executionEnabled() {
      return adsExecutionEnabled();
    },
    get tokenKey() {
      return adTokenKey();
    },
    services: {
      ai: getAiRuntimeForAutomation,
      ads: getAdAdapters,
      tokenKey: adTokenKey,
      executionEnabled: adsExecutionEnabled,
      whatsapp: getWhatsAppAdapter,
      whatsappSendingEnabled,
      readMedia: async (ctx, assetId) => {
        try {
          const file = await readMedia(getDb(), getStorageRouter(), ctx, assetId);
          return { body: file.body, contentType: file.contentType, filename: file.filename };
        } catch {
          return null;
        }
      },
    },
    workflows: WORKFLOWS,
    logger,
  };
}

/** Counts only (no ids): what one scheduled tick did. */
export interface ScheduledTickSummary {
  readonly recovered: number;
  readonly scheduled: number;
  readonly skippedNoDelegate: number;
  readonly advanced: number;
  /** Advanced runs by outcome: a final state (lower case) or paused/waiting/yielded. */
  readonly runs: Readonly<Record<string, number>>;
  /** AI Social Manager: drafts made, replies sent, sends marked uncertain, self-reviews. */
  readonly social: {
    readonly published: number;
    readonly drafted: number;
    readonly sent: number;
    readonly uncertain: number;
    readonly reviewed: number;
  };
  /** Credit holds never settled (abandoned AI calls) released on this tick. */
  readonly creditHoldsReleased: number;
  /** Video jobs whose runner stopped, resumed on this tick (0 when video is not configured). */
  readonly videoJobsResumed: number;
  /** Meta Insights sources read on this tick, and how many of those runs failed. */
  readonly insightsSyncs: { readonly started: number; readonly failed: number };
  /** Phases that failed on this tick (logged); the others still ran. */
  readonly failedPhases: readonly string[];
  /**
   * completed: every phase ran to its end. partial: the tick ran out of its time budget
   * (TICK_TIME_BUDGET_MS): it stopped `cutShortPhases` before their last item and did not
   * start `skippedPhases` (the next tick runs what is left).
   * skipped: another tick held the single-flight lock; nothing ran.
   */
  readonly status: "completed" | "partial" | "skipped";
  /** Phases not started because the time budget had run out (partial only). */
  readonly skippedPhases: readonly string[];
  /**
   * Phases that stopped before their last item because the time budget ran out while
   * they were running (partial only; the remaining items run on the next tick).
   */
  readonly cutShortPhases: readonly string[];
}

const EMPTY_SOCIAL = { published: 0, drafted: 0, sent: 0, uncertain: 0, reviewed: 0 } as const;

/**
 * True once the tick's time budget has run out. Phases check it before each item and stop
 * there (the item in progress finishes); what is left runs on the next tick.
 */
export type ShouldStop = () => boolean;

/** The work of one tick, phase by phase (injectable so a failing phase can be tested). */
export interface TickPhases {
  orchestration(shouldStop?: ShouldStop): Promise<{
    readonly recovered: number;
    readonly scheduled: number;
    readonly skippedNoDelegate: number;
    readonly executed: readonly { readonly status: string; readonly state?: string }[];
  }>;
  /** `failedPhases`: social sub-phases that failed as a whole (reported as `social.<name>`). */
  social(
    now: Date,
    shouldStop?: ShouldStop,
  ): Promise<ScheduledTickSummary["social"] & { readonly failedPhases?: readonly string[] }>;
  credits(now: Date): Promise<number>;
  video(shouldStop?: ShouldStop): Promise<number>;
  /** Due Meta Insights sources (absent: nothing to read on this tick). */
  insights?(
    shouldStop?: ShouldStop,
  ): Promise<{ readonly started: number; readonly failed: number }>;
  /**
   * Card checkouts left open (webhook lost): their status is looked up at the provider and
   * applied exactly like the webhook would (absent or not configured: nothing to do).
   */
  payments?(now: Date): Promise<{ readonly checked: number; readonly credited: number }>;
}

/**
 * Status polls of one video job within a tick (one run per job stays well under a minute
 * with the default 10 s interval, and far under the job's lease, which is renewed on each
 * poll anyway); a job still rendering is resumed on the next tick.
 */
export const TICK_VIDEO_MAX_POLLS = 5;

export const DEFAULT_TICK_PHASES: TickPhases = {
  orchestration: (shouldStop) =>
    automationTick(
      { ...getOrchestrationDeps(), system: getSystemDb() },
      shouldStop === undefined ? {} : { shouldStop },
    ),
  // The AI Social Manager's own sweep (publishing, drafts, unsent replies, stuck sends,
  // self-review).
  social: async (now, shouldStop) => {
    const { getSocialDeps, socialSweep } = await import("../social/social-runtime");
    return socialSweep(getSocialDeps(), getSystemDb(), now, undefined, shouldStop);
  },
  credits: (now) =>
    releaseStaleHolds(getSystemDb(), getDb(), now, creditsSettingsFromEnv(), 50, logger),
  // Video jobs whose runner stopped: resumed with the configured provider only (never
  // started when VIDEO_PROVIDER is disabled — nothing can be in flight then).
  video: async (shouldStop) => {
    if (getVideoEnv().VIDEO_PROVIDER === "disabled") return 0;
    const { getVideoGenerationDeps } = await import("../videos/generation/runtime");
    const { recoverVideoJobs } = await import("../videos/generation/video-generation-service");
    const deps = { ...getVideoGenerationDeps(), system: getSystemDb() };
    return (
      await recoverVideoJobs(
        {
          ...deps,
          maxPolls: Math.min(deps.maxPolls ?? TICK_VIDEO_MAX_POLLS, TICK_VIDEO_MAX_POLLS),
        },
        shouldStop === undefined ? {} : { shouldStop },
      )
    ).resumed;
  },
  // Meta Insights: due sources of workspaces with a usable Meta grant (nothing when
  // META_INSIGHTS_ENABLED is off — the client does not exist then).
  insights: async (shouldStop) => {
    const { getInsightsDeps } = await import("../intelligence/insights-runtime");
    const { runDueInsightsSyncs } = await import("../intelligence/insights-sync");
    return runDueInsightsSyncs(
      getInsightsDeps(),
      getSystemDb(),
      shouldStop === undefined ? {} : { shouldStop },
    );
  },
  // Stripe test-mode checkouts whose webhook never arrived (STRIPE_SANDBOX.md): nothing
  // when card payments are not configured; an invalid configuration fails the phase.
  payments: async (now) => {
    const { getCheckoutProvider } = await import("../billing/checkout-runtime");
    const provider = getCheckoutProvider();
    if (provider === null) return { checked: 0, credited: 0 };
    const { reconcileOpenCheckouts } = await import("../billing/checkout-service");
    return reconcileOpenCheckouts(getDb(), provider, creditsSettingsFromEnv(), now);
  },
};

/** Monitoring work around the tick: logged on failure, never fails the tick. */
async function bestEffort(name: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    logger.warn(
      {
        event: "monitoring.failed",
        step: name,
        error: error instanceof Error ? error.name : "unknown",
      },
      "Monitoring step failed",
    );
  }
}

/**
 * After every tick: the credit-ledger integrity check when it is due (once per
 * LEDGER_INTEGRITY_INTERVAL_MINUTES across all processes; read-only, bounded), the
 * heartbeat (GET /api/internal/ops-status reads it), an alert for failed phases, and
 * alerts for every non-ok operational check — stuck states the tick could not clear
 * (credit holds, sends, publishes) and ledger inconsistencies. Alerts are throttled per
 * key (alert-sink.ts).
 */
async function reportTick(
  failedPhases: readonly string[],
  skippedPhases: readonly string[],
  cutShortPhases: readonly string[],
  at: Date,
): Promise<void> {
  const intervalMs = ledgerIntegrityIntervalMs();
  await bestEffort("ledger_integrity", () =>
    runLedgerIntegrityCheck(getSystemDb(), at, { intervalMs }),
  );
  await bestEffort("heartbeat_finish", () =>
    recordJobFinished(getSystemDb(), "automation-tick", failedPhases, at, {
      partial: skippedPhases.length > 0 || cutShortPhases.length > 0,
    }),
  );
  const alerts: Alert[] = [];
  if (skippedPhases.length > 0 || cutShortPhases.length > 0) {
    alerts.push({
      key: "automation_tick_over_budget",
      severity: "warning",
      title: "Scheduled tick ran out of its time budget",
      details: { skippedPhases: [...skippedPhases], cutShortPhases: [...cutShortPhases] },
    });
  }
  if (failedPhases.length > 0) {
    alerts.push({
      key: "automation_tick_phase_failed",
      severity: "critical",
      title: "Scheduled tick phase failed",
      details: { failedPhases: [...failedPhases] },
    });
  }
  await bestEffort("ops_status", async () => {
    const status = await collectOpsStatus(getSystemDb(), at, {
      ledgerIntegrityIntervalMs: intervalMs,
    });
    for (const check of status.checks) {
      // The tick's own heartbeat checks are for external monitors (this tick is running).
      if (check.level === "ok" || check.name.startsWith("automation_tick_")) continue;
      alerts.push({
        key: `ops:${check.name}`,
        severity: check.level,
        title: `Operational check: ${check.name}`,
        details: { value: check.value, threshold: check.threshold },
      });
    }
  });
  // In parallel: a slow or unreachable webhook delays the tick by one delivery timeout
  // at most, whatever the number of alerts.
  const outcomes = await Promise.all(alerts.map((entry) => alert(entry)));
  // A destination that refuses alerts is reported by ops-status (alert_delivery_failed).
  await bestEffort("alert_delivery", () => recordAlertDelivery(getSystemDb(), outcomes, at));
}

/**
 * One scheduler tick: the single entry point for POST /api/internal/automation-tick and
 * `pnpm automation:tick`. Single flight across every instance (tickLock): a tick that
 * finds another running returns `status: "skipped"` with an overlap alert. Each phase runs
 * on its own — a phase that fails as a whole is logged and reported in `failedPhases`, and
 * the following phases still run (each phase also isolates its own items). No phase is
 * started after the time budget; those are reported in `skippedPhases` (alerted) and run
 * on the next tick.
 */
export async function runScheduledAutomationTick(
  now: () => Date = () => new Date(),
  phases: TickPhases = DEFAULT_TICK_PHASES,
  options: TickOptions = {},
): Promise<ScheduledTickSummary> {
  const lock = options.lock ?? withTickLock;
  const outcome = await lock(() => runTickPhases(now, phases, options));
  if (outcome.ran) {
    if (outcome.lockLost === true) {
      // The work went on past the lock's transaction timeout: another tick could have
      // started meanwhile (harmless: items are claimed by lease / compare-and-set).
      logger.warn({ event: "automation_tick.lock_expired" }, "Tick outlived its lock");
      await alert({
        key: "automation_tick_lock_expired",
        severity: "warning",
        title: "Scheduled tick ran past its single-flight lock",
      });
    }
    return outcome.value;
  }
  logger.warn({ event: "automation_tick.overlap" }, "Scheduled tick skipped: another is running");
  await alert({
    key: "automation_tick_overlap",
    severity: "warning",
    title: "Scheduled tick skipped: the previous one was still running",
  });
  return {
    recovered: 0,
    scheduled: 0,
    skippedNoDelegate: 0,
    advanced: 0,
    runs: {},
    social: EMPTY_SOCIAL,
    creditHoldsReleased: 0,
    videoJobsResumed: 0,
    insightsSyncs: { started: 0, failed: 0 },
    failedPhases: [],
    status: "skipped",
    skippedPhases: [],
    cutShortPhases: [],
  };
}

/**
 * A tick stops this long after it began: no phase is started after it, and a running
 * phase stops before its next item (the item in progress finishes — each one is bounded
 * by leases, per-step timeouts and, for video, TICK_VIDEO_MAX_POLLS). Shorter than the
 * 5-minute schedule, so a slow tick normally finishes before the next slot; what is left
 * runs on the next tick.
 */
export const TICK_TIME_BUDGET_MS = 4 * 60 * 1000;

/**
 * The single-flight lock's transaction times out (and releases the lock) after this, even
 * if the tick is still running, so a hung tick cannot block the scheduler for long.
 */
export const TICK_LOCK_TIMEOUT_MS = 9 * 60 * 1000;

/** Advisory lock key of the scheduler tick (stable, arbitrary; distinct from retention's). */
export const TICK_LOCK_KEY = 0x5e7a_71c4;

export type TickLock = <T>(
  work: () => Promise<T>,
) => Promise<{ ran: true; value: T; lockLost?: boolean } | { ran: false }>;

export interface TickOptions {
  /** Time budget for starting phases (default TICK_TIME_BUDGET_MS). */
  readonly timeBudgetMs?: number;
  /** Milliseconds since an arbitrary origin (default performance.now()). Tests only. */
  readonly elapsedClock?: () => number;
  /** The single-flight lock (default: the database advisory lock). Tests only. */
  readonly lock?: TickLock;
}

/**
 * Cluster-wide single flight, the same pattern as the video retention run: a
 * transaction-level advisory lock held in an interactive transaction on its own
 * one-connection pool, released on commit, rollback, the transaction timeout or a dropped
 * connection (crash-safe: never held after the process is gone). Works behind
 * transaction-mode poolers. If the work outlives the transaction timeout, the lock is
 * released and the result is still returned (`lockLost`).
 */
export function tickLock(
  timeoutMs: number = TICK_LOCK_TIMEOUT_MS,
  db: () => ReturnType<typeof getTickLockDb> = getTickLockDb,
): TickLock {
  return async <T>(work: () => Promise<T>) => {
    let done: { value: T } | undefined;
    try {
      const ran = await db().$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ ok: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${TICK_LOCK_KEY}::bigint) AS "ok"`;
          if (rows[0]?.ok !== true) return false;
          done = { value: await work() };
          return true;
        },
        { maxWait: 10_000, timeout: timeoutMs },
      );
      return ran && done !== undefined
        ? { ran: true as const, value: done.value }
        : { ran: false as const };
    } catch (error) {
      // The work finished, but its transaction had already timed out (commit refused).
      if (done !== undefined) return { ran: true as const, value: done.value, lockLost: true };
      throw error;
    }
  };
}

const withTickLock: TickLock = (work) => tickLock()(work);

/** The phases of one tick, under its time budget. */
async function runTickPhases(
  now: () => Date,
  phases: TickPhases,
  options: TickOptions,
): Promise<ScheduledTickSummary> {
  const elapsed = options.elapsedClock ?? (() => performance.now());
  const budgetMs = options.timeBudgetMs ?? TICK_TIME_BUDGET_MS;
  const startedAt = elapsed();
  const failedPhases: string[] = [];
  const skippedPhases: string[] = [];
  const cutShortPhases: string[] = [];
  await bestEffort("heartbeat_start", () =>
    recordJobStarted(getSystemDb(), "automation-tick", now()),
  );
  const overBudget = () => elapsed() - startedAt >= budgetMs;
  async function phase<T>(
    name: string,
    fallback: T,
    work: (shouldStop: ShouldStop) => Promise<T>,
  ): Promise<T> {
    if (overBudget()) {
      skippedPhases.push(name);
      return fallback;
    }
    // Checked by the phase before each item: a phase never keeps the tick going long
    // after its budget (which is what lets a slow tick overlap the next one).
    const shouldStop = () => {
      const stop = overBudget();
      if (stop && !cutShortPhases.includes(name)) cutShortPhases.push(name);
      return stop;
    };
    try {
      return await work(shouldStop);
    } catch (error) {
      failedPhases.push(name);
      logger.error({ err: error, phase: name }, "Scheduled tick phase failed");
      return fallback;
    }
  }

  const summary = await phase(
    "orchestration",
    { recovered: 0, scheduled: 0, skippedNoDelegate: 0, executed: [] },
    (shouldStop) => phases.orchestration(shouldStop),
  );
  const sweep = await phase<Awaited<ReturnType<TickPhases["social"]>>>(
    "social",
    EMPTY_SOCIAL,
    (shouldStop) => phases.social(now(), shouldStop),
  );
  // A social step that failed as a whole (publishing, sending…) is a failed phase too:
  // the sweep keeps going, but the tick is not reported as healthy.
  const { failedPhases: socialFailed = [], ...social } = sweep;
  for (const name of socialFailed) failedPhases.push(`social.${name}`);
  const creditHoldsReleased = await phase("credits", 0, () => phases.credits(now()));
  const videoJobsResumed = await phase("video", 0, (shouldStop) => phases.video(shouldStop));
  const noSyncs = { started: 0, failed: 0 };
  const insightsSyncs =
    phases.insights === undefined
      ? noSyncs
      : await phase(
          "insights",
          noSyncs,
          (shouldStop) => phases.insights?.(shouldStop) ?? Promise.resolve(noSyncs),
        );
  if (phases.payments !== undefined) {
    const reconciled = await phase(
      "payments",
      { checked: 0, credited: 0 },
      () => phases.payments?.(now()) ?? Promise.resolve({ checked: 0, credited: 0 }),
    );
    if (reconciled.checked > 0) {
      logger.info({ event: "payments.reconciled", ...reconciled }, "Open card checkouts checked");
    }
  }
  const runs: Record<string, number> = {};
  for (const outcome of summary.executed) {
    const key =
      outcome.status === "finished" && outcome.state !== undefined
        ? outcome.state.toLowerCase()
        : outcome.status;
    runs[key] = (runs[key] ?? 0) + 1;
  }
  if (skippedPhases.length > 0 || cutShortPhases.length > 0) {
    logger.warn(
      { event: "automation_tick.over_budget", skippedPhases, cutShortPhases, budgetMs },
      "Scheduled tick ran out of its time budget",
    );
  }
  await reportTick(failedPhases, skippedPhases, cutShortPhases, now());
  return {
    recovered: summary.recovered,
    scheduled: summary.scheduled,
    skippedNoDelegate: summary.skippedNoDelegate,
    advanced: summary.executed.length,
    runs,
    social,
    creditHoldsReleased,
    videoJobsResumed,
    insightsSyncs,
    failedPhases,
    status: skippedPhases.length > 0 || cutShortPhases.length > 0 ? "partial" : "completed",
    skippedPhases,
    cutShortPhases,
  };
}
