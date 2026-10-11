import { z } from "zod";

import { recordAudit } from "../audit/audit-log";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";
import { parseInput } from "../validation/parse";

import { formatMajor, parseBudget } from "./planner-math";

// Workspace spending limits, per currency. A campaign is never created or activated
// without one: the plan's total budget must be within the plan cap, and its average daily
// budget within the daily cap (both checked again by the executor right before any
// external write). Only owners and admins (ads.manage) set them; every change is audited.

const MAX_MINOR = 1_000_000_000_000; // a sanity ceiling, far above any real cap

const setLimitSchema = z.object({
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase()),
  maxPlanBudget: z.string().trim().min(1).max(20),
  maxDailyBudget: z.string().trim().min(1).max(20),
});

const fieldError = (path: string) =>
  new AppError("VALIDATION_FAILED", { fields: [{ path, code: "invalid_value" }] });

export interface SpendLimitView {
  readonly currency: string;
  readonly maxPlanBudget: string;
  readonly maxDailyBudget: string;
  readonly maxPlanBudgetMinor: number;
  readonly maxDailyBudgetMinor: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

export async function listSpendLimits(db: Db, ctx: TenantContext): Promise<SpendLimitView[]> {
  assertCan(ctx, "ads.view");
  const rows = await db.adSpendLimit.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { currency: "asc" },
    select: {
      currency: true,
      maxPlanBudgetMinor: true,
      maxDailyBudgetMinor: true,
      updatedAt: true,
      updatedBy: { select: { name: true } },
    },
  });
  return rows.map((row) => {
    const plan = Number(row.maxPlanBudgetMinor);
    const daily = Number(row.maxDailyBudgetMinor);
    return {
      currency: row.currency,
      maxPlanBudget: formatMajor({ minor: plan, currency: row.currency }),
      maxDailyBudget: formatMajor({ minor: daily, currency: row.currency }),
      maxPlanBudgetMinor: plan,
      maxDailyBudgetMinor: daily,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy?.name ?? null,
    };
  });
}

/** Sets (or changes) the limit for one currency (ads.manage: owners and admins). */
export async function setSpendLimit(
  db: Db,
  ctx: TenantContext,
  input: unknown,
): Promise<{ readonly currency: string }> {
  assertCan(ctx, "ads.manage");
  const data = parseInput(setLimitSchema, input);
  const plan = parseBudget(data.maxPlanBudget, data.currency);
  if (plan === null || plan > MAX_MINOR) throw fieldError("maxPlanBudget");
  const daily = parseBudget(data.maxDailyBudget, data.currency);
  if (daily === null || daily > plan) throw fieldError("maxDailyBudget");
  await db.$transaction(async (tx) => {
    const before = await tx.adSpendLimit.findFirst({
      where: { workspaceId: ctx.workspaceId, currency: data.currency },
      select: { maxPlanBudgetMinor: true, maxDailyBudgetMinor: true },
    });
    if (before === null) {
      await tx.adSpendLimit.create({
        data: {
          workspaceId: ctx.workspaceId,
          currency: data.currency,
          maxPlanBudgetMinor: BigInt(plan),
          maxDailyBudgetMinor: BigInt(daily),
          updatedByUserId: ctx.userId,
        },
      });
    } else {
      await tx.adSpendLimit.updateMany({
        where: { workspaceId: ctx.workspaceId, currency: data.currency },
        data: {
          maxPlanBudgetMinor: BigInt(plan),
          maxDailyBudgetMinor: BigInt(daily),
          updatedByUserId: ctx.userId,
          version: { increment: 1 },
        },
      });
    }
    await recordAudit(tx, ctx, {
      action: "ads.spend_limit_set",
      entityType: "ad_spend_limit",
      entityId: null,
      metadata: {
        currency: data.currency,
        maxPlanBudgetMinor: plan,
        maxDailyBudgetMinor: daily,
        previous:
          before === null
            ? null
            : {
                maxPlanBudgetMinor: Number(before.maxPlanBudgetMinor),
                maxDailyBudgetMinor: Number(before.maxDailyBudgetMinor),
              },
      },
    });
  });
  return { currency: data.currency };
}
