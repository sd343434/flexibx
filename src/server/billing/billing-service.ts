import { z } from "zod";

import type { CreditEntryKind } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import { workspaceTimeZone } from "../marketing/common";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";
import { parseInput } from "../validation/parse";

import type { CreditsSettings } from "./config";
import {
  addCredits,
  changePlan,
  creditsError,
  lockAccount,
  usageSummary,
  type CreditsConfig,
} from "./credits";
import type { PaymentProvider } from "./payments";
import {
  CREDIT_FEATURES,
  FEATURE_PRICES,
  marginMicros,
  plans,
  PRICE_VERSION,
  type CreditFeature,
} from "./pricing";

// What a workspace sees and sets about its credits (billing.view / billing.manage), the
// automatic top-up, and what a platform administrator does (add credits, change plan).

export interface BillingOverview {
  readonly planCode: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly subscriptionCredits: number;
  readonly purchasedCredits: number;
  readonly heldCredits: number;
  readonly available: number;
  readonly dailyCap: number | null;
  readonly periodCap: number | null;
  readonly featureCaps: Readonly<Record<string, number>>;
  readonly autoRecharge: {
    readonly enabled: boolean;
    readonly threshold: number | null;
    readonly amount: number | null;
    readonly periodMax: number | null;
  };
  readonly paymentsConfigured: boolean;
  readonly usage: {
    readonly period: Readonly<Record<string, number>>;
    readonly periodTotal: number;
    readonly today: number;
  };
  readonly prices: readonly { readonly feature: CreditFeature; readonly credits: number }[];
  readonly priceVersion: string;
  readonly ledger: readonly {
    readonly id: string;
    readonly kind: CreditEntryKind;
    readonly amount: number;
    readonly feature: string | null;
    readonly balanceAfter: number;
    readonly createdAt: Date;
  }[];
  readonly recharges: readonly {
    readonly id: string;
    readonly amount: number;
    readonly status: string;
    readonly failureCode: string | null;
    readonly createdAt: Date;
  }[];
  readonly version: number;
}

export async function getBillingOverview(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  settings: CreditsConfig,
  payments: PaymentProvider | null,
  now: Date = new Date(),
): Promise<BillingOverview> {
  assertCan(ctx, "billing.view");
  const { workspaceId } = ctx;
  // Opening the page renews an ended period (a write), like any other credit use.
  const account = await db.$transaction((tx) => lockAccount(tx, workspaceId, now, settings));
  const zone = await workspaceTimeZone(db, ctx);
  const [usage, ledger, recharges] = await Promise.all([
    usageSummary(db, account, zone, now),
    db.creditLedgerEntry.findMany({
      where: { workspaceId },
      orderBy: { sequence: "desc" },
      take: 40,
      select: {
        id: true,
        kind: true,
        amount: true,
        feature: true,
        subscriptionAfter: true,
        purchasedAfter: true,
        createdAt: true,
      },
    }),
    db.creditRecharge.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, amount: true, status: true, failureCode: true, createdAt: true },
    }),
  ]);
  return {
    planCode: account.planCode,
    periodStart: account.periodStart,
    periodEnd: account.periodEnd,
    subscriptionCredits: account.subscriptionCredits,
    purchasedCredits: account.purchasedCredits,
    heldCredits: account.heldCredits,
    available: account.subscriptionCredits + account.purchasedCredits,
    dailyCap: account.dailyCap,
    periodCap: account.periodCap,
    featureCaps: account.featureCaps,
    autoRecharge: {
      enabled: account.autoRechargeEnabled,
      threshold: account.autoRechargeThreshold,
      amount: account.autoRechargeAmount,
      periodMax: account.autoRechargePeriodMax,
    },
    paymentsConfigured: payments !== null,
    usage,
    prices: CREDIT_FEATURES.map((feature) => ({ feature, credits: FEATURE_PRICES[feature] })),
    priceVersion: PRICE_VERSION,
    ledger: ledger.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      amount: entry.amount,
      feature: entry.feature,
      balanceAfter: entry.subscriptionAfter + entry.purchasedAfter,
      createdAt: entry.createdAt,
    })),
    recharges,
    version: account.version,
  };
}

