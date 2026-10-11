import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { AgentRunTrigger } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import type { Logger } from "../logger";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan, can } from "../tenancy/permissions";
import { isRole } from "../tenancy/roles";

import { buildSnapshot, snapshotHash, type ApprovalSnapshot } from "./approval-snapshot";
import { backoffMs, definitionProblems, planRun } from "./planner";
import {
  TaskError,
  type AutomationPolicySnapshot,
  type DescribeContext,
  type TaskDefinition,
  type TaskResult,
  type WorkflowDefinition,
} from "./workflow";

// The shared orchestration engine. Runs and tasks are rows, so work survives restarts:
// any process can pick a run up, a lease keeps two runners off the same task, a crashed
// runner's task is recovered when its lease expires, and every step is bounded by a
// timeout and a number of attempts. Before every task the engine re-reads the policy
// (emergency stop) and re-checks the authority the run acts with. Tasks that would act
// outside Flexibx or spend money never start on their own: they describe their exact
// action, wait for a person to approve it (approvals.ts), and run once per approval —
// only if the approver still may approve and the action is still the one approved.

export interface OrchestrationDeps<S = unknown> {
  readonly db: GuardedPrismaClient;
  readonly services: S;
  /** Known workflows by id. */
  readonly workflows: Readonly<Record<string, WorkflowDefinition<S>>>;
  readonly logger?: Logger;
}

const ACTIVE_RUN_STATES = ["PENDING", "RUNNING"] as const;
/** A task's lease outlives its timeout by this much (time to record the result). */
const LEASE_MARGIN_MS = 60_000;

const notFound = () => new AppError("NOT_FOUND", { metadata: { resource: "agent_run" } });

async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  const now = rows[0]?.now;
  if (now === undefined) throw new Error("Could not read the database clock");
  return now;
}

function workflowOf<S>(deps: OrchestrationDeps<S>, id: string): WorkflowDefinition<S> {
  const workflow = deps.workflows[id];
  if (workflow === undefined) throw new Error(`Unknown workflow ${id}`);
  return workflow;
}

/** The policy as the engine sees it (no row = nothing allowed beyond manual runs). */
export async function policySnapshot(
  db: Db,
  workspaceId: string,
): Promise<AutomationPolicySnapshot> {
  const row = await db.automationPolicy.findUnique({
    where: { workspaceId },
    select: { enabled: true, paused: true, allowDrafts: true, maxDraftsPerRun: true },
  });
  return row ?? { enabled: false, paused: false, allowDrafts: false, maxDraftsPerRun: 3 };
}

/**
 * Creates a run with all its tasks (PENDING). The idempotency key makes a schedule slot
 * or a manual request create at most one run; a repeat returns the existing run.
 */
export async function createRun<S>(
  deps: OrchestrationDeps<S>,
  scope: { readonly workspaceId: string; readonly requestedByUserId: string },
  workflowId: string,
  trigger: AgentRunTrigger,
  idempotencyKey: string,
): Promise<{ readonly runId: string; readonly created: boolean }> {
  const workflow = workflowOf(deps, workflowId);
  const problems = [
    ...definitionProblems(workflow.tasks),
    // A consequential task must say what it would do, or it could never be approved.
    ...workflow.tasks
      .filter((task) => task.risk !== "INTERNAL" && task.describe === undefined)
      .map((task) => `undescribed:${task.key}`),
  ];
  if (problems.length > 0) throw new Error(`Invalid workflow ${workflowId}: ${problems.join(" ")}`);
  try {
    return await deps.db.$transaction(async (tx) => {
      const run = await tx.agentRun.create({
        data: {
          workspaceId: scope.workspaceId,
          workflow: workflow.id,
          trigger,
          requestedByUserId: scope.requestedByUserId,
          idempotencyKey,
        },
        select: { id: true },
      });
      await tx.agentTask.createMany({
        data: workflow.tasks.map((task) => ({
          workspaceId: scope.workspaceId,
          runId: run.id,
          key: task.key,
          handler: `${workflow.id}.${task.key}`,
          risk: task.risk,
          dependsOn: [...task.dependsOn],
          maxAttempts: task.maxAttempts,
          timeoutMs: task.timeoutMs,
        })),
      });
      await recordAudit(
        tx,
        { workspaceId: scope.workspaceId, userId: null },
        {
          action: "automation.run_created",
          entityType: "agent_run",
          entityId: run.id,
          metadata: {
            workflow: workflow.id,
            trigger,
            tasks: workflow.tasks.length,
            actingFor: scope.requestedByUserId,
          },
        },
      );
      return { runId: run.id, created: true };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await deps.db.agentRun.findUnique({
        where: {
          workspaceId_idempotencyKey: { workspaceId: scope.workspaceId, idempotencyKey },
        },
        select: { id: true },
      });
      if (existing !== null) return { runId: existing.id, created: false };
    }
    throw error;
  }
}

/**
 * A current member of a live workspace holding `action` (default: running automation —
 * the authority a run acts with), or null.
 */
export async function resolveMember(
  db: Db,
  workspaceId: string,
  userId: string | null,
  action: "automation.manage" | "automation.approve" = "automation.manage",
): Promise<TenantContext | null> {
  if (userId === null) return null;
  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (workspace === null) return null;
  const membership = await db.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { role: true },
  });
  if (membership === null || !isRole(membership.role)) return null;
  if (!can(membership.role, action)) return null;
  return { userId, workspaceId, role: membership.role };
}

