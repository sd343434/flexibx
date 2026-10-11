import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import {
  createRun,
  executeRun,
  recoverStaleTasks,
  type ExecuteOutcome,
  type OrchestrationDeps,
} from "./engine";
import { nextSlot } from "./planner";
import { CONTENT_PLANNING_WORKFLOW } from "./workflows/content-planning";

// One scheduler tick, meant to be called every few minutes by an external scheduler (no
// scheduler is configured yet; `pnpm automation:tick` runs one tick by hand):
//   1. recover tasks whose runner died (lease expired);
//   2. start the scheduled planning run of every workspace whose slot is due (enabled,
//      not stopped) — each slot at most once (idempotency key + compare-and-set);
//   3. advance active runs, each in a bounded number of task executions.
// Paused workspaces are skipped entirely; their runs resume after the stop is lifted.

export interface TickSummary {
  readonly recovered: number;
  readonly scheduled: number;
  readonly skippedNoDelegate: number;
  readonly executed: readonly ExecuteOutcome[];
}

export async function automationTick<S>(
  deps: OrchestrationDeps<S> & { readonly system: PrismaClient },
  options: { readonly limit?: number; readonly maxTasksPerRun?: number } = {},
): Promise<TickSummary> {
  const { system } = deps;
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const rows = await system.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  const now = rows[0]?.now ?? new Date();

  const recovered = await recoverStaleTasks(system, now);

  let scheduled = 0;
  let skippedNoDelegate = 0;
  const due = await system.automationPolicy.findMany({
    where: {
      enabled: true,
      paused: false,
      planningCadence: { not: "OFF" },
      nextPlanningAt: { lte: now },
      workspace: { deletedAt: null },
    },
    select: {
      workspaceId: true,
      planningCadence: true,
      nextPlanningAt: true,
      delegateUserId: true,
      version: true,
    },
    orderBy: { nextPlanningAt: "asc" },
    take: limit,
  });
  for (const policy of due) {
    if (policy.nextPlanningAt === null) continue;
    // Claim the slot: only one tick advances it (compare-and-set on the version).
    const advanced = await system.automationPolicy.updateMany({
      where: { workspaceId: policy.workspaceId, version: policy.version },
      data: {
        nextPlanningAt: nextSlot(policy.nextPlanningAt, policy.planningCadence, now),
        version: { increment: 1 },
      },
    });
    if (advanced.count === 0) continue;
    if (policy.delegateUserId === null) {
      skippedNoDelegate += 1;
      continue;
    }
    const { created } = await createRun(
      deps,
      { workspaceId: policy.workspaceId, requestedByUserId: policy.delegateUserId },
      CONTENT_PLANNING_WORKFLOW,
      "SCHEDULE",
      `schedule:${CONTENT_PLANNING_WORKFLOW}:${policy.nextPlanningAt.toISOString()}`,
    );
    if (created) scheduled += 1;
  }

  const active = await system.agentRun.findMany({
    where: {
      state: { in: ["PENDING", "RUNNING"] },
      workspace: { deletedAt: null, automationPolicy: { isNot: { paused: true } } },
    },
    select: { id: true, workspaceId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  const executed: ExecuteOutcome[] = [];
  for (const run of active) {
    try {
      executed.push(
        await executeRun(deps, run.workspaceId, run.id, {
          maxTasks: options.maxTasksPerRun ?? 10,
        }),
      );
    } catch (error) {
      deps.logger?.error({ err: error, runId: run.id }, "Automation run failed to advance");
    }
  }
  return { recovered, scheduled, skippedNoDelegate, executed };
}
