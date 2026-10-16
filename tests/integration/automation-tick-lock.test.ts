// The scheduler tick's single flight and time budget (src/server/orchestration/runtime.ts):
// an overlapping tick is skipped (no phase runs, an alert is raised), the lock is released
// after success, failure, a transaction timeout and a dropped connection, and a tick that
// runs out of its budget starts no further phase, reports them and raises an alert. The
// lock is the real PostgreSQL advisory lock on the test database; phases are stand-ins.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runScheduledAutomationTick,
  TICK_LOCK_KEY,
  TICK_LOCK_TIMEOUT_MS,
  TICK_TIME_BUDGET_MS,
  tickLock,
  type TickPhases,
} from "@/server/orchestration/runtime";
import { RETENTION_LOCK_KEY } from "@/server/videos/retention-runtime";

import { createTestDb, resetDatabase } from "./helpers";

const { system } = createTestDb();
const NOW = new Date("2026-10-16T09:00:00Z");

beforeEach(async () => {
  await resetDatabase(system);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await system.$disconnect();
});

/** Phases that record their calls; `hold` makes orchestration wait for a gate. */
function phases(options: { hold?: Promise<void>; onOrchestration?: () => void } = {}) {
  const calls: string[] = [];
  const set: TickPhases = {
    orchestration: async () => {
      calls.push("orchestration");
      options.onOrchestration?.();
      await options.hold;
      return { recovered: 0, scheduled: 0, skippedNoDelegate: 0, executed: [] };
    },
    social: () => {
      calls.push("social");
      return Promise.resolve({ published: 0, drafted: 0, sent: 0, uncertain: 0, reviewed: 0 });
    },
    credits: () => {
      calls.push("credits");
      return Promise.resolve(0);
    },
    video: () => {
      calls.push("video");
      return Promise.resolve(0);
    },
  };
  return { calls, set };
}

function gate() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    open: () => {
      release?.();
    },
  };
}

/** Waits until the tick's advisory lock is held by some session. */
async function lockHeld(): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await system.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${TICK_LOCK_KEY}::oid AND granted`;
    if (rows[0] !== undefined) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function advisoryHolders(): Promise<number> {
  const rows = await system.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND objid = ${TICK_LOCK_KEY}::oid AND granted`;
  return rows[0]?.n ?? 0;
}

const heartbeat = () => system.systemHeartbeat.findUnique({ where: { name: "automation-tick" } });

describe("tick single flight", () => {
  it("a tick that finds another running is skipped: no phase runs, no heartbeat", async () => {
    const hold = gate();
    const first = phases({ hold: hold.promise });
    const running = runScheduledAutomationTick(() => NOW, first.set);
    expect(await lockHeld()).not.toBeNull();

    const second = phases();
    const later = new Date(NOW.getTime() + 60_000);
    const skipped = await runScheduledAutomationTick(() => later, second.set);
    expect(skipped).toMatchObject({ status: "skipped", skippedPhases: [], failedPhases: [] });
    expect(second.calls).toEqual([]);
    // The skipped tick recorded nothing; the running one owns the heartbeat.
    expect((await heartbeat())?.lastStartedAt?.getTime()).toBe(NOW.getTime());

    hold.open();
    expect(await running).toMatchObject({ status: "completed", skippedPhases: [] });
    expect(first.calls).toEqual(["orchestration", "social", "credits", "video"]);

    // Released: the next tick runs every phase.
    const third = phases();
    expect(await runScheduledAutomationTick(() => later, third.set)).toMatchObject({
      status: "completed",
    });
    expect(third.calls).toEqual(["orchestration", "social", "credits", "video"]);
    // Nothing holds the lock once the ticks are done.
    expect(await advisoryHolders()).toBe(0);
  }, 30_000);

  it("the lock is released when the work fails, and after a transaction timeout", async () => {
    const lock = tickLock();
    await expect(lock(() => Promise.reject(new Error("tick crashed")))).rejects.toThrow(
      "tick crashed",
    );
    expect(await lock(() => Promise.resolve("next"))).toEqual({ ran: true, value: "next" });

    // Work that outlives the lock's transaction: the result is still returned, flagged,
    // and the lock is free again (the timeout rolled the transaction back).
    const short = tickLock(300);
    const outlived = await short(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("late");
          }, 900);
        }),
    );
    expect(outlived).toEqual({ ran: true, value: "late", lockLost: true });
    expect(await lock(() => Promise.resolve("free"))).toEqual({ ran: true, value: "free" });
  }, 30_000);

  it("a lock whose session dies is released at once (crash safety)", async () => {
    const hold = gate();
    const lock = tickLock();
    const holder = lock(() => hold.promise).catch((error: unknown) => error);
    const pid = await lockHeld();
    expect(pid).not.toBeNull();
    // The process holding the lock "dies": its database session is terminated.
    await system.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;
    // Free at once, while the old work is still running: another tick can take it now.
    expect(await advisoryHolders()).toBe(0);
    expect(await lock(() => Promise.resolve("after crash"))).toEqual({
      ran: true,
      value: "after crash",
    });
    // The old work, when it finishes, learns its lock is gone (its commit is refused).
    hold.open();
    expect(await holder).toMatchObject({ ran: true, lockLost: true });
  }, 30_000);

  it("the lock key and limits are what the schedule assumes", () => {
    expect(TICK_LOCK_KEY).not.toBe(RETENTION_LOCK_KEY);
    // Budget below the 5-minute schedule; the lock outlives the budget.
    expect(TICK_TIME_BUDGET_MS).toBeLessThan(5 * 60 * 1000);
    expect(TICK_LOCK_TIMEOUT_MS).toBeGreaterThan(TICK_TIME_BUDGET_MS);
  });
});