export type ExecuteOutcome =
  | { readonly status: "finished"; readonly state: string }
  | { readonly status: "paused" | "waiting" | "yielded" | "not_found" };

async function finishRun(
  db: Db,
  workspaceId: string,
  runId: string,
  state: "SUCCEEDED" | "FAILED" | "NEEDS_ATTENTION" | "CANCELLED",
  failureCode: string | null,
  summary: Prisma.InputJsonValue | undefined,
): Promise<void> {
  const terminal = state !== "NEEDS_ATTENTION";
  const updated = await db.agentRun.updateMany({
    where: { id: runId, workspaceId, state: { in: [...ACTIVE_RUN_STATES] } },
    data: {
      state,
      failureCode,
      finishedAt: terminal ? new Date() : null,
      ...(summary === undefined ? {} : { summary }),
    },
  });
  if (updated.count === 0) return;
  await recordAudit(
    db,
    { workspaceId, userId: null },
    {
      action: "automation.run_finished",
      entityType: "agent_run",
      entityId: runId,
      metadata: { state, failureCode },
    },
  );
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TaskError("timeout", true));
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Advances one run as far as it can go in a bounded number of task executions. Safe to
 * call repeatedly and from several processes: each task is claimed with a lease, and
 * every result is written only by the runner that still holds that lease.
 */
