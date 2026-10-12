import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Capabilities, RunList } from "@/app/[locale]/w/[workspaceSlug]/autopilot/autopilot-views";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { createFakeProvider } from "@/server/ai/fake-provider";
import { AppError } from "@/server/errors/app-error";
import {
  cancelRun,
  createRun,
  executeRun,
  recoverStaleTasks,
  type OrchestrationDeps,
} from "@/server/orchestration/engine";
import {
  setAutomationPaused,
  updateAutomationPolicy,
  getAutomationPolicy,
} from "@/server/orchestration/policy";
import { inStepOrder } from "@/server/orchestration/automation-queries";
import { startPlanningRun } from "@/server/orchestration/runs";
import { automationTick } from "@/server/orchestration/scheduler";
import {
  TaskError,
  type TaskDefinition,
  type WorkflowDefinition,
} from "@/server/orchestration/workflow";
import {
  contentPlanningWorkflow,
  type PlanningServices,
} from "@/server/orchestration/workflows/content-planning";
import type { TenantContext } from "@/server/tenancy/context";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTenant, createTestDb, resetDatabase } from "./helpers";

// The shared orchestration engine and the AI Marketing Manager's first workflow, on the
// real database. Test workflows exercise the engine's guarantees; the content-planning
// workflow runs end to end with the deterministic fake AI provider (no network, no cost).

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

type Calls = Record<string, number>;

function step(
  key: string,
  dependsOn: string[],
  run: TaskDefinition<Calls>["run"],
  extra: Partial<TaskDefinition<Calls>> = {},
): TaskDefinition<Calls> {
  return {
    key,
    dependsOn,
    risk: "INTERNAL",
    maxAttempts: 2,
    timeoutMs: 5_000,
    ...extra,
    run: async (context) => {
      context.services[key] = (context.services[key] ?? 0) + 1;
      return run(context);
    },
  };
}

const ok =
  (output: Record<string, unknown> = {}) =>
  () =>
    Promise.resolve({ status: "succeeded" as const, output });

function engine(workflow: WorkflowDefinition<Calls>) {
  const calls: Calls = {};
  const deps: OrchestrationDeps<Calls> = {
    db,
    services: calls,
    workflows: { [workflow.id]: workflow },
  };
  return { deps, calls };
}

async function admin(): Promise<TenantContext> {
  return createTenant(system, { role: WorkspaceRole.OWNER });
}

async function tasksOf(runId: string) {
  const rows = await system.agentTask.findMany({
    where: { runId },
    select: { key: true, state: true, attempts: true, failureCode: true, output: true },
  });
  return Object.fromEntries(rows.map((row) => [row.key, row]));
}

async function start(
  deps: OrchestrationDeps<Calls>,
  ctx: TenantContext,
  workflow: string,
  key = "manual:test",
) {
  const { runId } = await createRun(
    deps,
    { workspaceId: ctx.workspaceId, requestedByUserId: ctx.userId },
    workflow,
    "MANUAL",
    key,
  );
  return runId;
}

// ── engine ───────────────────────────────────────────────────────────────────

