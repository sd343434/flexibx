import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";
import { parseInput } from "../validation/parse";

import { readSnapshot } from "./approval-snapshot";
import { resolveMember } from "./engine";

// Human decisions on automation tasks that act outside Flexibx or spend money. A
// decision answers one approval request (one round) of one task, records the exact
// action decided on, and is never changed. Approving grants that task one execution of
// that action; the engine re-checks the approver and the action before using it.
// Rejecting fails the task, which ends the run through the normal state machine.

export const APPROVAL_DECISIONS = ["APPROVED", "REJECTED"] as const;

export const approvalDecisionSchema = z.object({
  taskId: z.string().refine(isUuid),
  decision: z.enum(APPROVAL_DECISIONS),
  /** The hash of the action the person was shown: a different action is not decided. */
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(500).optional(),
  ),
});

export type ApprovalDecisionInput = z.input<typeof approvalDecisionSchema>;

const notFound = () => new AppError("NOT_FOUND", { metadata: { resource: "agent_task" } });
const conflict = (code: "approval_not_pending" | "approval_changed") =>
  new AppError("CONFLICT", {
    message: code === "approval_changed" ? "The action changed" : "Nothing to decide",
    fields: [{ path: "approval", code }],
  });

/**
 * Records a decision (automation.approve: owners and admins who are current members).
 * Refused unless the task is still waiting for exactly the action the person saw and its
 * run is still open — so duplicate, late (after cancellation) or stale decisions change
 * nothing.
 */
export async function decideApproval(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: unknown,
): Promise<{ readonly runId: string; readonly decisionId: string }> {
  assertCan(ctx, "automation.approve");
  const data = parseInput(approvalDecisionSchema, input);
  try {
    return await db.$transaction(async (tx) => {
      // Membership as of now, inside the transaction (a role change since the page was
      // loaded counts).
      if ((await resolveMember(tx, ctx.workspaceId, ctx.userId, "automation.approve")) === null) {
        throw new AppError("FORBIDDEN", { metadata: { action: "automation.approve" } });
      }
      const task = await tx.agentTask.findFirst({
        where: { id: data.taskId, workspaceId: ctx.workspaceId },
        select: { runId: true },
      });
      if (task === null) throw notFound();
      // Lock order: run → task (as cancellation and the engine's claim).
      const run = await tx.$queryRaw<{ state: string; failure_code: string | null }[]>`
        SELECT state::text AS state, failure_code FROM agent_runs
         WHERE id = ${task.runId}::uuid AND workspace_id = ${ctx.workspaceId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${data.taskId}::uuid FOR UPDATE`;
      const current = await tx.agentTask.findFirst({
        where: { id: data.taskId, workspaceId: ctx.workspaceId },
        select: {
          key: true,
          state: true,
          risk: true,
          approvalRound: true,
          approvalRequest: true,
          approvalHash: true,
        },
      });
      const runState = run[0]?.state;
      if (
        current?.state !== "NEEDS_APPROVAL" ||
        runState === undefined ||
        !["PENDING", "RUNNING", "NEEDS_ATTENTION"].includes(runState)
      ) {
        throw conflict("approval_not_pending");
      }
      if (current.approvalHash !== data.snapshotHash) throw conflict("approval_changed");
      const snapshot = readSnapshot(current.approvalRequest);
      if (snapshot === null) throw conflict("approval_changed");

      const decision = await tx.agentTaskApproval.create({
        data: {
          workspaceId: ctx.workspaceId,
          runId: task.runId,
          taskId: data.taskId,
          round: current.approvalRound,
          decision: data.decision,
          decidedByUserId: ctx.userId,
          note: data.note ?? null,
          risk: snapshot.risk,
          snapshot: current.approvalRequest as Prisma.InputJsonValue,
          snapshotHash: current.approvalHash,
          amountMinor: snapshot.amount === null ? null : BigInt(snapshot.amount.minor),
          currency: snapshot.amount?.currency ?? null,
        },
        select: { id: true },
      });
      const at = new Date();
      await tx.agentTask.updateMany({
        where: { id: data.taskId, workspaceId: ctx.workspaceId, state: "NEEDS_APPROVAL" },
        data:
          data.decision === "APPROVED"
            ? {
                state: "PENDING",
                approvedDecisionId: decision.id,
                runAfter: at,
                failureCode: null,
                finishedAt: null,
              }
            : { state: "FAILED", failureCode: "approval_rejected", finishedAt: at },
      });
      // The run moves again: an approval lets the task run, a rejection lets the engine
      // fail the run (dependents cancelled) on its next pass.
      if (runState === "NEEDS_ATTENTION") {
        await tx.agentRun.updateMany({
          where: { id: task.runId, workspaceId: ctx.workspaceId, state: "NEEDS_ATTENTION" },
          data: { state: "RUNNING", failureCode: null },
        });
      }
      await recordAudit(tx, ctx, {
        action:
          data.decision === "APPROVED"
            ? "automation.approval_granted"
            : "automation.approval_rejected",
        entityType: "agent_run",
        entityId: task.runId,
        metadata: {
          task: current.key,
          decisionId: decision.id,
          round: current.approvalRound,
          risk: snapshot.risk,
          snapshotHash: current.approvalHash,
          snapshot: current.approvalRequest,
          amountMinor: snapshot.amount?.minor ?? null,
          currency: snapshot.amount?.currency ?? null,
          hasNote: data.note !== undefined,
        },
      });
      return { runId: task.runId, decisionId: decision.id };
    });
  } catch (error) {
    // Two decisions on the same round raced: the second is a duplicate.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw conflict("approval_not_pending");
    }
    throw error;
  }
}

export const PENDING_APPROVALS_LISTED = 20;

/** Tasks waiting for a decision, oldest first, with the exact action (automation.view). */
export async function listPendingApprovals(db: Db, ctx: TenantContext) {
  assertCan(ctx, "automation.view");
  const rows = await db.agentTask.findMany({
    where: { workspaceId: ctx.workspaceId, state: "NEEDS_APPROVAL" },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: PENDING_APPROVALS_LISTED,
    select: {
      id: true,
      runId: true,
      key: true,
      approvalRound: true,
      approvalRequest: true,
      approvalHash: true,
      updatedAt: true,
    },
  });
  return rows.flatMap((row) => {
    const snapshot = readSnapshot(row.approvalRequest);
    if (snapshot === null || row.approvalHash === null) return [];
    return [
      {
        taskId: row.id,
        runId: row.runId,
        key: row.key,
        round: row.approvalRound,
        requestedAt: row.updatedAt,
        snapshot,
        snapshotHash: row.approvalHash,
      },
    ];
  });
}

export type PendingApproval = Awaited<ReturnType<typeof listPendingApprovals>>[number];