export async function executeRun<S>(
  deps: OrchestrationDeps<S>,
  workspaceId: string,
  runId: string,
  options: { readonly maxTasks?: number } = {},
): Promise<ExecuteOutcome> {
  const { db } = deps;
  if (!isUuid(runId) || !isUuid(workspaceId)) return { status: "not_found" };
  for (let step = 0; step < (options.maxTasks ?? 10); step += 1) {
    const run = await db.agentRun.findFirst({
      where: { id: runId, workspaceId },
      select: { state: true, workflow: true, requestedByUserId: true },
    });
    if (run === null) return { status: "not_found" };
    if (run.state !== "PENDING" && run.state !== "RUNNING") {
      return { status: "finished", state: run.state };
    }
    const workflow = workflowOf(deps, run.workflow);
    const policy = await policySnapshot(db, workspaceId);
    // Emergency stop: nothing starts until it is lifted (the run resumes afterwards).
    if (policy.paused) return { status: "paused" };

    const now = await dbNow(db);
    const tasks = await db.agentTask.findMany({
      where: { workspaceId, runId },
      select: {
        id: true,
        key: true,
        state: true,
        dependsOn: true,
        runAfter: true,
        failureCode: true,
        attempts: true,
        output: true,
        approvalRound: true,
        approvalHash: true,
        approvedDecisionId: true,
      },
    });
    const plan = planRun(tasks, now);
    if (plan.cancel.length > 0) {
      await db.agentTask.updateMany({
        where: { workspaceId, runId, key: { in: [...plan.cancel] }, state: "PENDING" },
        data: { state: "CANCELLED", finishedAt: now, approvedDecisionId: null },
      });
    }
    if (plan.outcome !== null) {
      const summaryTask = tasks.find((task) => task.key === workflow.summaryTask);
      await finishRun(
        db,
        workspaceId,
        runId,
        plan.outcome.state,
        plan.outcome.state === "SUCCEEDED" ? null : plan.outcome.failureCode,
        plan.outcome.state === "SUCCEEDED" &&
          summaryTask !== undefined &&
          summaryTask.output !== null
          ? summaryTask.output
          : undefined,
      );
      return { status: "finished", state: plan.outcome.state };
    }
    const nextKey = plan.ready[0];
    if (nextKey === undefined) return { status: "waiting" };

    const actor = await resolveMember(db, workspaceId, run.requestedByUserId);
    if (actor === null) {
      await db.agentTask.updateMany({
        where: { workspaceId, runId, state: "PENDING" },
        data: { state: "CANCELLED", finishedAt: now, approvedDecisionId: null },
      });
      await finishRun(db, workspaceId, runId, "NEEDS_ATTENTION", "actor_no_access", undefined);
      return { status: "finished", state: "NEEDS_ATTENTION" };
    }

    const definition = workflow.tasks.find((task) => task.key === nextKey);
    const row = tasks.find((task) => task.key === nextKey);
    if (definition === undefined || row === undefined) throw new Error(`Unknown task ${nextKey}`);

    const inputs = Object.fromEntries(
      definition.dependsOn.map((dep) => [dep, tasks.find((task) => task.key === dep)?.output]),
    );

    // Consequential work runs only on a valid, unused approval of exactly this action.
    let grant: { readonly decisionId: string; readonly hash: string } | null = null;
    if (definition.risk !== "INTERNAL") {
      const gate = await approvalGate(deps, workflow.id, definition, row, {
        db,
        runId,
        taskKey: nextKey,
        actor,
        policy,
        inputs,
        services: deps.services,
      });
      if (gate === null) continue;
      grant = gate;
    }

    const token = randomUUID();
    const claimed = await db.$transaction(async (tx) => {
      // Lock order (everywhere): workspace → run → task. The emergency stop takes the
      // workspace row exclusively, so no claim slips past a stop being set.
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR SHARE`;
      if ((await policySnapshot(tx, workspaceId)).paused) return false;
      const live = await tx.$queryRaw<{ state: string }[]>`
        SELECT state::text AS state FROM agent_runs
         WHERE id = ${runId}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
      if (!(ACTIVE_RUN_STATES as readonly string[]).includes(live[0]?.state ?? "")) return false;
      const updated = await tx.agentTask.updateMany({
        where: {
          id: row.id,
          workspaceId,
          state: "PENDING",
          runAfter: { lte: now },
          attempts: { lt: definition.maxAttempts },
          // The grant is used up by this claim: one approval, one execution.
          ...(grant === null ? {} : { approvedDecisionId: grant.decisionId }),
        },
        data: {
          state: "RUNNING",
          attempts: { increment: 1 },
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + definition.timeoutMs + LEASE_MARGIN_MS),
          startedAt: now,
          approvedDecisionId: null,
        },
      });
      if (updated.count === 0) return false;
      await tx.agentRun.updateMany({
        where: { id: runId, workspaceId, state: "PENDING" },
        data: { state: "RUNNING", startedAt: now },
      });
      if (grant !== null) {
        await recordAudit(
          tx,
          { workspaceId, userId: null },
          {
            action: "automation.approval_used",
            entityType: "agent_run",
            entityId: runId,
            metadata: { task: nextKey, decisionId: grant.decisionId, snapshotHash: grant.hash },
          },
        );
      }
      return true;
    });
    if (!claimed) continue; // stopped, cancelled, or another runner took it

    await runTask(deps, definition, {
      workspaceId,
      runId,
      taskId: row.id,
      token,
      attempt: row.attempts + 1,
      actor,
      policy,
      inputs,
    });
  }
  return { status: "yielded" };
}

interface TaskRow {
  readonly id: string;
  readonly key: string;
  readonly approvalRound: number;
  readonly approvalHash: string | null;
  readonly approvedDecisionId: string | null;
}

/** The task's described action, or null when it cannot be described validly. */
async function describeAction<S>(
  workflowId: string,
  definition: TaskDefinition<S>,
  context: DescribeContext<S>,
): Promise<{ readonly snapshot: ApprovalSnapshot; readonly hash: string } | { code: string }> {
  if (definition.describe === undefined) return { code: "invalid_action" };
  const describe = definition.describe;
  try {
    const description = await withTimeout(() => describe(context), definition.timeoutMs);
    const built = buildSnapshot(
      { workflow: workflowId, task: definition.key, risk: definition.risk },
      description,
    );
    return built.ok
      ? { snapshot: built.snapshot, hash: snapshotHash(built.snapshot) }
      : { code: "invalid_action" };
  } catch (error) {
    return { code: error instanceof TaskError ? error.code.slice(0, 60) : "describe_failed" };
  }
}

