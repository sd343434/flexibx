// The scheduler-facing endpoint POST /api/internal/automation-tick: disabled without a
// secret, indistinguishable 404 for a wrong token, one real tick with the right one
// (counts only in the response), and 12 authorized requests per 10 minutes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { updateAutomationPolicy } from "@/server/orchestration/policy";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const SECRET = ["automation", "tick", "secret", "for", "tests", "0123456789abcdef"].join("-");
const AUTH = `Bearer ${SECRET}`;
const { system, db } = createTestDb();

beforeAll(() => {
  // Deterministic local AI adapter: no network, no cost.
  vi.stubEnv("AI_PROVIDER", "fake");
  vi.stubEnv("AUTH_SECRET", "automation-tick-endpoint-test-auth-secret-0123456789");
});

beforeEach(async () => {
  await resetDatabase(system);
  vi.resetModules();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await system.$disconnect();
});

async function post(authorization?: string) {
  const route = await import("@/app/api/internal/automation-tick/route");
  const init: RequestInit =
    authorization === undefined
      ? { method: "POST" }
      : { method: "POST", headers: { authorization } };
  return route.POST(new Request("http://localhost:3000/api/internal/automation-tick", init));
}

async function duePlanning() {
  const ctx = await createTenant(system, { role: WorkspaceRole.OWNER });
  await updateAutomationPolicy(db, ctx, {
    enabled: true,
    planningCadence: "DAILY",
    allowDrafts: false,
    maxDraftsPerRun: "3",
  });
  await system.automationPolicy.update({
    where: { workspaceId: ctx.workspaceId },
    data: { nextPlanningAt: new Date(Date.now() - 60_000) },
  });
  return ctx;
}

describe("POST /api/internal/automation-tick", () => {
  it("is a 404 when no secret is configured, and runs nothing", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", "");
    const ctx = await duePlanning();
    expect((await post(AUTH)).status).toBe(404);
    expect(await system.agentRun.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);
  });

  it("is the same 404 for a missing or wrong token, consuming no quota", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    expect((await post()).status).toBe(404);
    expect((await post("Bearer wrong-token-wrong-token-wrong-token")).status).toBe(404);
    expect(await system.rateLimit.count({ where: { key: { contains: "automation-tick" } } })).toBe(
      0,
    );
  });

  it("runs one tick with the right token and returns counts only", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    const ctx = await duePlanning();
    const response = await post(AUTH);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      recovered: 0,
      scheduled: 1,
      skippedNoDelegate: 0,
      advanced: 1,
      runs: { succeeded: 1 },
      social: { published: 0, drafted: 0, sent: 0, uncertain: 0, reviewed: 0 },
      creditHoldsReleased: 0,
      videoJobsResumed: 0,
      // Meta Insights is not enabled here: nothing to read.
      insightsSyncs: { started: 0, failed: 0 },
      failedPhases: [],
      status: "completed",
      skippedPhases: [],
    });
    expect(JSON.stringify(body)).not.toContain(ctx.workspaceId);
    expect(
      await system.agentRun.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } }),
    ).toMatchObject({ trigger: "SCHEDULE", state: "SUCCEEDED" });
    // The slot was claimed: a second tick starts nothing.
    expect(await (await post(AUTH)).json()).toMatchObject({ scheduled: 0, advanced: 0 });
  });

  it("limits authorized calls to 12 per 10 minutes", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    for (let i = 0; i < 12; i += 1) expect((await post(AUTH)).status).toBe(200);
    const ctx = await duePlanning();
    const limited = await post(AUTH);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    // The limited call ran nothing.
    expect(await system.agentRun.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);
  });
});

describe("one scheduler tick when a whole phase fails", () => {
  async function staleHold() {
    const ctx = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { holdCredits } = await import("@/server/billing/credits");
    const settings = { trialPeriodCredits: 10 };
    const hold = await db.$transaction((tx) =>
      holdCredits(
        tx,
        {
          workspaceId: ctx.workspaceId,
          feature: "ai_text",
          idempotencyKey: "abandoned",
          reference: null,
          userId: null,
          timeZone: "Asia/Riyadh",
          now: new Date(),
        },
        settings,
      ),
    );
    return { ctx, holdId: hold.holdId };
  }
  const later = () => new Date(Date.now() + 20 * 60_000);

  it("still runs the later phases after the orchestration and social phases throw", async () => {
    const { holdId } = await staleHold();
    const { DEFAULT_TICK_PHASES, runScheduledAutomationTick } =
      await import("@/server/orchestration/runtime");
    let videoRan = false;
    const summary = await runScheduledAutomationTick(later, {
      ...DEFAULT_TICK_PHASES,
      orchestration: () => Promise.reject(new Error("database unavailable for this phase")),
      social: () => Promise.reject(new Error("social sweep crashed")),
      video: () => {
        videoRan = true;
        return Promise.resolve(0);
      },
    });
    expect(summary.failedPhases).toEqual(["orchestration", "social"]);
    // The credits phase ran for real after both failures, and so did the video phase.
    expect(summary.creditHoldsReleased).toBe(1);
    expect(await system.creditHold.findUniqueOrThrow({ where: { id: holdId } })).toMatchObject({
      status: "RELEASED",
    });
    expect(videoRan).toBe(true);
    expect(summary).toMatchObject({ advanced: 0, social: { sent: 0, published: 0 } });
  });

  it("still runs the video phase after the credits phase throws", async () => {
    const { DEFAULT_TICK_PHASES, runScheduledAutomationTick } =
      await import("@/server/orchestration/runtime");
    let videoRan = false;
    const summary = await runScheduledAutomationTick(later, {
      ...DEFAULT_TICK_PHASES,
      credits: () => Promise.reject(new Error("credits phase crashed")),
      video: () => {
        videoRan = true;
        return Promise.resolve(2);
      },
    });
    expect(summary.failedPhases).toEqual(["credits"]);
    expect(summary).toMatchObject({ creditHoldsReleased: 0, videoJobsResumed: 2 });
    expect(videoRan).toBe(true);
  });
});
