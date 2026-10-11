import "server-only";

import { z } from "zod";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";
import { parseInput } from "../validation/parse";

import { firstSlot, type Cadence } from "./planner";

// The workspace's automation policy: configured once by an administrator, enforced by
// the engine on every task. Enabling scheduled autonomy delegates the enabling member's
// authority (re-checked before every task, so revoking their role stops it). The
// emergency stop halts every run of the workspace at once.

export const AUTOMATION_CADENCES = ["OFF", "DAILY", "WEEKLY"] as const;

const formBoolean = z.preprocess((value) => value === "on" || value === true, z.boolean());

export const automationPolicyInputSchema = z.object({
  enabled: formBoolean,
  planningCadence: z.enum(AUTOMATION_CADENCES),
  allowDrafts: formBoolean,
  maxDraftsPerRun: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().int().min(1).max(10),
  ),
});

export type AutomationPolicyInput = z.input<typeof automationPolicyInputSchema>;

async function now(db: GuardedPrismaClient): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  return rows[0]?.now ?? new Date();
}

export async function getAutomationPolicy(db: GuardedPrismaClient, ctx: TenantContext) {
  assertCan(ctx, "automation.view");
  const row = await db.automationPolicy.findUnique({
    where: { workspaceId: ctx.workspaceId },
    select: {
      enabled: true,
      paused: true,
      pausedAt: true,
      planningCadence: true,
      nextPlanningAt: true,
      allowDrafts: true,
      maxDraftsPerRun: true,
      delegateUserId: true,
      delegate: { select: { name: true } },
    },
  });
  return (
    row ?? {
      enabled: false,
      paused: false,
      pausedAt: null,
      planningCadence: "OFF" as const,
      nextPlanningAt: null,
      allowDrafts: false,
      maxDraftsPerRun: 3,
      delegateUserId: null,
      delegate: null,
    }
  );
}

/** Saves the policy (automation.manage). Field names only are audited. */
export async function updateAutomationPolicy(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertCan(ctx, "automation.manage");
  const data = parseInput(automationPolicyInputSchema, input);
  const at = await now(db);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId}::uuid FOR UPDATE`;
    const current = await tx.automationPolicy.findUnique({
      where: { workspaceId: ctx.workspaceId },
      select: {
        enabled: true,
        planningCadence: true,
        nextPlanningAt: true,
        allowDrafts: true,
        maxDraftsPerRun: true,
      },
    });
    const cadence: Cadence = data.enabled ? data.planningCadence : "OFF";
    // A cadence keeps its slot; a new cadence starts one interval from now.
    const nextPlanningAt =
      cadence === "OFF"
        ? null
        : current?.planningCadence === cadence && current.nextPlanningAt !== null
          ? current.nextPlanningAt
          : firstSlot(cadence, at);
    const changed = [
      current?.enabled !== data.enabled ? "enabled" : null,
      current?.planningCadence !== cadence ? "planningCadence" : null,
      current?.allowDrafts !== data.allowDrafts ? "allowDrafts" : null,
      current?.maxDraftsPerRun !== data.maxDraftsPerRun ? "maxDraftsPerRun" : null,
    ].filter((field): field is string => field !== null);
    const values = {
      enabled: data.enabled,
      planningCadence: cadence,
      nextPlanningAt,
      allowDrafts: data.allowDrafts,
      maxDraftsPerRun: data.maxDraftsPerRun,
      // Enabling delegates the authority of the member who enabled it.
      ...(data.enabled ? { delegateUserId: ctx.userId } : {}),
    };
    await tx.automationPolicy.upsert({
      where: { workspaceId: ctx.workspaceId },
      create: { workspaceId: ctx.workspaceId, ...values },
      update: { ...values, version: { increment: 1 } },
    });
    await recordAudit(tx, ctx, {
      action: "automation.policy_updated",
      entityType: "automation_policy",
      entityId: null,
      metadata: { changed, enabled: data.enabled, planningCadence: cadence },
    });
  });
}

/** The emergency stop (automation.manage): no task of any run starts while it is set. */
export async function setAutomationPaused(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  paused: boolean,
): Promise<void> {
  assertCan(ctx, "automation.manage");
  const at = await now(db);
  await db.$transaction(async (tx) => {
    // Exclusive workspace lock: a task claim (which holds it shared) either finished
    // before the stop or sees it.
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId}::uuid FOR UPDATE`;
    await tx.automationPolicy.upsert({
      where: { workspaceId: ctx.workspaceId },
      create: { workspaceId: ctx.workspaceId, paused, pausedAt: paused ? at : null },
      update: { paused, pausedAt: paused ? at : null, version: { increment: 1 } },
    });
    await recordAudit(tx, ctx, {
      action: paused ? "automation.paused" : "automation.resumed",
      entityType: "automation_policy",
      entityId: null,
    });
  });
}
