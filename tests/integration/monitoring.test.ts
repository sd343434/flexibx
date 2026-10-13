// Operational monitoring on the real database: the ops-status counts, the tick heartbeat
// and failure alerts, the cross-process alert throttle and the bearer-protected endpoint.
// No alert leaves the process: ALERT_WEBHOOK_URL is unset (logs only) except where a
// fake fetch is injected.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { databaseAlertThrottle } from "@/server/monitoring/alert-sink";
import { recordJobFinished } from "@/server/monitoring/heartbeat";
import { runLedgerIntegrityCheck } from "@/server/monitoring/ledger-integrity";
import {
  collectOpsStatus,
  STUCK_HOLD_MS,
  TICK_STALE_SECONDS,
} from "@/server/monitoring/ops-status";
import { runScheduledAutomationTick, type TickPhases } from "@/server/orchestration/runtime";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const SECRET = ["ops", "status", "secret", "for", "tests", "0123456789abcdef"].join("-");
const { system } = createTestDb();
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeAll(() => {
  vi.stubEnv("AUTH_SECRET", "monitoring-test-auth-secret-0123456789abcdef");
  vi.stubEnv("ALERT_WEBHOOK_URL", "");
});

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await system.$disconnect();
});

const check = (status: Awaited<ReturnType<typeof collectOpsStatus>>, name: string) =>
  status.checks.find((entry) => entry.name === name);

async function seedProblems() {
  const ctx = await createTenant(system, { role: WorkspaceRole.OWNER });
  const workspaceId = ctx.workspaceId;
  const hold = (key: string, createdAt: Date, status: "HELD" | "RELEASED" = "HELD") =>
    system.creditHold.create({
      data: {
        workspaceId,
        feature: "social_reply",
        amount: 1,
        subscriptionPortion: 1,
        purchasedPortion: 0,
        idempotencyKey: key,
        priceVersion: "test",
        status,
        createdAt,
        settledAt: status === "HELD" ? null : createdAt,
      },
    });
  await hold("stuck-1", ago(STUCK_HOLD_MS + 60_000));
  await hold("fresh", ago(60_000)); // the tick still has time to release it
  await hold("released", ago(STUCK_HOLD_MS * 4), "RELEASED");

  const channel = await system.socialChannel.create({
    data: { workspaceId, platform: "FACEBOOK", externalId: "p1", pageId: "p1", name: "Page" },
  });
  const agent = await system.socialAgent.create({
    data: { workspaceId, name: "Agent", role: "customer_service" },
  });
  let n = 0;
  const reply = async (sendStatus: string, updatedAt: Date, sendError: string | null = null) => {
    n += 1;
    const interaction = await system.socialInteraction.create({
      data: {
        workspaceId,
        channelId: channel.id,
        kind: "COMMENT",
        externalId: `c${String(n)}`,
        threadExternalId: "t1",
        text: "private customer text",
        receivedAt: NOW,
      },
    });
    const row = await system.socialReply.create({
      data: {
        workspaceId,
        interactionId: interaction.id,
        agentId: agent.id,
        confidence: 90,
        needsHuman: false,
        reason: "r",
        guidanceVersion: 1,
        decision: "AUTO",
        finalText: "reply text",
        sendStatus,
        sendError,
      },
    });
    await system.$executeRaw`UPDATE social_replies SET updated_at = ${updatedAt} WHERE id = ${row.id}::uuid`;
  };
  await reply("SENDING", ago(60 * 60_000)); // stuck
  await reply("SENDING", ago(60_000)); // in flight
  await reply("UNCERTAIN", ago(60_000));
  await reply("FAILED", ago(60_000), "graph_error");
  await reply("FAILED", ago(60_000), "superseded"); // expected, not a delivery failure

  for (let i = 0; i < 5; i += 1) {
    await system.aiGeneration.create({
      data: {
        workspaceId,
        operation: "COPY",
        provider: "fake",
        language: "ar",
        status: "FAILED",
        errorCode: "provider_unavailable",
      },
    });
  }
  return ctx;
}