/**
 * The approval gate of an EXTERNAL/SPEND task that is ready to run. Returns the grant to
 * use when the task holds an unused approval of exactly its current action by a member
 * who may still approve; otherwise (re)asks for approval — or fails the task when its
 * action cannot be described — and returns null.
 */
async function approvalGate<S>(
  deps: OrchestrationDeps<S>,
  workflowId: string,
  definition: TaskDefinition<S>,
  row: TaskRow,
  context: DescribeContext<S>,
): Promise<{ readonly decisionId: string; readonly hash: string } | null> {
  const { db } = deps;
  const workspaceId = context.actor.workspaceId;
  const described = await describeAction(workflowId, definition, context);
  if ("code" in described) {
    const failed = await db.agentTask.updateMany({
      where: { id: row.id, workspaceId, state: "PENDING" },
      data: {
        state: "FAILED",
        failureCode: described.code,
        finishedAt: new Date(),
        approvedDecisionId: null,
      },
    });
    if (failed.count === 1) {
      await recordAudit(
        db,
        { workspaceId, userId: null },
        {
          action: "automation.task_failed",
          entityType: "agent_run",
          entityId: context.runId,
          metadata: { task: definition.key, code: described.code, attempt: 0, willRetry: false },
        },
      );
    }
    return null;
  }

  let staleReason: "approver_no_access" | "action_changed" | null = null;
  if (row.approvedDecisionId !== null) {
    const decision = await db.agentTaskApproval.findFirst({
      where: { id: row.approvedDecisionId, workspaceId, taskId: row.id },
      select: { decision: true, round: true, snapshotHash: true, decidedByUserId: true },
    });
    const valid =
      decision !== null &&
      decision.decision === "APPROVED" &&
      decision.round === row.approvalRound &&
      decision.snapshotHash === row.approvalHash;
    const approver =
      valid && decision.decidedByUserId !== null
        ? await resolveMember(db, workspaceId, decision.decidedByUserId, "automation.approve")
        : null;
    if (approver === null) staleReason = "approver_no_access";
    else if (decision?.snapshotHash !== described.hash) staleReason = "action_changed";
    else return { decisionId: row.approvedDecisionId, hash: described.hash };
  }

  // Ask (again): a new round with the action as it stands now; any old grant is void.
  const round = row.approvalRound + 1;
  const asked = await db.agentTask.updateMany({
    where: { id: row.id, workspaceId, state: "PENDING", approvalRound: row.approvalRound },
    data: {
      state: "NEEDS_APPROVAL",
      approvalRound: round,
      approvalRequest: described.snapshot as unknown as Prisma.InputJsonValue,
      approvalHash: described.hash,
      approvedDecisionId: null,
      failureCode: "approval_required",
      finishedAt: null,
    },
  });
  if (asked.count === 1) {
    const { snapshot } = described;
    await recordAudit(
      db,
      { workspaceId, userId: null },
      {
        action: staleReason === null ? "automation.approval_required" : "automation.approval_stale",
        entityType: "agent_run",
        entityId: context.runId,
        metadata: {
          task: definition.key,
          risk: definition.risk,
          round,
          action: snapshot.action,
          snapshotHash: described.hash,
          amountMinor: snapshot.amount?.minor ?? null,
          currency: snapshot.amount?.currency ?? null,
          ...(staleReason === null ? {} : { reason: staleReason, previousHash: row.approvalHash }),
        },
      },
    );
  }
  return null;
}