describe("orchestration engine", () => {
  it("runs tasks in dependency order, passes outputs on and stores the summary", async () => {
    const ctx = await admin();
    const seen: unknown[] = [];
    const { deps, calls } = engine({
      id: "diamond",
      summaryTask: "delta",
      tasks: [
        step("alpha", [], ok({ value: 1 })),
        step("beta", ["alpha"], ok({ value: 2 })),
        step("gamma", ["alpha"], ok({ value: 3 })),
        step("delta", ["beta", "gamma"], (context) => {
          seen.push(context.inputs);
          return Promise.resolve({ status: "succeeded", output: { total: 6 } });
        }),
      ],
    });
    const runId = await start(deps, ctx, "diamond");
    expect(await executeRun(deps, ctx.workspaceId, runId)).toEqual({
      status: "finished",
      state: "SUCCEEDED",
    });
    expect(calls).toEqual({ alpha: 1, beta: 1, gamma: 1, delta: 1 });
    expect(seen).toEqual([{ beta: { value: 2 }, gamma: { value: 3 } }]);
    const run = await system.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ state: "SUCCEEDED", summary: { total: 6 }, failureCode: null });
    expect(run.finishedAt).not.toBeNull();
    // Idempotent: the same key never starts a second run.
    expect(
      await createRun(
        deps,
        { workspaceId: ctx.workspaceId, requestedByUserId: ctx.userId },
        "diamond",
        "MANUAL",
        "manual:test",
      ),
    ).toEqual({ runId, created: false });
  });

  it("retries a transient failure after a backoff, and stops on a permanent one", async () => {
    const ctx = await admin();
    let failures = 1;
    const { deps, calls } = engine({
      id: "flaky",
      summaryTask: "beta",
      tasks: [
        step("alpha", [], () => {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new TaskError("unavailable", true));
          }
          return Promise.resolve({ status: "succeeded", output: {} });
        }),
        step("beta", ["alpha"], ok()),
      ],
    });
    const runId = await start(deps, ctx, "flaky");
    expect(await executeRun(deps, ctx.workspaceId, runId)).toEqual({ status: "waiting" });
    expect((await tasksOf(runId)).alpha).toMatchObject({
      state: "PENDING",
      attempts: 1,
      failureCode: "unavailable",
    });
    // The backoff passes.
    await system.agentTask.updateMany({ where: { runId }, data: { runAfter: new Date(0) } });
    expect(await executeRun(deps, ctx.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });
    expect(calls).toEqual({ alpha: 2, beta: 1 });

    const permanent = engine({
      id: "broken",
      summaryTask: "beta",
      tasks: [
        step("alpha", [], () => Promise.reject(new TaskError("ai_not_configured", false))),
        step("beta", ["alpha"], ok()),
      ],
    });
    const failed = await start(permanent.deps, ctx, "broken", "manual:broken");
    expect(await executeRun(permanent.deps, ctx.workspaceId, failed)).toEqual({
      status: "finished",
      state: "FAILED",
    });
    expect(await tasksOf(failed)).toMatchObject({
      alpha: { state: "FAILED", attempts: 1, failureCode: "ai_not_configured" },
      beta: { state: "CANCELLED", attempts: 0 },
    });
    expect(permanent.calls).toEqual({ alpha: 1 });
    expect((await system.agentRun.findUniqueOrThrow({ where: { id: failed } })).failureCode).toBe(
      "alpha:ai_not_configured",
    );
  });

  it("times a task out and treats unexpected errors as retryable", async () => {
    const ctx = await admin();
    const { deps } = engine({
      id: "slow",
      summaryTask: "alpha",
      tasks: [
        step(
          "alpha",
          [],
          (context) =>
            new Promise((resolve) => {
              context.signal.addEventListener("abort", () => {
                resolve({ status: "succeeded", output: { late: true } });
              });
            }),
          { timeoutMs: 1_000, maxAttempts: 1 },
        ),
      ],
    });
    const runId = await start(deps, ctx, "slow");
    expect(await executeRun(deps, ctx.workspaceId, runId)).toMatchObject({ state: "FAILED" });
    expect((await tasksOf(runId)).alpha).toMatchObject({ state: "FAILED", failureCode: "timeout" });

    const odd = engine({
      id: "odd",
      summaryTask: "alpha",
      tasks: [step("alpha", [], () => Promise.reject(new Error("boom")), { maxAttempts: 2 })],
    });
    const second = await start(odd.deps, ctx, "odd", "manual:odd");
    expect(await executeRun(odd.deps, ctx.workspaceId, second)).toEqual({ status: "waiting" });
    expect((await tasksOf(second)).alpha).toMatchObject({
      state: "PENDING",
      failureCode: "unexpected",
    });
  });

  it("never starts an external or spending task on its own", async () => {
    const ctx = await admin();
    const describe = (action: string, amount?: { minor: number; currency: string }) => ({
      describe: () =>
        Promise.resolve({ action, details: { post: "p-1" }, ...(amount ? { amount } : {}) }),
    });
    const { deps, calls } = engine({
      id: "publish",
      summaryTask: "report",
      tasks: [
        step("draft", [], ok()),
        step("publish", ["draft"], ok(), { risk: "EXTERNAL", ...describe("publish_post") }),
        step("boost", ["draft"], ok(), {
          risk: "SPEND",
          ...describe("boost_post", { minor: 5_000, currency: "SAR" }),
        }),
        step("report", ["publish", "boost"], ok()),
      ],
    });
    const runId = await start(deps, ctx, "publish");
    expect(await executeRun(deps, ctx.workspaceId, runId)).toEqual({
      status: "finished",
      state: "NEEDS_ATTENTION",
    });
    expect(calls).toEqual({ draft: 1 });
    // Waiting for a person blocks the dependents; it does not cancel them.
    expect(await tasksOf(runId)).toMatchObject({
      publish: { state: "NEEDS_APPROVAL", attempts: 0 },
      boost: { state: "NEEDS_APPROVAL", attempts: 0 },
      report: { state: "PENDING" },
    });
    const run = await system.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.failureCode).toMatch(/^approval_required:/);
    expect(run.finishedAt).toBeNull();
    expect(
      await system.auditLog.count({
        where: { workspaceId: ctx.workspaceId, action: "automation.approval_required" },
      }),
    ).toBe(2);
    // A consequential task that cannot say what it would do is refused up front.
    const undescribed = engine({
      id: "blind",
      summaryTask: "publish",
      tasks: [step("publish", [], ok(), { risk: "EXTERNAL" })],
    });
    await expect(start(undescribed.deps, ctx, "blind", "manual:blind")).rejects.toThrow(
      /undescribed:publish/,
    );
  });

  it("stops everything on the emergency stop and resumes where it left off", async () => {
    const ctx = await admin();
    const { deps, calls } = engine({
      id: "two",
      summaryTask: "beta",
      tasks: [step("alpha", [], ok()), step("beta", ["alpha"], ok())],
    });
    const runId = await start(deps, ctx, "two");
    await setAutomationPaused(db, ctx, true);
    expect(await executeRun(deps, ctx.workspaceId, runId)).toEqual({ status: "paused" });
    expect(calls).toEqual({});
    await expect(
      startPlanningRun(
        { ...deps, workflows: { content_planning: contentPlanningWorkflow as never } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", fields: [{ code: "automation_paused" }] });
    await setAutomationPaused(db, ctx, false);
    expect(await executeRun(deps, ctx.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });
    expect(
      (
        await system.auditLog.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            action: { in: ["automation.paused", "automation.resumed"] },
          },
          orderBy: { createdAt: "asc" },
          select: { action: true },
        })
      ).map((row) => row.action),
    ).toEqual(["automation.paused", "automation.resumed"]);
  });

  it("stops a run when the member it acts for loses their authority", async () => {
    const ctx = await admin();
    const { deps, calls } = engine({
      id: "one",
      summaryTask: "alpha",
      tasks: [step("alpha", [], ok())],
    });
    const runId = await start(deps, ctx, "one");
    await system.workspaceMember.updateMany({
      where: { workspaceId: ctx.workspaceId, userId: ctx.userId },
      data: { role: WorkspaceRole.EDITOR },
    });
    expect(await executeRun(deps, ctx.workspaceId, runId)).toEqual({
      status: "finished",
      state: "NEEDS_ATTENTION",
    });
    expect(calls).toEqual({});
    expect(await system.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      failureCode: "actor_no_access",
    });
  });

  it("recovers a task whose runner died, and fails it when no attempt is left", async () => {
    const ctx = await admin();
    const { deps, calls } = engine({
      id: "crash",
      summaryTask: "alpha",
      tasks: [step("alpha", [], ok(), { maxAttempts: 2 })],
    });
    const runId = await start(deps, ctx, "crash");
    const crashed = {
      state: "RUNNING" as const,
      attempts: 1,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 1_000),
    };
    await system.agentTask.updateMany({ where: { runId }, data: crashed });
    // A live lease is left alone.
    expect(await recoverStaleTasks(system, new Date(Date.now() - 60_000))).toBe(0);
    expect(await recoverStaleTasks(system, new Date())).toBe(1);
    expect((await tasksOf(runId)).alpha).toMatchObject({
      state: "PENDING",
      failureCode: "lease_expired",
    });
    expect(await executeRun(deps, ctx.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });
    expect(calls).toEqual({ alpha: 1 });

    const second = await start(deps, ctx, "crash", "manual:second");
    await system.agentTask.updateMany({
      where: { runId: second },
      data: { ...crashed, attempts: 2 },
    });
    await recoverStaleTasks(system, new Date());
    expect((await tasksOf(second)).alpha).toMatchObject({
      state: "FAILED",
      failureCode: "lease_expired",
    });
  });

  it("cancels a run and discards a result that arrives afterwards", async () => {
    const ctx = await admin();
    const holder: { runId?: string } = {};
    const { deps } = engine({
      id: "cancel",
      summaryTask: "beta",
      tasks: [
        step("alpha", [], async () => {
          // Someone cancels the run while this task is still working.
          await cancelRun(db, ctx, holder.runId ?? "");
          return { status: "succeeded", output: { late: true } };
        }),
        step("beta", ["alpha"], ok()),
      ],
    });
    holder.runId = await start(deps, ctx, "cancel");
    expect(await executeRun(deps, ctx.workspaceId, holder.runId)).toEqual({
      status: "finished",
      state: "CANCELLED",
    });
    expect(await tasksOf(holder.runId)).toMatchObject({
      alpha: { state: "CANCELLED", output: null },
      beta: { state: "CANCELLED" },
    });
    await expect(cancelRun(db, ctx, holder.runId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps runs inside their workspace", async () => {
    const ctx = await admin();
    const other = await admin();
    const { deps, calls } = engine({
      id: "one",
      summaryTask: "alpha",
      tasks: [step("alpha", [], ok())],
    });
    const runId = await start(deps, ctx, "one");
    expect(await executeRun(deps, other.workspaceId, runId)).toEqual({ status: "not_found" });
    await expect(cancelRun(db, other, runId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toEqual({});
    const editor = await createTenant(system, { role: WorkspaceRole.EDITOR });
    await expect(cancelRun(db, editor, runId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ── policy and scheduler ─────────────────────────────────────────────────────

describe("automation policy and scheduler", () => {
  it("is configured by administrators only and delegates the enabling member's authority", async () => {
    const ctx = await admin();
    const editor = await createTenant(system, { role: WorkspaceRole.EDITOR });
    await expect(
      updateAutomationPolicy(db, editor, {
        enabled: true,
        planningCadence: "WEEKLY",
        allowDrafts: false,
        maxDraftsPerRun: "3",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      updateAutomationPolicy(db, ctx, {
        enabled: true,
        planningCadence: "HOURLY",
        allowDrafts: false,
        maxDraftsPerRun: "11",
      }),
    ).rejects.toBeInstanceOf(AppError);
    await updateAutomationPolicy(db, ctx, {
      enabled: "on",
      planningCadence: "WEEKLY",
      allowDrafts: "on",
      maxDraftsPerRun: "2",
    });
    const policy = await getAutomationPolicy(db, ctx);
    expect(policy).toMatchObject({
      enabled: true,
      planningCadence: "WEEKLY",
      allowDrafts: true,
      maxDraftsPerRun: 2,
      delegateUserId: ctx.userId,
    });
    expect(policy.nextPlanningAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
    // Turning it off clears the schedule.
    await updateAutomationPolicy(db, ctx, {
      enabled: false,
      planningCadence: "WEEKLY",
      allowDrafts: false,
      maxDraftsPerRun: "2",
    });
    expect(await getAutomationPolicy(db, ctx)).toMatchObject({
      enabled: false,
      planningCadence: "OFF",
      nextPlanningAt: null,
    });
    const audit = await system.auditLog.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId, action: "automation.policy_updated" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.metadata).toMatchObject({
      changed: ["enabled", "planningCadence", "allowDrafts", "maxDraftsPerRun"],
    });
  });

  it("starts each due slot once, skips stopped workspaces, and advances runs", async () => {
    const ctx = await admin();
    const stopped = await admin();
    for (const tenant of [ctx, stopped]) {
      await updateAutomationPolicy(db, tenant, {
        enabled: true,
        planningCadence: "DAILY",
        allowDrafts: false,
        maxDraftsPerRun: "3",
      });
      await system.automationPolicy.update({
        where: { workspaceId: tenant.workspaceId },
        data: { nextPlanningAt: new Date(Date.now() - 60_000) },
      });
    }
    await setAutomationPaused(db, stopped, true);
    const deps: OrchestrationDeps<PlanningServices> & { system: typeof system } = {
      db,
      system,
      services: { ai: () => ({ provider: createFakeProvider(), timeoutMs: 5_000 }) },
      workflows: { content_planning: contentPlanningWorkflow },
    };
    const first = await automationTick(deps);
    expect(first).toMatchObject({ scheduled: 1, skippedNoDelegate: 0 });
    expect(first.executed).toEqual([{ status: "finished", state: "SUCCEEDED" }]);
    const second = await automationTick(deps);
    expect(second).toMatchObject({ scheduled: 0, executed: [] });
    expect(await system.agentRun.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
    expect(await system.agentRun.count({ where: { workspaceId: stopped.workspaceId } })).toBe(0);
    const policy = await system.automationPolicy.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(policy.nextPlanningAt?.getTime()).toBeGreaterThan(Date.now());
    expect(
      await system.agentRun.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } }),
    ).toMatchObject({ trigger: "SCHEDULE", requestedByUserId: ctx.userId });
  });
});

describe("scheduler resilience", () => {
  it("keeps a slot due when its run cannot be created, and later creates it once", async () => {
    const ctx = await admin();
    await updateAutomationPolicy(db, ctx, {
      enabled: true,
      planningCadence: "DAILY",
      allowDrafts: false,
      maxDraftsPerRun: "3",
    });
    const slot = new Date(Date.now() - 60_000);
    await system.automationPolicy.update({
      where: { workspaceId: ctx.workspaceId },
      data: { nextPlanningAt: slot },
    });
    const broken: OrchestrationDeps<PlanningServices> & { system: typeof system } = {
      db,
      system,
      services: { ai: () => ({ provider: createFakeProvider(), timeoutMs: 5_000 }) },
      // The workflow cannot be resolved: creating the run fails.
      workflows: {},
    };
    // The tick itself does not fail, and the slot is not lost.
    expect(await automationTick(broken)).toMatchObject({ scheduled: 0 });
    expect(
      (await system.automationPolicy.findUniqueOrThrow({ where: { workspaceId: ctx.workspaceId } }))
        .nextPlanningAt,
    ).toEqual(slot);
    expect(await system.agentRun.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);

    const fixed = { ...broken, workflows: { content_planning: contentPlanningWorkflow } };
    expect(await automationTick(fixed)).toMatchObject({ scheduled: 1 });
    expect(await automationTick(fixed)).toMatchObject({ scheduled: 0 });
    expect(await system.agentRun.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
  });
});

// ── the AI Marketing Manager's content planning ──────────────────────────────

describe("content planning workflow", () => {
  function planning(provider: ReturnType<typeof createFakeProvider> | null) {
    const deps: OrchestrationDeps<PlanningServices> = {
      db,
      services: { ai: () => ({ provider, timeoutMs: 5_000 }) },
      workflows: { content_planning: contentPlanningWorkflow },
    };
    return deps;
  }

  it("observes, plans ideas and reports, without drafting unless the policy allows it", async () => {
    const ctx = await admin();
    const deps = planning(createFakeProvider());
    const { runId } = await startPlanningRun(deps, ctx);
    expect(await executeRun(deps, ctx.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });
    const tasks = await tasksOf(runId);
    expect(tasks.observe?.output).toMatchObject({
      emptyDaysNext7: 7,
      plannedNext7Days: 0,
      drafts: 0,
    });
    expect(tasks.create_drafts).toMatchObject({
      state: "SKIPPED",
      output: { reason: "drafts_not_allowed" },
    });
    const run = await system.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.summary).toMatchObject({ ideas: 7, draftsCreated: 0, contentIds: [] });
    expect(await system.contentItem.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);
    // The AI step went through the AI engine (its usage record and audit).
    expect(
      await system.aiGeneration.count({
        where: { workspaceId: ctx.workspaceId, userId: ctx.userId, status: "SUCCEEDED" },
      }),
    ).toBe(1);
  });

  it("creates at most the allowed number of drafts, once, and never publishes", async () => {
    const ctx = await admin();
    await updateAutomationPolicy(db, ctx, {
      enabled: false,
      planningCadence: "OFF",
      allowDrafts: true,
      maxDraftsPerRun: "2",
    });
    const deps = planning(createFakeProvider());
    const { runId } = await startPlanningRun(deps, ctx);
    expect(await executeRun(deps, ctx.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });
    const items = await system.contentItem.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, status: true, createdByUserId: true, scheduledAt: true },
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({
        status: "DRAFT",
        createdByUserId: ctx.userId,
        scheduledAt: null,
      });
    }
    const run = await system.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.summary).toMatchObject({ draftsCreated: 2 });
    expect([...(run.summary as { contentIds: string[] }).contentIds].sort()).toEqual(
      items.map((item) => item.id).sort(),
    );
    const generation = await system.aiGeneration.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(generation.appliedAt).not.toBeNull();
    expect(
      await system.auditLog.count({
        where: { workspaceId: ctx.workspaceId, action: "automation.drafts_created" },
      }),
    ).toBe(1);
  });

  it("surfaces a missing AI configuration as a failed run, without drafting", async () => {
    const ctx = await admin();
    const deps = planning(null);
    const { runId } = await startPlanningRun(deps, ctx);
    expect(await executeRun(deps, ctx.workspaceId, runId)).toMatchObject({ state: "FAILED" });
    expect(await tasksOf(runId)).toMatchObject({
      observe: { state: "SUCCEEDED" },
      plan_ideas: { state: "FAILED", attempts: 1, failureCode: "ai_not_configured" },
      create_drafts: { state: "CANCELLED" },
      report: { state: "CANCELLED" },
    });
  });

  it("counts only the next 7 days that already have content", async () => {
    const ctx = await admin();
    for (const days of [1, 2]) {
      await system.contentItem.create({
        data: {
          workspaceId: ctx.workspaceId,
          title: `Planned ${String(days)}`,
          type: "POST",
          scheduledAt: new Date(Date.now() + days * 24 * 3_600_000),
          createdByUserId: ctx.userId,
        },
      });
    }
    const deps = planning(createFakeProvider());
    const { runId } = await startPlanningRun(deps, ctx);
    await executeRun(deps, ctx.workspaceId, runId);
    expect((await tasksOf(runId)).observe?.output).toMatchObject({
      emptyDaysNext7: 5,
      plannedNext7Days: 2,
    });
  });
});

// ── rendered activity ────────────────────────────────────────────────────────

function render(locale: "ar" | "en", node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "ar" ? ar : en,
      timeZone: "Asia/Riyadh",
      children: node,
    }),
  );
}

describe("Autopilot views", () => {
  it("shows each step's honest state, the report and links to the drafts", async () => {
    const ctx = await admin();
    await updateAutomationPolicy(db, ctx, {
      enabled: false,
      planningCadence: "OFF",
      allowDrafts: true,
      maxDraftsPerRun: "1",
    });
    const deps: OrchestrationDeps<PlanningServices> = {
      db,
      services: { ai: () => ({ provider: createFakeProvider(), timeoutMs: 5_000 }) },
      workflows: { content_planning: contentPlanningWorkflow },
    };
    const { runId } = await startPlanningRun(deps, ctx);
    await executeRun(deps, ctx.workspaceId, runId);
    const failed = await startPlanningRun(
      { ...deps, services: { ai: () => ({ provider: null, timeoutMs: 5_000 }) } },
      { ...ctx },
    ).catch(() => null);
    expect(failed).toMatchObject({ created: false }); // same person, same minute: deduplicated

    const runs = await system.agentRun.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        workflow: true,
        trigger: true,
        state: true,
        failureCode: true,
        summary: true,
        createdAt: true,
        finishedAt: true,
        requestedBy: { select: { name: true } },
        tasks: {
          orderBy: { createdAt: "asc" },
          select: {
            key: true,
            state: true,
            risk: true,
            attempts: true,
            maxAttempts: true,
            failureCode: true,
          },
        },
      },
    });
    const html = render(
      "en",
      createElement(RunList, {
        slug: "acme",
        locale: "en",
        timeZone: "Asia/Riyadh",
        runs,
        canManage: true,
      }),
    );
    expect(html).toContain('data-state="SUCCEEDED"');
    expect(html).toContain("Review the workspace");
    expect(html).toContain("1 draft created");
    expect(html).toContain("7 ideas planned");
    expect(html.match(/data-testid="automation-draft-link"/g)).toHaveLength(1);
    expect(html).not.toContain("automation-run-continue");
    const failedHtml = render(
      "ar",
      createElement(RunList, {
        slug: "acme",
        locale: "ar",
        timeZone: "Asia/Riyadh",
        canManage: true,
        runs: runs.map((run) => ({
          ...run,
          state: "FAILED" as const,
          failureCode: "plan_ideas:ai_not_configured",
          summary: null,
        })),
      }),
    );
    expect(failedHtml).toContain("الذكاء الاصطناعي غير مُفعّل على هذا الخادم");
    expect(failedHtml).toContain('role="alert"');
  });

  it("lists a run's steps in workflow order (tasks share their creation time)", () => {
    const keys = ["report", "zzz", "observe", "create_drafts", "plan_ideas"];
    expect(
      inStepOrder(
        "content_planning",
        keys.map((key) => ({ key })),
      ).map((task) => task.key),
    ).toEqual(["observe", "plan_ideas", "create_drafts", "report", "zzz"]);
    expect(inStepOrder("unknown", [{ key: "b" }, { key: "a" }]).map((task) => task.key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("states honestly what automation may do", () => {
    const html = render("en", createElement(Capabilities));
    expect(html).toContain('data-capability="publish" data-level="notYet"');
    expect(html).toContain('data-capability="spend" data-level="notYet"');
    expect(html).toContain('data-capability="permissions" data-level="approval"');
    expect(html).toContain('data-capability="plan" data-level="auto"');
  });
});