// ── Settings (billing.manage) ────────────────────────────────────────────────

const cap = z
  .union([z.literal(""), z.null(), z.coerce.number().int().min(1).max(10_000_000)])
  .transform((value) => (value === "" || value === null ? null : value));

const settingsSchema = z
  .strictObject({
    dailyCap: cap,
    periodCap: cap,
    featureCaps: z.partialRecord(z.enum(CREDIT_FEATURES), cap).optional(),
    autoRechargeEnabled: z.boolean(),
    autoRechargeThreshold: cap,
    autoRechargeAmount: cap,
    autoRechargePeriodMax: cap,
    version: z.coerce.number().int().min(0),
  })
  .superRefine((value, issue) => {
    if (!value.autoRechargeEnabled) return;
    for (const key of [
      "autoRechargeThreshold",
      "autoRechargeAmount",
      "autoRechargePeriodMax",
    ] as const) {
      if (value[key] === null)
        issue.addIssue({
          code: "custom",
          path: [key],
          message: "required",
          params: { code: "required" },
        });
    }
    if (
      value.autoRechargeAmount !== null &&
      value.autoRechargePeriodMax !== null &&
      value.autoRechargeAmount > value.autoRechargePeriodMax
    ) {
      issue.addIssue({
        code: "too_big",
        path: ["autoRechargeAmount"],
        maximum: value.autoRechargePeriodMax,
        origin: "number",
        inclusive: true,
        message: "exceeds the ceiling",
      });
    }
  });

export type CreditSettingsInput = z.input<typeof settingsSchema>;

/**
 * The workspace's own spending caps and automatic top-up (owners only). Turning the
 * top-up on needs a payment provider; the ceiling bounds what it may buy per period.
 */
