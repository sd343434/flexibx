import "server-only";

import { getDb } from "../db/client";
import { getAiEnv } from "../env";
import { resolveTimeZone } from "../marketing/time";
import { requireWorkspaceAccess } from "../tenancy/access";
import { can } from "../tenancy/permissions";

import { listPendingApprovals } from "./approvals";
import { getAutomationPolicy } from "./policy";
import { WORKFLOWS } from "./runtime";

// Page data for the Autopilot page (automation.view): the policy, recent runs with their
// tasks, the approvals waiting for a decision, and the exceptions that need a person.
// The workspace and role come from the session's membership.

export const RUNS_LISTED = 10;

/**
 * A run's tasks in their workflow's step order. Tasks of one run are inserted together and
 * share a creation time, so the stored order says nothing; unknown keys go last.
 */
export function inStepOrder<T extends { readonly key: string }>(
  workflow: string,
  tasks: readonly T[],
): T[] {
  const steps: readonly { readonly key: string }[] =
    (WORKFLOWS as Partial<Record<string, { readonly tasks: readonly { readonly key: string }[] }>>)[
      workflow
    ]?.tasks ?? [];
  const position = (key: string) => {
    const index = steps.findIndex((step) => step.key === key);
    return index === -1 ? steps.length : index;
  };
  return [...tasks].sort((a, b) => position(a.key) - position(b.key) || a.key.localeCompare(b.key));
}

export async function getAutopilotPage(slug: string) {
  const ctx = await requireWorkspaceAccess(slug, "automation.view");
  const db = getDb();
  const [policy, runs, workspace, pendingApprovals] = await Promise.all([
    getAutomationPolicy(db, ctx),
    db.agentRun.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RUNS_LISTED,
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
          where: { workspaceId: ctx.workspaceId },
          orderBy: { key: "asc" },
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
    }),
    db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { timezone: true } }),
    listPendingApprovals(db, ctx),
  ]);
  const ordered = runs.map((run) => ({ ...run, tasks: inStepOrder(run.workflow, run.tasks) }));
  return {
    policy,
    runs: ordered,
    exceptions: ordered.filter((run) => run.state === "FAILED" || run.state === "NEEDS_ATTENTION"),
    pendingApprovals,
    canManage: can(ctx.role, "automation.manage"),
    canApprove: can(ctx.role, "automation.approve"),
    aiConfigured: getAiEnv().AI_PROVIDER !== "disabled",
    timeZone: resolveTimeZone(workspace?.timezone),
  };
}

export type AutopilotPage = Awaited<ReturnType<typeof getAutopilotPage>>;
