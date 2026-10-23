// The scheduler watchdog (src/server/monitoring/scheduler-watchdog.ts, Pass 38): it alerts
// on exactly the automation tick's own critical checks — the ones the tick cannot report
// when the scheduler is down — and nothing else.
import { describe, expect, it } from "vitest";

import type { Alert } from "@/server/monitoring/alert-sink";
import type { OpsCheck } from "@/server/monitoring/ops-status";
import {
  checkScheduler,
  SCHEDULER_WATCHDOG_DEFAULT_SECONDS,
  schedulerWatchdog,
  schedulerWatchdogIntervalMs,
  WATCHDOG_FAILURES_BEFORE_ALERT,
} from "@/server/monitoring/scheduler-watchdog";

const status = (checks: OpsCheck[]) => () => Promise.resolve({ status: "ok", checks } as never);

describe("scheduler watchdog", () => {
  it("alerts on a stale or failed tick only, as critical, with no other check", async () => {
    const sent: Alert[] = [];
    const names = await checkScheduler({
      collect: status([
        {
          name: "automation_tick_last_success_age_seconds",
          value: 3600,
          threshold: 900,
          level: "critical",
        },
        { name: "automation_tick_last_run_failed", value: 1, threshold: 1, level: "critical" },
        { name: "automation_tick_last_run_partial", value: 1, threshold: 1, level: "warning" },
        {
          name: "creator_worker_last_seen_age_seconds",
          value: 9999,
          threshold: 600,
          level: "critical",
        },
        { name: "stuck_credit_holds", value: 0, threshold: 1, level: "ok" },
      ]),
      alert: (event) => {
        sent.push(event);
        return Promise.resolve("sent");
      },
    });
    expect(names).toEqual([
      "automation_tick_last_success_age_seconds",
      "automation_tick_last_run_failed",
    ]);
    expect(sent.map((event) => [event.key, event.severity])).toEqual([
      ["ops:automation_tick_last_success_age_seconds", "critical"],
      ["ops:automation_tick_last_run_failed", "critical"],
    ]);
    expect(sent[0]?.details).toEqual({ value: 3600, threshold: 900 });
  });

  it("stays silent while the scheduler is healthy", async () => {
    const sent: Alert[] = [];
    const names = await checkScheduler({
      collect: status([
        {
          name: "automation_tick_last_success_age_seconds",
          value: 60,
          threshold: 900,
          level: "ok",
        },
      ]),
      alert: (event) => {
        sent.push(event);
        return Promise.resolve("sent");
      },
    });
    expect(names).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("reads its interval: default, explicit, off, invalid", () => {
    const fallback = SCHEDULER_WATCHDOG_DEFAULT_SECONDS * 1000;
    expect(schedulerWatchdogIntervalMs(undefined)).toBe(fallback);
    expect(schedulerWatchdogIntervalMs("60")).toBe(60_000);
    expect(schedulerWatchdogIntervalMs("0")).toBe(0);
    for (const bad of ["-5", "1.5", "five", " "]) {
      expect(schedulerWatchdogIntervalMs(bad)).toBe(fallback);
    }
  });

  // Pass 39: a database it cannot read is itself alerted on — after a second failure in a
  // row, so one blip stays quiet — and a successful read starts the count again.
  it("alerts when it cannot read the status twice in a row, not on one blip", async () => {
    const sent: Alert[] = [];
    let down = true;
    const check = schedulerWatchdog({
      collect: () => (down ? Promise.reject(new Error("database unreachable")) : status([])()),
      alert: (event) => {
        sent.push(event);
        return Promise.resolve("sent");
      },
    });
    expect(WATCHDOG_FAILURES_BEFORE_ALERT).toBe(2);
    await expect(check()).rejects.toThrow("database unreachable");
    expect(sent).toEqual([]);
    await expect(check()).rejects.toThrow("database unreachable");
    expect(sent.map((event) => [event.key, event.severity, event.details])).toEqual([
      ["ops:scheduler_watchdog_status_unavailable", "critical", { consecutiveFailures: 2 }],
    ]);
    down = false;
    await expect(check()).resolves.toEqual([]);
    down = true;
    await expect(check()).rejects.toThrow();
    expect(sent).toHaveLength(1); // the count restarted
  });
});
