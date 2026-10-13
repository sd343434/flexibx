import "server-only";

import type { AiRuntime } from "../ai/ai-service";
import { providerFromEnv } from "../ai/configured-provider";
import { creditsSettingsFromEnv } from "../billing/config";
import { releaseStaleHolds } from "../billing/credits";
import { getDb, getSystemDb } from "../db/client";
import { getAiEnv, getVideoEnv } from "../env";
import { logger } from "../logger";
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
  /** Phases that failed on this tick (logged); the others still ran. */
  readonly failedPhases: readonly string[];
}

const EMPTY_SOCIAL = { published: 0, drafted: 0, sent: 0, uncertain: 0, reviewed: 0 } as const;

/** The work of one tick, phase by phase (injectable so a failing phase can be tested). */
export interface TickPhases {
  orchestration(): Promise<{
    readonly recovered: number;
    readonly scheduled: number;
    readonly skippedNoDelegate: number;
    readonly executed: readonly { readonly status: string; readonly state?: string }[];
  }>;
  social(now: Date): Promise<ScheduledTickSummary["social"]>;
  credits(now: Date): Promise<number>;
  video(): Promise<number>;
}

export const DEFAULT_TICK_PHASES: TickPhases = {
  orchestration: () => automationTick({ ...getOrchestrationDeps(), system: getSystemDb() }),
  // The AI Social Manager's own sweep (publishing, drafts, unsent replies, stuck sends,
  // self-review).
  social: async (now) => {
    const { getSocialDeps, socialSweep } = await import("../social/social-runtime");
    return socialSweep(getSocialDeps(), getSystemDb(), now);
  },
  credits: (now) =>
    releaseStaleHolds(getSystemDb(), getDb(), now, creditsSettingsFromEnv(), 50, logger),
  // Video jobs whose runner stopped: resumed with the configured provider only (never
  // started when VIDEO_PROVIDER is disabled — nothing can be in flight then).
  video: async () => {
    if (getVideoEnv().VIDEO_PROVIDER === "disabled") return 0;
    const { getVideoGenerationDeps } = await import("../videos/generation/runtime");
    const { recoverVideoJobs } = await import("../videos/generation/video-generation-service");
    return (await recoverVideoJobs({ ...getVideoGenerationDeps(), system: getSystemDb() })).resumed;
  },
};

/**
 * One scheduler tick: the single entry point for POST /api/internal/automation-tick and
 * `pnpm automation:tick`. Each phase runs on its own — a phase that fails as a whole is
 * logged and reported in `failedPhases`, and the following phases still run (each phase
 * also isolates its own items).
 */
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
async function reportTick(failedPhases: readonly string[], at: Date): Promise<void> {
  const intervalMs = ledgerIntegrityIntervalMs();
  await bestEffort("ledger_integrity", () =>
    runLedgerIntegrityCheck(getSystemDb(), at, { intervalMs }),
  );
  await bestEffort("heartbeat_finish", () =>
    recordJobFinished(getSystemDb(), "automation-tick", failedPhases, at),
  );
  const alerts: Alert[] = [];
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
  await Promise.all(alerts.map((entry) => alert(entry)));
}

export async function runScheduledAutomationTick(
  now: () => Date = () => new Date(),
  phases: TickPhases = DEFAULT_TICK_PHASES,
): Promise<ScheduledTickSummary> {
  const failedPhases: string[] = [];
  await bestEffort("heartbeat_start", () =>
    recordJobStarted(getSystemDb(), "automation-tick", now()),
  );
  async function phase<T>(name: string, fallback: T, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      failedPhases.push(name);
      logger.error({ err: error, phase: name }, "Scheduled tick phase failed");
      return fallback;
    }
  }

  const summary = await phase(
    "orchestration",
    { recovered: 0, scheduled: 0, skippedNoDelegate: 0, executed: [] },
    () => phases.orchestration(),
  );
  const social = await phase("social", EMPTY_SOCIAL, () => phases.social(now()));
  const creditHoldsReleased = await phase("credits", 0, () => phases.credits(now()));
  const videoJobsResumed = await phase("video", 0, () => phases.video());
  const runs: Record<string, number> = {};
  for (const outcome of summary.executed) {
    const key =
      outcome.status === "finished" && outcome.state !== undefined
        ? outcome.state.toLowerCase()
        : outcome.status;
    runs[key] = (runs[key] ?? 0) + 1;
  }
  await reportTick(failedPhases, now());
  return {
    recovered: summary.recovered,
    scheduled: summary.scheduled,
    skippedNoDelegate: summary.skippedNoDelegate,
    advanced: summary.executed.length,
    runs,
    social,
    creditHoldsReleased,
    videoJobsResumed,
    failedPhases,
  };
}