export async function updateCreditSettings(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: unknown,
  settings: CreditsConfig,
  payments: PaymentProvider | null,
  now: Date = new Date(),
): Promise<void> {
  assertCan(ctx, "billing.manage");
  const data = parseInput(settingsSchema, input, "credit settings");
  if (data.autoRechargeEnabled && payments === null) {
    throw creditsError("CONFLICT", "credits_payment_unavailable");
  }
  const featureCaps: Record<string, number> = {};
  for (const [feature, value] of Object.entries(data.featureCaps ?? {})) {
    if (value !== null) featureCaps[feature] = value;
  }
  await db.$transaction(async (tx) => {
    const account = await lockAccount(tx, ctx.workspaceId, now, settings);
    if (account.version !== data.version) throw creditsError("CONFLICT", "credits_amount_invalid");
    await tx.creditAccount.update({
      where: { workspaceId: ctx.workspaceId },
      data: {
        dailyCap: data.dailyCap,
        periodCap: data.periodCap,
        featureCaps,
        autoRechargeEnabled: data.autoRechargeEnabled,
        autoRechargeThreshold: data.autoRechargeThreshold,
        autoRechargeAmount: data.autoRechargeAmount,
        autoRechargePeriodMax: data.autoRechargePeriodMax,
        updatedByUserId: ctx.userId,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, ctx, {
      action: "billing.settings_updated",
      entityType: "credit_account",
      entityId: null,
      metadata: {
        dailyCap: data.dailyCap,
        periodCap: data.periodCap,
        featureCaps,
        autoRecharge: data.autoRechargeEnabled
          ? {
              threshold: data.autoRechargeThreshold,
              amount: data.autoRechargeAmount,
              periodMax: data.autoRechargePeriodMax,
            }
          : false,
      },
    });
  });
}

// ── Automatic top-up ─────────────────────────────────────────────────────────

export type AutoRechargeOutcome =
  "skipped" | "ceiling_reached" | "succeeded" | "failed" | "uncertain";

/**
 * Buys `autoRechargeAmount` credits when the balance is below the threshold, at most
 * once at a time (a PENDING top-up blocks the next) and never beyond the period's
 * ceiling. The charge is made once per idempotency key; an unknown outcome stays
 * PENDING for an operator to resolve, so it is never charged twice.
 */
export async function autoRecharge(
  db: GuardedPrismaClient,
  workspaceId: string,
  settings: CreditsConfig,
  payments: PaymentProvider | null,
  now: Date = new Date(),
): Promise<AutoRechargeOutcome> {
  if (payments === null) return "skipped";
  const planned = await db.$transaction(async (tx) => {
    const account = await lockAccount(tx, workspaceId, now, settings);
    const { autoRechargeAmount: amount, autoRechargeThreshold: threshold } = account;
    const ceiling = account.autoRechargePeriodMax;
    if (!account.autoRechargeEnabled || amount === null || threshold === null || ceiling === null) {
      return null;
    }
    if (account.subscriptionCredits + account.purchasedCredits >= threshold) return null;
    const pending = await tx.creditRecharge.count({ where: { workspaceId, status: "PENDING" } });
    if (pending > 0) return null;
    const thisPeriod = await tx.creditRecharge.aggregate({
      where: { workspaceId, status: "SUCCEEDED", createdAt: { gte: account.periodStart } },
      _sum: { amount: true },
      _count: true,
    });
    if ((thisPeriod._sum.amount ?? 0) + amount > ceiling) return "ceiling_reached" as const;
    const attempts = await tx.creditRecharge.count({
      where: { workspaceId, createdAt: { gte: account.periodStart } },
    });
    const key = `auto:${account.periodStart.toISOString()}:${String(attempts + 1)}`;
    const row = await tx.creditRecharge.create({
      data: { workspaceId, amount, idempotencyKey: key, provider: payments.name, createdAt: now },
      select: { id: true },
    });
    return { id: row.id, amount, key };
  });
  if (planned === null) return "skipped";
  if (planned === "ceiling_reached") return "ceiling_reached";

  let result;
  try {
    result = await payments.charge({
      workspaceId,
      credits: planned.amount,
      idempotencyKey: planned.key,
    });
  } catch {
    // The charge may or may not have happened: stays PENDING (never retried blindly).
    return "uncertain";
  }
  return db.$transaction(async (tx) => {
    if (result.status === "succeeded") {
      const done = await tx.creditRecharge.updateMany({
        where: { workspaceId, id: planned.id, status: "PENDING" },
        data: { status: "SUCCEEDED", externalRef: result.reference.slice(0, 160), settledAt: now },
      });
      if (done.count === 0) return "skipped";
      await addCredits(
        tx,
        workspaceId,
        {
          kind: "AUTO_RECHARGE",
          amount: planned.amount,
          actorUserId: null,
          externalRef: result.reference.slice(0, 160),
          note: null,
        },
        now,
        settings,
      );
      await recordAudit(
        tx,
        { workspaceId, userId: null },
        {
          action: "billing.auto_recharge",
          entityType: "credit_recharge",
          entityId: planned.id,
          metadata: { amount: planned.amount, status: "SUCCEEDED" },
        },
      );
      return "succeeded";
    }
    await tx.creditRecharge.updateMany({
      where: { workspaceId, id: planned.id, status: "PENDING" },
      data: { status: "FAILED", failureCode: result.code.slice(0, 60), settledAt: now },
    });
    await recordAudit(
      tx,
      { workspaceId, userId: null },
      {
        action: "billing.auto_recharge",
        entityType: "credit_recharge",
        entityId: planned.id,
        metadata: { amount: planned.amount, status: "FAILED", code: result.code.slice(0, 60) },
      },
    );
    return "failed";
  });
}

// ── Platform administration ──────────────────────────────────────────────────

const grantSchema = z.strictObject({
  workspaceId: z.uuid(),
  kind: z.enum(["PURCHASE", "ADJUSTMENT"]),
  amount: z.coerce.number().int().min(-1_000_000).max(1_000_000),
  externalRef: z.string().trim().max(160).default(""),
  note: z.string().trim().max(300).default(""),
  /** Generated with the form: a double submit or a retried request is applied once. */
  requestKey: z.uuid(),
});

/**
 * Adds purchased credits against a manual invoice (PURCHASE) or corrects a balance
 * (ADJUSTMENT). Platform administrators only (the caller checks the platform role).
 */
export async function adminAddCredits(
  db: GuardedPrismaClient,
  adminUserId: string,
  input: unknown,
  settings: CreditsConfig,
  now: Date = new Date(),
): Promise<{ readonly applied: boolean }> {
  const data = parseInput(grantSchema, input, "credit grant");
  return db.$transaction(async (tx) => {
    const applied = await addCredits(
      tx,
      data.workspaceId,
      {
        kind: data.kind,
        amount: data.amount,
        actorUserId: adminUserId,
        externalRef: data.externalRef === "" ? null : data.externalRef,
        note: data.note === "" ? null : data.note,
        requestKey: data.requestKey,
      },
      now,
      settings,
    );
    if (!applied) return { applied };
    await recordAudit(
      tx,
      { workspaceId: null, userId: adminUserId },
      {
        action: "billing.credits_added",
        entityType: "credit_account",
        entityId: data.workspaceId,
        metadata: { kind: data.kind, amount: data.amount, reference: data.externalRef },
      },
    );
    return { applied };
  });
}

const planSchema = z.strictObject({
  workspaceId: z.uuid(),
  planCode: z.string().trim().min(1).max(40),
});

export async function adminChangePlan(
  db: GuardedPrismaClient,
  adminUserId: string,
  input: unknown,
  settings: CreditsConfig,
  now: Date = new Date(),
): Promise<void> {
  const data = parseInput(planSchema, input, "plan");
  await db.$transaction(async (tx) => {
    await changePlan(tx, data.workspaceId, data.planCode, adminUserId, now, settings);
    await recordAudit(
      tx,
      { workspaceId: null, userId: adminUserId },
      {
        action: "billing.plan_changed",
        entityType: "credit_account",
        entityId: data.workspaceId,
        metadata: { planCode: data.planCode },
      },
    );
  });
}

/** Provider cost and margin of the captured AI tasks of a period (administrators). */
export async function costReport(
  db: GuardedPrismaClient,
  workspaceId: string,
  from: Date,
  settings: CreditsSettings,
): Promise<{
  readonly credits: number;
  readonly providerCostMicros: bigint | null;
  readonly marginMicros: bigint | null;
  readonly unknownCost: number;
}> {
  const holds = await db.creditHold.aggregate({
    where: { workspaceId, status: "CAPTURED", createdAt: { gte: from } },
    _sum: { capturedAmount: true },
  });
  const entries = await db.creditLedgerEntry.aggregate({
    where: { workspaceId, kind: "CAPTURE", createdAt: { gte: from } },
    _sum: { providerCostMicros: true },
    _count: { providerCostMicros: true, _all: true },
  });
  const credits = holds._sum.capturedAmount ?? 0;
  const known = entries._count.providerCostMicros;
  const cost = known === 0 ? null : (entries._sum.providerCostMicros ?? null);
  return {
    credits,
    providerCostMicros: cost,
    marginMicros: marginMicros(credits, settings.creditValueMicros, cost),
    unknownCost: entries._count._all - known,
  };
}

/** Plans an administrator can assign (code → credits per period). */
export function availablePlans(settings: CreditsConfig) {
  return Object.values(plans(settings.trialPeriodCredits));
}
