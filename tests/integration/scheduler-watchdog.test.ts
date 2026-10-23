// The scheduler watchdog on the real database (Pass 38): a tick heartbeat older than
// TICK_STALE_SECONDS — what a stopped scheduler leaves behind — produces one critical alert
// through the real alert sink and its database throttle; a fresh heartbeat produces none.
// No alert leaves the process: the webhook is a fake fetch.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAlertSink, databaseAlertThrottle } from "@/server/monitoring/alert-sink";
import { recordJobFinished } from "@/server/monitoring/heartbeat";
import { collectOpsStatus, TICK_STALE_SECONDS } from "@/server/monitoring/ops-status";
import { checkScheduler } from "@/server/monitoring/scheduler-watchdog";

import { createTestDb, resetDatabase } from "./helpers";

const { system } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});
afterAll(async () => {
  await system.$disconnect();
});

function sinkWithFakeWebhook() {
  const delivered: { title: string; severity: string }[] = [];
  const sink = createAlertSink({
    webhookUrl: "https://alerts.example/hook",
    environment: "test",
    throttle: databaseAlertThrottle(system),
    fetch: ((_url: string, init?: RequestInit) => {
      delivered.push(JSON.parse(init?.body as string) as { title: string; severity: string });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch,
    log: () => undefined,
  });
  return { sink, delivered };
}

describe("scheduler watchdog (real database)", () => {
  it("alerts once when the scheduler stopped, and is throttled on the next run", async () => {
    const now = new Date();
    await recordJobFinished(
      system,
      "automation-tick",
      [],
      new Date(now.getTime() - (TICK_STALE_SECONDS + 60) * 1000),
    );
    const { sink, delivered } = sinkWithFakeWebhook();
    const run = () => checkScheduler({ collect: () => collectOpsStatus(system, now), alert: sink });
    expect(await run()).toEqual(["automation_tick_last_success_age_seconds"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.severity).toBe("critical");
    expect(delivered[0]?.title).toContain("automation_tick_last_success_age_seconds");
    // Same condition a moment later (any process): the shared throttle keeps it to one.
    await run();
    expect(delivered).toHaveLength(1);
  });

  it("sends nothing while ticks succeed", async () => {
    const now = new Date();
    await recordJobFinished(system, "automation-tick", [], new Date(now.getTime() - 60_000));
    const { sink, delivered } = sinkWithFakeWebhook();
    expect(
      await checkScheduler({ collect: () => collectOpsStatus(system, now), alert: sink }),
    ).toEqual([]);
    expect(delivered).toEqual([]);
  });
});
