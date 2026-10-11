import "server-only";

import { after } from "next/server";
import { z } from "zod";

import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { logger } from "../logger";
import { requireWorkspaceAccess } from "../tenancy/access";
import { assertCan } from "../tenancy/permissions";

import { decideApproval } from "./approvals";
import { cancelRun, executeRun } from "./engine";
import { AUTOMATION_CADENCES, setAutomationPaused, updateAutomationPolicy } from "./policy";
import { startPlanningRun } from "./runs";
import { getOrchestrationDeps } from "./runtime";

// Server actions for the AI Marketing Manager (Autopilot). Order: strict input (unknown
// fields refused) → session + membership + permission (automation.manage for every
// change; automation.approve for decisions) → the service, which re-checks it. The workspace comes from the
// member's own membership, never from the input.

const slug = z.string().min(1).max(100);
const runId = z.string().min(1).max(100);

/** Advances a run after the response is sent (bounded; the scheduler continues later). */
function scheduleAdvance(workspaceId: string, id: string) {
  after(async () => {
    try {
      await executeRun(getOrchestrationDeps(), workspaceId, id);
    } catch (error) {
      logger.error({ err: error, runId: id }, "Automation run failed to advance");
    }
  });
}

export const updateAutomationPolicyAction = withAction({
  name: "automation.policy",
  input: z.strictObject({
    slug,
    enabled: z.boolean(),
    planningCadence: z.enum(AUTOMATION_CADENCES),
    allowDrafts: z.boolean(),
    maxDraftsPerRun: z.string().max(4),
  }),
  handler: async ({ slug: workspace, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "automation.manage");
    await updateAutomationPolicy(getDb(), ctx, input);
    return { saved: true };
  },
});

export const setAutomationPausedAction = withAction({
  name: "automation.pause",
  input: z.strictObject({ slug, paused: z.boolean() }),
  handler: async ({ slug: workspace, paused }) => {
    const ctx = await requireWorkspaceAccess(workspace, "automation.manage");
    await setAutomationPaused(getDb(), ctx, paused);
    return { paused };
  },
});

export const startPlanningRunAction = withAction({
  name: "automation.run",
  input: z.strictObject({ slug }),
  handler: async ({ slug: workspace }) => {
    const ctx = await requireWorkspaceAccess(workspace, "automation.manage");
    const { runId: id } = await startPlanningRun(getOrchestrationDeps(), ctx);
    scheduleAdvance(ctx.workspaceId, id);
    return { runId: id };
  },
});

/** "Continue": one more bounded step of an active run (no scheduler runs yet). */
export const advanceRunAction = withAction({
  name: "automation.advance",
  input: z.strictObject({ slug, runId }),
  handler: async ({ slug: workspace, runId: id }) => {
    const ctx = await requireWorkspaceAccess(workspace, "automation.manage");
    assertCan(ctx, "automation.manage");
    const outcome = await executeRun(getOrchestrationDeps(), ctx.workspaceId, id);
    return { status: outcome.status };
  },
});

export const cancelRunAction = withAction({
  name: "automation.cancel",
  input: z.strictObject({ slug, runId }),
  handler: async ({ slug: workspace, runId: id }) => {
    const ctx = await requireWorkspaceAccess(workspace, "automation.manage");
    await cancelRun(getDb(), ctx, id);
    return { cancelled: true };
  },
});

/** Approve or reject one waiting task (automation.approve), then let the run move on. */
export const decideApprovalAction = withAction({
  name: "automation.decide",
  input: z.strictObject({
    slug,
    taskId: z.string().min(1).max(100),
    decision: z.enum(["APPROVED", "REJECTED"]),
    snapshotHash: z.string().max(64),
    note: z.string().max(2_000),
  }),
  handler: async ({ slug: workspace, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "automation.approve");
    const { runId: id } = await decideApproval(getDb(), ctx, input);
    scheduleAdvance(ctx.workspaceId, id);
    return { decided: input.decision };
  },
});