describe("tick time budget", () => {
  it("starts no phase after the budget, reports them, and the next tick runs them", async () => {
    let clock = 0;
    const slow = phases({
      onOrchestration: () => {
        clock += 5_000; // orchestration used up the whole 5 s budget
      },
    });
    const summary = await runScheduledAutomationTick(() => NOW, slow.set, {
      timeBudgetMs: 5_000,
      elapsedClock: () => clock,
    });
    expect(summary).toMatchObject({
      status: "partial",
      skippedPhases: ["social", "credits", "video"],
      failedPhases: [],
    });
    expect(slow.calls).toEqual(["orchestration"]);
    // Not a failure: the heartbeat records a finished tick.
    expect(await heartbeat()).toMatchObject({ lastStatus: "ok", failedPhases: [] });

    const next = phases();
    expect(
      await runScheduledAutomationTick(() => NOW, next.set, {
        timeBudgetMs: 5_000,
        elapsedClock: () => 0,
      }),
    ).toMatchObject({ status: "completed", skippedPhases: [] });
    expect(next.calls).toEqual(["orchestration", "social", "credits", "video"]);
  });

  it("raises alerts for an over-budget tick and for an overlapping one", async () => {
    const sent: { key: string; severity: string; details?: unknown }[] = [];
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/flexibx");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string) as never);
        return Promise.resolve(new Response("ok"));
      }),
    );
    vi.resetModules();
    const runtime = await import("@/server/orchestration/runtime");

    let clock = 0;
    const slow = phases({
      onOrchestration: () => {
        clock += 10;
      },
    });
    await runtime.runScheduledAutomationTick(() => NOW, slow.set, {
      timeBudgetMs: 10,
      elapsedClock: () => clock,
    });
    expect(sent.find((entry) => entry.key === "automation_tick_over_budget")).toMatchObject({
      severity: "warning",
      details: { skippedPhases: ["social", "credits", "video"] },
    });

    const hold = gate();
    const running = runtime.runScheduledAutomationTick(
      () => NOW,
      phases({ hold: hold.promise }).set,
    );
    expect(await lockHeld()).not.toBeNull();
    const later = new Date(NOW.getTime() + 600_000);
    expect(await runtime.runScheduledAutomationTick(() => later, phases().set)).toMatchObject({
      status: "skipped",
    });
    hold.open();
    await running;
    expect(sent.find((entry) => entry.key === "automation_tick_overlap")).toMatchObject({
      severity: "warning",
    });
    // No secret, connection string or lock detail in any alert.
    expect(JSON.stringify(sent)).not.toMatch(/postgres|DATABASE_URL|pg_try_advisory/i);
  }, 30_000);
});
