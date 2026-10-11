import "server-only";

import { AppError } from "../errors/app-error";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { createRun, policySnapshot, type OrchestrationDeps } from "./engine";
import { CONTENT_PLANNING_WORKFLOW } from "./workflows/content-planning";

// Starting a run by hand ("Run planning now"). The run acts with the requesting
// administrator's authority; the emergency stop refuses new runs while it is set.

export async function startPlanningRun<S>(
  deps: OrchestrationDeps<S>,
  ctx: TenantContext,
): Promise<{ readonly runId: string; readonly created: boolean }> {
  assertCan(ctx, "automation.manage");
  const policy = await policySnapshot(deps.db, ctx.workspaceId);
  if (policy.paused) {
    throw new AppError("CONFLICT", {
      message: "Automation is stopped",
      fields: [{ path: "automation", code: "automation_paused" }],
    });
  }
  // One manual run per person per minute (a double click starts one run).
  const minute = new Date().toISOString().slice(0, 16);
  return createRun(
    deps,
    { workspaceId: ctx.workspaceId, requestedByUserId: ctx.userId },
    CONTENT_PLANNING_WORKFLOW,
    "MANUAL",
    `manual:${CONTENT_PLANNING_WORKFLOW}:${ctx.userId}:${minute}`,
  );
}
