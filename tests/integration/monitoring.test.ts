// Operational monitoring on the real database: the ops-status counts, the tick heartbeat
// and failure alerts, the cross-process alert throttle and the bearer-protected endpoint.
// No alert leaves the process: ALERT_WEBHOOK_URL is unset (logs only) except where a
// fake fetch is injected.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { FakeVideoProvider } from "@/server/ai/providers/video/fake";
import { databaseAlertThrottle } from "@/server/monitoring/alert-sink";
import { recordJobFinished, recordJobStarted } from "@/server/monitoring/heartbeat";
import { runLedgerIntegrityCheck } from "@/server/monitoring/ledger-integrity";
import {
  collectOpsStatus,
  LEASE_OVERDUE_MS,
  RETENTION_STALE_SECONDS,
  STUCK_HOLD_MS,
  TICK_RUNNING_WARNING_SECONDS,
  TICK_STALE_SECONDS,
  VIDEO_OVERDUE_MS,
} from "@/server/monitoring/ops-status";
import { runScheduledAutomationTick, type TickPhases } from "@/server/orchestration/runtime";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import { requestVideoGeneration } from "@/server/videos/generation/video-generation-service";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const SECRET = ["ops", "status", "secret", "for", "tests", "0123456789abcdef"].join("-");
const { system, db } = createTestDb();
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
  // The daily retention job is healthy: only the problems below are reported.
  await recordJobFinished(system, "video-retention", [], ago(3_600_000));
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
    await recordJobFinished(system, "video-retention", [], ago(3_600_000));
    // Until the ledger integrity check has run once, the ledger state is a warning.
    expect((await collectOpsStatus(system, NOW)).status).toBe("warning");
    await runLedgerIntegrityCheck(system, ago(60_000), { intervalMs: 3_600_000 });
    const status = await collectOpsStatus(system, NOW);
    expect(status.status).toBe("ok");
    expect(check(status, "automation_tick_last_success_age_seconds")?.value).toBe(60);

    await recordJobFinished(system, "automation-tick", [], ago(TICK_STALE_SECONDS * 1000));
    expect((await collectOpsStatus(system, NOW)).status).toBe("critical");
  });

  it("reports a hung, partial or missed scheduled job", async () => {
    // A partial tick: finished at its time budget with work left over.
    await recordJobFinished(system, "automation-tick", [], ago(60_000), { partial: true });
    let status = await collectOpsStatus(system, NOW);
    expect(check(status, "automation_tick_last_run_partial")).toMatchObject({
      value: 1,
      level: "warning",
    });
    expect(check(status, "automation_tick_last_success_age_seconds")?.level).toBe("ok");
    expect(check(status, "automation_tick_running_seconds")).toMatchObject({ value: 0 });
    // A tick started long ago and never finished.
    await recordJobStarted(
      system,
      "automation-tick",
      ago((TICK_RUNNING_WARNING_SECONDS + 60) * 1000),
    );
    await recordJobFinished(
      system,
      "automation-tick",
      [],
      ago((TICK_RUNNING_WARNING_SECONDS + 120) * 1000),
    );
    status = await collectOpsStatus(system, NOW);
    expect(check(status, "automation_tick_running_seconds")).toMatchObject({
      value: TICK_RUNNING_WARNING_SECONDS + 60,
      level: "warning",
    });
    // Video retention never ran, then ran too long ago, then recently.
    expect(check(status, "video_retention_last_success_age_seconds")).toMatchObject({
      value: null,
      level: "warning",
    });
    await recordJobFinished(
      system,
      "video-retention",
      [],
      ago((RETENTION_STALE_SECONDS + 1) * 1000),
    );
    status = await collectOpsStatus(system, NOW);
    expect(check(status, "video_retention_last_success_age_seconds")?.level).toBe("warning");
    await recordJobFinished(system, "video-retention", [], ago(60_000));
    status = await collectOpsStatus(system, NOW);
    expect(check(status, "video_retention_last_success_age_seconds")?.level).toBe("ok");
  });

  it("reports stuck leases, overdue video jobs and failing Meta Insights sources", async () => {
    const ctx = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { workspaceId } = ctx;
    const empty = await collectOpsStatus(system, NOW);
    for (const name of [
      "video_jobs_overdue",
      "video_jobs_needs_reconciliation",
      "video_attempts_failed_24h",
      "agent_tasks_lease_expired",
      "insights_sources_lease_expired",
      "insights_sync_runs_failed_24h",
      "insights_sync_runs_partial_24h",
      "insights_sources_failing",
    ]) {
      expect(check(empty, name)).toMatchObject({ value: 0, level: "ok" });
    }

    // Video: one job long past its deadline, one waiting for an operator.
    const video = {
      db,
      provider: new FakeVideoProvider({ scenarios: [] }),
      writeTarget: () =>
        Promise.resolve({
          provider: "LEGACY_S3" as const,
          storage: new MemoryStorageService(),
          confirm: () => Promise.resolve(),
        }),
    };
    const request = {
      title: "Clip",
      prompt: "A cup of coffee",
      durationSeconds: 8,
      aspectRatio: "16:9" as const,
      resolution: "720p" as const,
      audio: false,
      tier: "DRAFT" as const,
    };
    const overdue = await requestVideoGeneration(video, ctx, request);
    await system.videoGenerationJob.update({
      where: { id: overdue.jobId },
      data: { deadlineAt: ago(VIDEO_OVERDUE_MS + 60_000) },
    });
    const held = await requestVideoGeneration(video, ctx, request);
    await system.videoGenerationJob.update({
      where: { id: held.jobId },
      data: { state: "IN_PROGRESS" },
    });
    await system.videoGenerationJob.update({
      where: { id: held.jobId },
      data: { state: "NEEDS_RECONCILIATION", failureCode: "outcome_unknown" },
    });

    // An agent task still RUNNING long after its lease ended.
    const run = await system.agentRun.create({
      data: { workspaceId, workflow: "content_planning", trigger: "MANUAL", idempotencyKey: "k1" },
    });
    await system.agentTask.create({
      data: {
        workspaceId,
        runId: run.id,
        key: "observe",
        handler: "observe",
        risk: "INTERNAL",
        maxAttempts: 1,
        timeoutMs: 1000,
        state: "RUNNING",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: ago(LEASE_OVERDUE_MS + 60_000),
      },
    });

    // Meta Insights: a source failing again and again, held by a dead run.
    const channel = await system.socialChannel.create({
      data: { workspaceId, platform: "FACEBOOK", externalId: "1001", pageId: "1001", name: "Page" },
    });
    const source = await system.insightsSource.create({
      data: {
        workspaceId,
        socialChannelId: channel.id,
        kind: "FACEBOOK_PAGE",
        externalId: "1001",
        pageId: "1001",
        name: "Page",
        failureCount: 4,
        leaseRunId: crypto.randomUUID(),
        leaseUntil: ago(LEASE_OVERDUE_MS + 60_000),
      },
    });
    for (const runStatus of ["FAILED", "FAILED", "ABANDONED", "PARTIAL"] as const) {
      await system.insightsSyncRun.create({
        data: {
          workspaceId,
          sourceId: source.id,
          trigger: "SCHEDULED",
          status: runStatus,
          startedAt: ago(120_000),
          finishedAt: ago(60_000),
          errorCode: runStatus === "PARTIAL" ? null : "internal_error",
        },
      });
    }

    const status = await collectOpsStatus(system, NOW);
    expect(check(status, "video_jobs_overdue")).toMatchObject({ value: 1, level: "critical" });
    expect(check(status, "video_jobs_needs_reconciliation")).toMatchObject({
      value: 1,
      level: "warning",
    });
    expect(check(status, "agent_tasks_lease_expired")).toMatchObject({
      value: 1,
      level: "critical",
    });
    expect(check(status, "insights_sources_lease_expired")).toMatchObject({
      value: 1,
      level: "warning",
    });
    expect(check(status, "insights_sync_runs_failed_24h")).toMatchObject({
      value: 3,
      level: "warning",
    });
    expect(check(status, "insights_sync_runs_partial_24h")).toMatchObject({
      value: 1,
      level: "ok",
    });
    expect(check(status, "insights_sources_failing")).toMatchObject({ value: 1, level: "warning" });
    expect(status.status).toBe("critical");
    // Counts and names only: no ids, page ids or names.
    const text = JSON.stringify(status);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toContain("1001");
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

  it("a webhook that refuses alerts never stops the tick; ops-status reports it until one is delivered", async () => {
    await seedProblems(); // 4 stuck-state alerts + 1 failed-phase alert
    let answer = 500;
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/flexibx");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("refused", { status: answer }))),
    );
    vi.resetModules();
    try {
      const runtime = await import("@/server/orchestration/runtime");
      const summary = await runtime.runScheduledAutomationTick(() => NOW, phases(["video"]));
      // The tick finished its work and recorded it, whatever the webhook answered.
      expect(summary.failedPhases).toEqual(["video"]);
      expect(
        await system.systemHeartbeat.findUniqueOrThrow({ where: { name: "automation-tick" } }),
      ).toMatchObject({ lastStatus: "failed", failedPhases: ["video"] });
      expect(
        await system.opsCheckResult.findUniqueOrThrow({ where: { name: "alert-delivery" } }),
      ).toMatchObject({ status: "error", counts: { sent: 0, failed: 5 } });
      expect(check(await collectOpsStatus(system, NOW), "alert_delivery_failed")).toMatchObject({
        value: 1,
        level: "warning",
      });

      // The destination works again: the refused alerts (their slots were given back) and
      // the delivery warning itself go out, and the warning clears.
      answer = 200;
      const later = new Date(NOW.getTime() + 60_000);
      await runtime.runScheduledAutomationTick(() => later, phases(["video"]));
      expect(
        await system.opsCheckResult.findUniqueOrThrow({ where: { name: "alert-delivery" } }),
      ).toMatchObject({ status: "ok", counts: { failed: 0 } });
      expect(check(await collectOpsStatus(system, later), "alert_delivery_failed")).toMatchObject({
        value: 0,
        level: "ok",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.stubEnv("ALERT_WEBHOOK_URL", "");
      vi.resetModules();
    }
  }, 30_000);

  it("the database throttle gives a slot back after a failed delivery, and only that slot", async () => {
    const throttle = databaseAlertThrottle(system);
    const at = new Date("2026-10-18T10:00:00Z");
    expect(await throttle.claim("k", at, 30 * 60_000)).toEqual({ send: true, suppressed: 0 });
    expect((await throttle.claim("k", at, 30 * 60_000)).send).toBe(false);
    // Another occurrence claimed the slot since: giving back an older claim changes nothing.
    await throttle.release?.("k", new Date(at.getTime() - 1));
    expect((await throttle.claim("k", at, 30 * 60_000)).send).toBe(false);
    // The failed delivery's own slot: the next occurrence is delivered, with the count.
    await throttle.release?.("k", at);
    expect(await throttle.claim("k", at, 30 * 60_000)).toEqual({ send: true, suppressed: 2 });
  });

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

/**
 * Runs `call` with the application's database clients pointed at a closed port (the
 * process-wide singletons are set aside and put back afterwards), as when PostgreSQL is down.
 */
async function withUnreachableDatabase<T>(call: () => Promise<T>): Promise<T> {
  const holder = globalThis as typeof globalThis & { __flexibxDb?: Record<string, unknown> };
  const saved = { ...holder.__flexibxDb };
  for (const key of Object.keys(holder.__flexibxDb ?? {})) delete holder.__flexibxDb?.[key];
  const original = process.env.DATABASE_URL;
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:nothing@127.0.0.1:1/flexibx_down_test");
  vi.resetModules();
  try {
    return await call();
  } finally {
    const opened = holder.__flexibxDb?.base as { $disconnect?: () => Promise<void> } | undefined;
    await opened?.$disconnect?.().catch(() => undefined);
    for (const key of Object.keys(holder.__flexibxDb ?? {})) delete holder.__flexibxDb?.[key];
    Object.assign(holder.__flexibxDb ?? {}, saved);
    vi.stubEnv("DATABASE_URL", original ?? "");
    vi.resetModules();
  }
}

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

  it("answers 429 once the shared quota (60 per 10 minutes) is used up", async () => {
    vi.stubEnv("OPS_STATUS_SECRET", SECRET);
    vi.resetModules();
    const route = await import("@/app/api/internal/ops-status/route");
    const call = (authorization: string) =>
      route.GET(
        new Request("http://localhost:3000/api/internal/ops-status", {
          headers: { authorization },
        }),
      );
    for (let i = 0; i < 60; i += 1) {
      expect([200, 503]).toContain((await call(`Bearer ${SECRET}`)).status);
    }
    const limited = await call(`Bearer ${SECRET}`);
    expect(limited.status).toBe(429);
    const body = await limited.text();
    expect(body).not.toContain(SECRET);
    expect(body).not.toMatch(/credit|tick|stuck/);
    // A wrong token is still a 404, not a 429 (rejected calls never reach the limiter).
    expect((await call("Bearer wrong-token-0123456789abcdef0123456789")).status).toBe(404);
  }, 60_000);

  it("is never refused for an uptime monitor polling once a minute (75 minutes)", async () => {
    vi.stubEnv("OPS_STATUS_SECRET", SECRET);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.UTC(2026, 9, 19, 12, 7, 10);
      const statuses: number[] = [];
      // Longer than its quota (60) in calls: a sliding count would refuse from call 61.
      for (let minute = 0; minute < 75; minute += 1) {
        vi.setSystemTime(start + minute * 60_000);
        statuses.push((await get(`Bearer ${SECRET}`)).status);
      }
      expect(statuses.filter((status) => status === 429)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it("never answers ok when the database cannot be reached, nor does readiness", async () => {
    vi.stubEnv("OPS_STATUS_SECRET", SECRET);
    const [unreachable, readiness] = await withUnreachableDatabase(async () => {
      const health = await import("@/app/api/health/route");
      return [
        await get(`Bearer ${SECRET}`),
        await health.GET(new Request("http://localhost:3000/api/health")),
      ] as const;
    });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({ status: "unavailable", checks: { db: "down" } });
    expect(unreachable.status).toBe(500);
    const body = await unreachable.text();
    expect(body).not.toMatch(/"status":"ok"|checks/);
    expect(body).not.toContain("127.0.0.1");
    // The database is back: so is the answer.
    expect([200, 503]).toContain((await get(`Bearer ${SECRET}`)).status);
  });

  it("answers 503 when something is critical and 200 when healthy", async () => {
    vi.stubEnv("OPS_STATUS_SECRET", SECRET);
    const critical = await get(`Bearer ${SECRET}`);
    expect(critical.status).toBe(503);
    expect(critical.headers.get("cache-control")).toBe("no-store");
    expect(((await critical.json()) as { status: string }).status).toBe("critical");

    await recordJobFinished(system, "automation-tick", [], new Date());
    await recordJobFinished(system, "video-retention", [], new Date());
    await runLedgerIntegrityCheck(system, new Date(), { intervalMs: 3_600_000 });
    const healthy = await get(`Bearer ${SECRET}`);
    expect(healthy.status).toBe(200);
    expect(((await healthy.json()) as { status: string }).status).toBe("ok");
  });
});