describe("ops status", () => {
  it("is critical when the tick never ran, and counts stuck work without customer data", async () => {
    await seedProblems();
    const status = await collectOpsStatus(system, NOW);
    expect(status.status).toBe("critical");
    expect(check(status, "automation_tick_last_success_age_seconds")).toMatchObject({
      value: null,
      level: "critical",
    });
    expect(check(status, "credit_holds_stuck")).toMatchObject({ value: 1, level: "critical" });
    expect(check(status, "social_replies_sending_stuck")).toMatchObject({
      value: 1,
      level: "critical",
    });
    expect(check(status, "social_replies_uncertain")).toMatchObject({ value: 1, level: "warning" });
    expect(check(status, "social_replies_failed_24h")).toMatchObject({ value: 1, level: "ok" });
    expect(check(status, "ai_generations_failed_1h")).toMatchObject({ value: 5, level: "warning" });
    expect(check(status, "social_posts_publishing_stuck")).toMatchObject({ value: 0, level: "ok" });
    expect(check(status, "whatsapp_messages_uncertain")).toMatchObject({ value: 0, level: "ok" });
    // Counts and names only.
    const text = JSON.stringify(status);
    expect(text).not.toContain("private customer text");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("is ok with a recent successful tick and nothing stuck", async () => {
    await recordJobFinished(system, "automation-tick", [], ago(60_000));
    // Until the ledger integrity check has run once, the ledger state is a warning.
    expect((await collectOpsStatus(system, NOW)).status).toBe("warning");
    await runLedgerIntegrityCheck(system, ago(60_000), { intervalMs: 3_600_000 });
    const status = await collectOpsStatus(system, NOW);
    expect(status.status).toBe("ok");
    expect(check(status, "automation_tick_last_success_age_seconds")?.value).toBe(60);

    await recordJobFinished(system, "automation-tick", [], ago(TICK_STALE_SECONDS * 1000));
    expect((await collectOpsStatus(system, NOW)).status).toBe("critical");
  });
});

describe("tick heartbeat and alerts", () => {
  const phases = (failing: readonly string[]): TickPhases => {
    const fail = (name: string) => () =>
      failing.includes(name) ? Promise.reject(new Error(`${name} down`)) : Promise.resolve();
    return {
      orchestration: () =>
        fail("orchestration")().then(() => ({
          recovered: 0,
          scheduled: 0,
          skippedNoDelegate: 0,
          executed: [],
        })),
      social: () =>
        fail("social")().then(() => ({
          published: 0,
          drafted: 0,
          sent: 0,
          stuck: 0,
        })) as never,
      credits: () => fail("credits")().then(() => 0),
      video: () => fail("video")().then(() => 0),
    };
  };

  it("records a successful tick, and a failed one with its phase names", async () => {
    await runScheduledAutomationTick(() => NOW, phases([]));
    const ok = await system.systemHeartbeat.findUniqueOrThrow({
      where: { name: "automation-tick" },
    });
    expect(ok).toMatchObject({ lastStatus: "ok", failedPhases: [] });
    expect(ok.lastSucceededAt?.getTime()).toBe(NOW.getTime());
    expect(ok.lastStartedAt?.getTime()).toBe(NOW.getTime());
    // The tick ran the ledger integrity check (due: it never ran) ...
    const ledger = await system.opsCheckResult.findUniqueOrThrow({
      where: { name: "credit-ledger-integrity" },
    });
    expect(ledger).toMatchObject({ status: "ok" });
    expect(ledger.startedAt.getTime()).toBe(NOW.getTime());

    const later = new Date(NOW.getTime() + 60_000);
    const summary = await runScheduledAutomationTick(() => later, phases(["social", "credits"]));
    expect(summary.failedPhases).toEqual(["social", "credits"]);
    const failed = await system.systemHeartbeat.findUniqueOrThrow({
      where: { name: "automation-tick" },
    });
    expect(failed).toMatchObject({ lastStatus: "failed", failedPhases: ["social", "credits"] });
    // The last success is kept, so the status endpoint can still tell its age.
    expect(failed.lastSucceededAt?.getTime()).toBe(NOW.getTime());
    // ... and not again one minute later (once per LEDGER_INTEGRITY_INTERVAL_MINUTES).
    expect(
      (
        await system.opsCheckResult.findUniqueOrThrow({
          where: { name: "credit-ledger-integrity" },
        })
      ).startedAt.getTime(),
    ).toBe(NOW.getTime());
    expect(
      check(await collectOpsStatus(system, later), "automation_tick_last_run_failed"),
    ).toMatchObject({
      level: "critical",
    });
  });

  it("delivers failure and stuck-state alerts through the webhook, throttled across runs", async () => {
    await seedProblems();
    const sent: { key: string; severity: string; details: unknown }[] = [];
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/flexibx");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string) as never);
        return Promise.resolve(new Response("ok"));
      }),
    );
    vi.resetModules();
    try {
      const runtime = await import("@/server/orchestration/runtime");
      await runtime.runScheduledAutomationTick(() => NOW, phases(["video"]));
      await runtime.runScheduledAutomationTick(() => NOW, phases(["video"]));
    } finally {
      vi.unstubAllGlobals();
      vi.stubEnv("ALERT_WEBHOOK_URL", "");
      vi.resetModules();
    }
    const keys = sent.map((entry) => entry.key).sort();
    expect(keys).toEqual(
      [
        "automation_tick_phase_failed",
        "ops:ai_generations_failed_1h",
        "ops:credit_holds_stuck",
        "ops:social_replies_sending_stuck",
        "ops:social_replies_uncertain",
      ].sort(),
    );
    expect(sent.find((entry) => entry.key === "automation_tick_phase_failed")).toMatchObject({
      severity: "critical",
      details: { failedPhases: ["video"] },
    });
    expect(JSON.stringify(sent)).not.toContain("private customer text");
    // The second run's occurrences were counted, not delivered.
    expect(
      await system.alertThrottle.findUniqueOrThrow({
        where: { key: "automation_tick_phase_failed" },
      }),
    ).toMatchObject({ suppressedCount: 1 });
  });

  it("a hanging webhook delays the tick by one delivery timeout at most", async () => {
    await seedProblems(); // 4 stuck-state alerts + 1 failed-phase alert
    let calls = 0;
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/flexibx");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            calls += 1;
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("timeout", "TimeoutError"));
            });
          }),
      ),
    );
    vi.resetModules();
    try {
      const runtime = await import("@/server/orchestration/runtime");
      const started = performance.now();
      const summary = await runtime.runScheduledAutomationTick(() => NOW, phases(["video"]));
      const elapsed = performance.now() - started;
      expect(summary.failedPhases).toEqual(["video"]);
      expect(calls).toBe(5);
      // Sequential deliveries would take 5 × 3 s.
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      vi.unstubAllGlobals();
      vi.stubEnv("ALERT_WEBHOOK_URL", "");
      vi.resetModules();
    }
  }, 20_000);

  it("the database throttle lets exactly one of many concurrent claims through", async () => {
    const throttle = databaseAlertThrottle(system);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => throttle.claim("race", NOW, 60_000)),
    );
    expect(results.filter((result) => result.send)).toHaveLength(1);
    expect(await throttle.claim("race", new Date(NOW.getTime() + 60_000), 60_000)).toEqual({
      send: true,
      suppressed: 7,
    });
  });
});

