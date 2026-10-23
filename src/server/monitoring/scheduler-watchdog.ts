import type { Alert, AlertOutcome } from "./alert-sink";
import type { OpsStatus } from "./ops-status";

// Pass 38: who notices that the SCHEDULER stopped? The automation tick alerts on every
// failing operational check except its own (`automation_tick_*`): a stopped scheduler runs
// no tick, so nothing alerted and ops-status only answered when polled. This watchdog runs
// in another process — the Creator Studio worker (scripts/creator/worker.ts), which does
// not depend on the scheduler — and alerts on exactly those checks. The alert sink's
// database throttle (one alert per key per 30 min, shared by every process) keeps it quiet
// while the condition lasts. Pure: every side effect comes through its arguments.

/** Default interval of the watchdog in the worker (SCHEDULER_WATCHDOG_SECONDS; 0 = off). */
export const SCHEDULER_WATCHDOG_DEFAULT_SECONDS = 300;

export interface SchedulerWatchdogDeps {
  readonly collect: () => Promise<OpsStatus>;
  readonly alert: (alert: Alert) => Promise<AlertOutcome>;
}

/** Alerts on the scheduler's own critical checks; returns the names it alerted on. */
export async function checkScheduler(deps: SchedulerWatchdogDeps): Promise<readonly string[]> {
  const status = await deps.collect();
  const failing = status.checks.filter(
    (check) => check.name.startsWith("automation_tick_") && check.level === "critical",
  );
  await Promise.all(
    failing.map((check) =>
      deps.alert({
        key: `ops:${check.name}`,
        severity: "critical",
        title: `Scheduler check failed: ${check.name}`,
        details: { value: check.value, threshold: check.threshold },
      }),
    ),
  );
  return failing.map((check) => check.name);
}

/** SCHEDULER_WATCHDOG_SECONDS → milliseconds; 0 disables it; anything invalid → default. */
export function schedulerWatchdogIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return SCHEDULER_WATCHDOG_DEFAULT_SECONDS * 1000;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0) return SCHEDULER_WATCHDOG_DEFAULT_SECONDS * 1000;
  return seconds * 1000;
}