async function runTask<S>(
  deps: OrchestrationDeps<S>,
  definition: TaskDefinition<S>,
  claim: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly token: string;
    readonly attempt: number;
    readonly actor: TenantContext;
    readonly policy: AutomationPolicySnapshot;
    readonly inputs: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const { db } = deps;
  const mine = {
    id: claim.taskId,
    workspaceId: claim.workspaceId,
    state: "RUNNING" as const,
    leaseToken: claim.token,
  };
  let result: TaskResult;
  try {
    result = await withTimeout(
      (signal) =>
        definition.run({
          db,
          runId: claim.runId,
          taskKey: definition.key,
          actor: claim.actor,
          policy: claim.policy,
          inputs: claim.inputs,
          signal,
          services: deps.services,
        }),
      definition.timeoutMs,
    );
  } catch (error) {
    const code = error instanceof TaskError ? error.code : "unexpected";
    const retryable = error instanceof TaskError ? error.retryable : true;
    if (!(error instanceof TaskError)) {
      deps.logger?.error({ err: error, task: definition.key }, "Automation task failed");
    }
    const retry = retryable && claim.attempt < definition.maxAttempts;
    const now = new Date();
    // A result is recorded only while this runner still holds the lease (a cancelled
    // run's late results are discarded).
    const updated = await db.agentTask.updateMany({
      where: mine,
      data: retry
        ? {
            state: "PENDING",
            failureCode: code.slice(0, 60),
            runAfter: new Date(now.getTime() + backoffMs(claim.attempt)),
            leaseToken: null,
            leaseExpiresAt: null,
          }
        : {
            state: "FAILED",
            failureCode: code.slice(0, 60),
            finishedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
    });
    if (updated.count === 1) {
      await recordAudit(
        db,
        { workspaceId: claim.workspaceId, userId: null },
        {
          action: "automation.task_failed",
          entityType: "agent_run",
          entityId: claim.runId,
          metadata: { task: definition.key, code, attempt: claim.attempt, willRetry: retry },
        },
      );
    }
    return;
  }
  await db.agentTask.updateMany({
    where: mine,
    data: {
      state: result.status === "skipped" ? "SKIPPED" : "SUCCEEDED",
      output: result.output as Prisma.InputJsonValue,
      failureCode: null,
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

/**
 * Tasks whose runner died (the lease expired while RUNNING): back to PENDING for another
 * attempt, or FAILED when no attempt is left — and always FAILED (`outcome_unknown`) for
 * an EXTERNAL/SPEND task. Called by the scheduler before each tick.
 */
export async function recoverStaleTasks(system: PrismaClient, now: Date): Promise<number> {
  const stale = await system.agentTask.findMany({
    where: { state: "RUNNING", leaseExpiresAt: { lte: now } },
    select: { id: true, attempts: true, maxAttempts: true, risk: true },
    take: 200,
  });
  for (const task of stale) {
    // An external action whose runner died may or may not have happened: never replay it
    // (not even through a new approval) — a person has to look.
    const unknown = task.risk !== "INTERNAL";
    const exhausted = unknown || task.attempts >= task.maxAttempts;
    await system.agentTask.updateMany({
      where: { id: task.id, state: "RUNNING", leaseExpiresAt: { lte: now } },
      data: exhausted
        ? {
            state: "FAILED",
            failureCode: unknown ? "outcome_unknown" : "lease_expired",
            finishedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          }
        : {
            state: "PENDING",
            failureCode: "lease_expired",
            runAfter: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
    });
  }
  return stale.length;
}

/** Stops a run: nothing more starts; a task still running has its result discarded. */
export async function cancelRun(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runId: string,
): Promise<void> {
  assertCan(ctx, "automation.manage");
  if (!isUuid(runId)) throw notFound();
  await db.$transaction(async (tx) => {
    const updated = await tx.agentRun.updateMany({
      where: {
        id: runId,
        workspaceId: ctx.workspaceId,
        state: { in: ["PENDING", "RUNNING", "NEEDS_ATTENTION"] },
      },
      data: { state: "CANCELLED", finishedAt: new Date(), failureCode: null },
    });
    if (updated.count === 0) {
      const exists = await tx.agentRun.count({
        where: { id: runId, workspaceId: ctx.workspaceId },
      });
      throw exists === 0
        ? notFound()
        : new AppError("CONFLICT", { metadata: { resource: "agent_run" } });
    }
    await tx.agentTask.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        runId,
        state: { in: ["PENDING", "RUNNING", "NEEDS_APPROVAL"] },
      },
      // Any unused grant dies with the run: a later approval or claim finds nothing.
      data: {
        state: "CANCELLED",
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        approvedDecisionId: null,
      },
    });
    await recordAudit(tx, ctx, {
      action: "automation.run_cancelled",
      entityType: "agent_run",
      entityId: runId,
    });
  });
}