describe("GET /api/internal/ops-status", () => {
  async function get(authorization?: string) {
    vi.resetModules();
    const route = await import("@/app/api/internal/ops-status/route");
    return route.GET(
      new Request("http://localhost:3000/api/internal/ops-status", {
        headers: authorization === undefined ? {} : { authorization },
      }),
    );
  }

  it("is a 404 without the secret configured or with a wrong token", async () => {
    vi.stubEnv("OPS_STATUS_SECRET", "");
    expect((await get(`Bearer ${SECRET}`)).status).toBe(404);
    vi.stubEnv("OPS_STATUS_SECRET", SECRET);
    expect((await get()).status).toBe(404);
    expect((await get("Bearer wrong-wrong-wrong-wrong-wrong-wrong-wrong")).status).toBe(404);
    // Unauthenticated calls use none of the endpoint's quota and learn nothing.
    expect(await system.rateLimit.count({ where: { key: { contains: "ops-status" } } })).toBe(0);
    const body = await (await get(`Bearer ${SECRET.slice(0, -1)}x`)).text();
    expect(body).not.toMatch(/automation_tick|credit_holds|checks/);
  });

  it("answers 503 when something is critical and 200 when healthy", async () => {
    vi.stubEnv("OPS_STATUS_SECRET", SECRET);
    const critical = await get(`Bearer ${SECRET}`);
    expect(critical.status).toBe(503);
    expect(critical.headers.get("cache-control")).toBe("no-store");
    expect(((await critical.json()) as { status: string }).status).toBe("critical");

    await recordJobFinished(system, "automation-tick", [], new Date());
    await runLedgerIntegrityCheck(system, new Date(), { intervalMs: 3_600_000 });
    const healthy = await get(`Bearer ${SECRET}`);
    expect(healthy.status).toBe(200);
    expect(((await healthy.json()) as { status: string }).status).toBe("ok");
  });
});
