import type { PrismaClient } from "@/generated/prisma/client";
import type { CreditEntryKind, CreditHoldStatus } from "@/generated/prisma/enums";

import { AppError } from "../errors/app-error";
import type { Db } from "../db/types";
import { zonedDateKey, zonedLocalToUtc } from "../marketing/time";
import type { ValidationCode } from "../validation/field-errors";

import {
  addMonth,
  DEFAULT_PLAN,
  FEATURE_PRICES,
  isCreditFeature,
  plans,
  PRICE_VERSION,
  type CreditFeature,
} from "./pricing";

// The credits ledger. Every balance change happens in a transaction holding the
// workspace's credit account row lock (SELECT … FOR UPDATE), so concurrent tasks take
// turns and balances, caps and the ledger can never disagree. Callers pass their own
// transaction so a hold commits together with the work it pays for.
//
// Policy (provisional, see pricing.ts):
// - A paid task holds its price before it runs; insufficient credits or a reached cap
//   refuse it before any provider call.
// - Success captures the price; any failure releases the whole hold (the customer never
//   pays for a failed task). The same idempotency key never holds twice, so retries
//   cannot double-charge.
// - The subscription allowance is spent first and expires at the end of its period;
//   purchased credits never expire. A hold released after its period ended does not
//   bring back the expired allowance.

export interface CreditsConfig {
  /** Allowance of the default (trial) plan per period. */
  readonly trialPeriodCredits: number;
}

export interface AccountState {
  readonly workspaceId: string;
  readonly planCode: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly subscriptionCredits: number;
  readonly purchasedCredits: number;
  readonly heldCredits: number;
  readonly dailyCap: number | null;
  readonly periodCap: number | null;
  readonly featureCaps: Readonly<Record<string, number>>;
  readonly autoRechargeEnabled: boolean;
  readonly autoRechargeThreshold: number | null;
  readonly autoRechargeAmount: number | null;
  readonly autoRechargePeriodMax: number | null;
  readonly version: number;
}

export function creditsError(
  code: "CONFLICT" | "RATE_LIMITED" | "VALIDATION_FAILED",
  field: ValidationCode,
  params: Record<string, string | number> = {},
): AppError {
  return new AppError(code, {
    message: `Credits: ${field}`,
    fields: [{ path: "credits", code: field, params }],
    metadata: { ...params },
  });
}

const ACCOUNT_SELECT = {
  workspaceId: true,
  planCode: true,
  periodStart: true,
  periodEnd: true,
  subscriptionCredits: true,
  purchasedCredits: true,
  heldCredits: true,
  dailyCap: true,
  periodCap: true,
  featureCaps: true,
  autoRechargeEnabled: true,
  autoRechargeThreshold: true,
  autoRechargeAmount: true,
  autoRechargePeriodMax: true,
  version: true,
} as const;

function readFeatureCaps(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const caps: Record<string, number> = {};
  for (const [key, cap] of Object.entries(value)) {
    if (isCreditFeature(key) && typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0) {
      caps[key] = cap;
    }
  }
  return caps;
}

function periodAllowance(planCode: string, config: CreditsConfig): number {
  return plans(config.trialPeriodCredits)[planCode]?.periodCredits ?? 0;
}

async function appendEntry(
  tx: Db,
  account: { workspaceId: string; subscription: number; purchased: number; held: number },
  entry: {
    readonly kind: CreditEntryKind;
    readonly amount: number;
    readonly holdId?: string;
    readonly feature?: string;
    readonly provider?: string | null;
    readonly model?: string | null;
    readonly providerCostMicros?: bigint | null;
    readonly actorUserId?: string | null;
    readonly externalRef?: string | null;
    readonly requestKey?: string | null;
    readonly note?: string | null;
    readonly at: Date;
  },
): Promise<void> {
  await tx.creditLedgerEntry.create({
    data: {
      workspaceId: account.workspaceId,
      kind: entry.kind,
      amount: entry.amount,
      subscriptionAfter: account.subscription,
      purchasedAfter: account.purchased,
      heldAfter: account.held,
      holdId: entry.holdId ?? null,
      feature: entry.feature ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      providerCostMicros: entry.providerCostMicros ?? null,
      actorUserId: entry.actorUserId ?? null,
      externalRef: entry.externalRef ?? null,
      requestKey: entry.requestKey ?? null,
      note: entry.note ?? null,
      createdAt: entry.at,
    },
  });
}

/**
 * Locks the workspace's credit account (creating it with the default plan on first use)
 * and renews its period when it has ended. Must run inside a transaction.
 */
export async function lockAccount(
  tx: Db,
  workspaceId: string,
  now: Date,
  config: CreditsConfig,
): Promise<AccountState> {
  // Serializes the first creation with every other credit change for the workspace.
  // FOR NO KEY UPDATE: still exclusive between credit changes, but it does not block the
  // inserts elsewhere that reference this workspace (they take FOR KEY SHARE).
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`;
  let row = await tx.creditAccount.findFirst({ where: { workspaceId }, select: ACCOUNT_SELECT });
  if (row === null) {
    const allowance = periodAllowance(DEFAULT_PLAN, config);
    row = await tx.creditAccount.create({
      data: {
        workspaceId,
        planCode: DEFAULT_PLAN,
        periodStart: now,
        periodEnd: addMonth(now),
        subscriptionCredits: allowance,
        purchasedCredits: 0,
        createdAt: now,
      },
      select: ACCOUNT_SELECT,
    });
    if (allowance > 0) {
      await appendEntry(
        tx,
        { workspaceId, subscription: allowance, purchased: 0, held: 0 },
        { kind: "SUBSCRIPTION_GRANT", amount: allowance, note: DEFAULT_PLAN, at: now },
      );
    }
  }
  if (row.periodEnd <= now) row = await renewPeriod(tx, row, now, config);
  return { ...row, featureCaps: readFeatureCaps(row.featureCaps) };
}

async function renewPeriod(
  tx: Db,
  row: {
    workspaceId: string;
    planCode: string;
    periodEnd: Date;
    subscriptionCredits: number;
    purchasedCredits: number;
    heldCredits: number;
  },
  now: Date,
  config: CreditsConfig,
) {
  const { workspaceId } = row;
  const balances = {
    workspaceId,
    subscription: row.subscriptionCredits,
    purchased: row.purchasedCredits,
    held: row.heldCredits,
  };
  if (row.subscriptionCredits > 0) {
    balances.subscription = 0;
    await appendEntry(tx, balances, {
      kind: "SUBSCRIPTION_EXPIRE",
      amount: -row.subscriptionCredits,
      at: now,
    });
  }
  // Skip whole periods that passed without activity: one grant for the current period.
  let start = row.periodEnd;
  let end = addMonth(start);
  while (end <= now) {
    start = end;
    end = addMonth(start);
  }
  const allowance = periodAllowance(row.planCode, config);
  balances.subscription = allowance;
  if (allowance > 0) {
    await appendEntry(tx, balances, {
      kind: "SUBSCRIPTION_GRANT",
      amount: allowance,
      note: row.planCode,
      at: now,
    });
  }
  return tx.creditAccount.update({
    where: { workspaceId },
    data: {
      periodStart: start,
      periodEnd: end,
      subscriptionCredits: allowance,
      version: { increment: 1 },
    },
    select: ACCOUNT_SELECT,
  });
}

/** Credits committed since `from`: running holds plus what was captured. */
async function committedSince(
  tx: Db,
  workspaceId: string,
  from: Date,
  feature?: CreditFeature,
): Promise<number> {
  const rows = await tx.creditHold.groupBy({
    by: ["status"],
    where: {
      workspaceId,
      createdAt: { gte: from },
      status: { in: ["HELD", "CAPTURED"] },
      ...(feature === undefined ? {} : { feature }),
    },
    _sum: { amount: true, capturedAmount: true },
  });
  let total = 0;
  for (const row of rows) {
    total += row.status === "HELD" ? (row._sum.amount ?? 0) : (row._sum.capturedAmount ?? 0);
  }
  return total;
}

/** First instant of `now`'s day in the workspace time zone. */
function startOfDay(now: Date, zone: string): Date {
  return zonedLocalToUtc(`${zonedDateKey(now, zone)}T00:00`, zone) ?? now;
}

export interface HoldRequest {
  readonly workspaceId: string;
  readonly feature: CreditFeature;
  /** One hold per task attempt; reusing a key returns the existing hold. */
  readonly idempotencyKey: string;
  /**
   * How many units of the feature (e.g. started minutes of media); the hold is the
   * feature's price times this. Default 1.
   */
  readonly units?: number;
  readonly reference: string | null;
  readonly userId: string | null;
  readonly timeZone: string;
  readonly now: Date;
}

export interface HoldResult {
  readonly holdId: string;
  readonly amount: number;
  readonly status: CreditHoldStatus;
}

/**
 * Sets a task's price aside, or refuses it (insufficient credits, a cap reached). Must
 * run inside a transaction; the hold commits with it.
 */
export async function holdCredits(
  tx: Db,
  request: HoldRequest,
  config: CreditsConfig,
): Promise<HoldResult> {
  const { workspaceId, feature, now } = request;
  const account = await lockAccount(tx, workspaceId, now, config);
  const existing = await tx.creditHold.findFirst({
    where: { workspaceId, idempotencyKey: request.idempotencyKey },
    select: { id: true, amount: true, status: true },
  });
  if (existing !== null)
    return { holdId: existing.id, amount: existing.amount, status: existing.status };

  const units = request.units ?? 1;
  if (!Number.isInteger(units) || units < 1 || units > 10_000) {
    throw new AppError("VALIDATION_FAILED", { message: "Invalid credit units" });
  }
  const price = FEATURE_PRICES[feature] * units;
  // The workspace's own caps first (they apply whatever the balance).
  if (account.dailyCap !== null) {
    const today = await committedSince(tx, workspaceId, startOfDay(now, request.timeZone));
    if (today + price > account.dailyCap) {
      throw creditsError("RATE_LIMITED", "credits_daily_cap", { maximum: account.dailyCap });
    }
  }
  if (account.periodCap !== null) {
    const period = await committedSince(tx, workspaceId, account.periodStart);
    if (period + price > account.periodCap) {
      throw creditsError("RATE_LIMITED", "credits_period_cap", { maximum: account.periodCap });
    }
  }
  const featureCap = account.featureCaps[feature];
  if (featureCap !== undefined) {
    const used = await committedSince(tx, workspaceId, account.periodStart, feature);
    if (used + price > featureCap) {
      throw creditsError("RATE_LIMITED", "credits_feature_cap", { maximum: featureCap });
    }
  }
  const available = account.subscriptionCredits + account.purchasedCredits;
  if (available < price) {
    throw creditsError("CONFLICT", "credits_insufficient", { required: price, available });
  }

  const fromSubscription = Math.min(price, account.subscriptionCredits);
  const fromPurchased = price - fromSubscription;
  const balances = {
    workspaceId,
    subscription: account.subscriptionCredits - fromSubscription,
    purchased: account.purchasedCredits - fromPurchased,
    held: account.heldCredits + price,
  };
  await tx.creditAccount.update({
    where: { workspaceId },
    data: {
      subscriptionCredits: balances.subscription,
      purchasedCredits: balances.purchased,
      heldCredits: balances.held,
    },
  });
  const hold = await tx.creditHold.create({
    data: {
      workspaceId,
      feature,
      amount: price,
      subscriptionPortion: fromSubscription,
      purchasedPortion: fromPurchased,
      idempotencyKey: request.idempotencyKey,
      reference: request.reference,
      priceVersion: PRICE_VERSION,
      userId: request.userId,
      createdAt: now,
    },
    select: { id: true },
  });
  await appendEntry(tx, balances, {
    kind: "HOLD",
    amount: -price,
    holdId: hold.id,
    feature,
    actorUserId: request.userId,
    at: now,
  });
  return { holdId: hold.id, amount: price, status: "HELD" };
}

/** Gives back `amount` of a hold to the balances it came from (purchased first). */
function giveBack(
  hold: { subscriptionPortion: number; purchasedPortion: number; createdAt: Date },
  amount: number,
  periodStart: Date,
): { subscription: number; purchased: number } {
  const purchased = Math.min(amount, hold.purchasedPortion);
  // The allowance of a period that has since ended expired with it.
  const subscription =
    hold.createdAt >= periodStart ? Math.min(amount - purchased, hold.subscriptionPortion) : 0;
  return { subscription, purchased };
}

export interface CaptureDetails {
  /** Charged amount (at most the hold); default the whole hold. */
  readonly amount?: number;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly providerCostMicros?: bigint | null;
}

/** Settles a hold as charged. A hold already settled is left as it is. */
export async function captureHold(
  tx: Db,
  workspaceId: string,
  holdId: string,
  details: CaptureDetails,
  now: Date,
  config: CreditsConfig,
): Promise<void> {
  const account = await lockAccount(tx, workspaceId, now, config);
  const hold = await tx.creditHold.findFirst({
    where: { workspaceId, id: holdId, status: "HELD" },
    select: {
      id: true,
      feature: true,
      amount: true,
      subscriptionPortion: true,
      purchasedPortion: true,
      createdAt: true,
    },
  });
  if (hold === null) return;
  const charged = Math.min(Math.max(details.amount ?? hold.amount, 0), hold.amount);
  const back = giveBack(hold, hold.amount - charged, account.periodStart);
  const balances = {
    workspaceId,
    subscription: account.subscriptionCredits + back.subscription,
    purchased: account.purchasedCredits + back.purchased,
    held: account.heldCredits - hold.amount,
  };
  const settled = await tx.creditHold.updateMany({
    where: { workspaceId, id: hold.id, status: "HELD" },
    data: { status: "CAPTURED", capturedAmount: charged, settledAt: now },
  });
  if (settled.count === 0) return;
  await tx.creditAccount.update({
    where: { workspaceId },
    data: {
      subscriptionCredits: balances.subscription,
      purchasedCredits: balances.purchased,
      heldCredits: balances.held,
    },
  });
  await appendEntry(tx, balances, {
    kind: "CAPTURE",
    amount: 0,
    holdId: hold.id,
    feature: hold.feature,
    provider: details.provider ?? null,
    model: details.model ?? null,
    providerCostMicros: details.providerCostMicros ?? null,
    note: `charged ${String(charged)}`,
    at: now,
  });
  const returned = back.subscription + back.purchased;
  if (returned > 0) {
    await appendEntry(tx, balances, {
      kind: "RELEASE",
      amount: returned,
      holdId: hold.id,
      feature: hold.feature,
      at: now,
    });
  }
}

/** Settles a hold as not charged (the task failed or was cancelled). */
export async function releaseHold(
  tx: Db,
  workspaceId: string,
  holdId: string,
  reason: string,
  now: Date,
  config: CreditsConfig,
): Promise<void> {
  const account = await lockAccount(tx, workspaceId, now, config);
  const hold = await tx.creditHold.findFirst({
    where: { workspaceId, id: holdId, status: "HELD" },
    select: {
      id: true,
      feature: true,
      amount: true,
      subscriptionPortion: true,
      purchasedPortion: true,
      createdAt: true,
    },
  });
  if (hold === null) return;
  const back = giveBack(hold, hold.amount, account.periodStart);
  const balances = {
    workspaceId,
    subscription: account.subscriptionCredits + back.subscription,
    purchased: account.purchasedCredits + back.purchased,
    held: account.heldCredits - hold.amount,
  };
  const settled = await tx.creditHold.updateMany({
    where: { workspaceId, id: hold.id, status: "HELD" },
    data: { status: "RELEASED", settledAt: now },
  });
  if (settled.count === 0) return;
  await tx.creditAccount.update({
    where: { workspaceId },
    data: {
      subscriptionCredits: balances.subscription,
      purchasedCredits: balances.purchased,
      heldCredits: balances.held,
    },
  });
  await appendEntry(tx, balances, {
    kind: "RELEASE",
    amount: back.subscription + back.purchased,
    holdId: hold.id,
    feature: hold.feature,
    note: reason.slice(0, 300),
    at: now,
  });
}

/** Adds purchased credits (or removes them, for a negative adjustment). */
export async function addCredits(
  tx: Db,
  workspaceId: string,
  entry: {
    readonly kind: "PURCHASE" | "AUTO_RECHARGE" | "ADJUSTMENT";
    readonly amount: number;
    readonly actorUserId: string | null;
    readonly externalRef: string | null;
    readonly note: string | null;
    /** A resubmitted request with the same key is applied once (false the next times). */
    readonly requestKey?: string | null;
  },
  now: Date,
  config: CreditsConfig,
): Promise<boolean> {
  if (!Number.isSafeInteger(entry.amount) || entry.amount === 0) {
    throw creditsError("VALIDATION_FAILED", "credits_amount_invalid");
  }
  if (entry.kind !== "ADJUSTMENT" && entry.amount < 0) {
    throw creditsError("VALIDATION_FAILED", "credits_amount_invalid");
  }
  const account = await lockAccount(tx, workspaceId, now, config);
  // Under the account lock, so two copies of one request cannot both pass this check (the
  // unique (workspace_id, request_key) index is the backstop).
  if (entry.requestKey !== undefined && entry.requestKey !== null) {
    const applied = await tx.creditLedgerEntry.findFirst({
      where: { workspaceId, requestKey: entry.requestKey },
      select: { id: true },
    });
    if (applied !== null) return false;
  }
  const purchased = account.purchasedCredits + entry.amount;
  if (purchased < 0) throw creditsError("VALIDATION_FAILED", "credits_amount_invalid");
  await tx.creditAccount.update({ where: { workspaceId }, data: { purchasedCredits: purchased } });
  await appendEntry(
    tx,
    {
      workspaceId,
      subscription: account.subscriptionCredits,
      purchased,
      held: account.heldCredits,
    },
    {
      kind: entry.kind,
      amount: entry.amount,
      actorUserId: entry.actorUserId,
      externalRef: entry.externalRef,
      requestKey: entry.requestKey ?? null,
      note: entry.note,
      at: now,
    },
  );
  return true;
}

/**
 * Moves the workspace to another plan: a new period starts now with the new plan's
 * allowance; the unused allowance of the old plan expires.
 */
export async function changePlan(
  tx: Db,
  workspaceId: string,
  planCode: string,
  actorUserId: string | null,
  now: Date,
  config: CreditsConfig,
  /** The account version the request was made against (optimistic concurrency). */
  expectedVersion?: number,
): Promise<{ readonly previousPlan: string }> {
  if (plans(config.trialPeriodCredits)[planCode] === undefined) {
    throw creditsError("VALIDATION_FAILED", "credits_plan_unknown");
  }
  const account = await lockAccount(tx, workspaceId, now, config);
  // Under the account lock: a double submit or a retried request sees the version the
  // first one moved, and changes nothing (no second period reset, no second allowance).
  if (expectedVersion !== undefined && account.version !== expectedVersion) {
    throw creditsError("CONFLICT", "stale_status");
  }
  const balances = {
    workspaceId,
    subscription: account.subscriptionCredits,
    purchased: account.purchasedCredits,
    held: account.heldCredits,
  };
  if (account.subscriptionCredits > 0) {
    balances.subscription = 0;
    await appendEntry(tx, balances, {
      kind: "SUBSCRIPTION_EXPIRE",
      amount: -account.subscriptionCredits,
      actorUserId,
      at: now,
    });
  }
  const allowance = periodAllowance(planCode, config);
  balances.subscription = allowance;
  if (allowance > 0) {
    await appendEntry(tx, balances, {
      kind: "SUBSCRIPTION_GRANT",
      amount: allowance,
      actorUserId,
      note: planCode,
      at: now,
    });
  }
  await tx.creditAccount.update({
    where: { workspaceId },
    data: {
      planCode,
      periodStart: now,
      periodEnd: addMonth(now),
      subscriptionCredits: allowance,
      version: { increment: 1 },
    },
  });
  return { previousPlan: account.planCode };
}

/** Usage of the current period by feature, and today's total. */
export async function usageSummary(
  db: Db,
  account: Pick<AccountState, "workspaceId" | "periodStart">,
  timeZone: string,
  now: Date,
): Promise<{
  readonly period: Record<string, number>;
  readonly today: number;
  readonly periodTotal: number;
}> {
  const rows = await db.creditHold.groupBy({
    by: ["feature", "status"],
    where: {
      workspaceId: account.workspaceId,
      createdAt: { gte: account.periodStart },
      status: { in: ["HELD", "CAPTURED"] },
    },
    _sum: { amount: true, capturedAmount: true },
  });
  const period: Record<string, number> = {};
  let periodTotal = 0;
  for (const row of rows) {
    const value = row.status === "HELD" ? (row._sum.amount ?? 0) : (row._sum.capturedAmount ?? 0);
    period[row.feature] = (period[row.feature] ?? 0) + value;
    periodTotal += value;
  }
  const today = await committedSince(db, account.workspaceId, startOfDay(now, timeZone));
  return { period, today, periodTotal };
}

/** Idempotency-key prefix of the hold behind an AI generation (ai-service.ts). */
export const AI_GENERATION_KEY = "ai_generation:";

/** A hold not settled after this long was abandoned (an AI call ends within a minute). */
export const STALE_HOLD_MS = 15 * 60_000;

/**
 * Releases holds that were never settled — the outcome write failed or the process
 * stopped between the provider call and the settlement — so they stop locking credits and
 * counting against caps. A generation still PENDING behind such a hold is marked FAILED
 * (nothing was delivered, so nothing is charged). Scheduler only: `system` selects across
 * workspaces (reviewed path in orchestration/runtime.ts); every write goes through `db`
 * with the hold's own workspace id.
 */
export async function releaseStaleHolds(
  system: PrismaClient,
  db: Db,
  now: Date,
  config: CreditsConfig,
  limit = 50,
  log?: { error(object: Record<string, unknown>, message: string): void },
): Promise<number> {
  const stale = await system.creditHold.findMany({
    where: { status: "HELD", createdAt: { lt: new Date(now.getTime() - STALE_HOLD_MS) } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, workspaceId: true, idempotencyKey: true },
  });
  let released = 0;
  for (const hold of stale) {
    // One hold that cannot be released (logged) never blocks the others.
    try {
      await db.$transaction(async (tx) => {
        const generationId = hold.idempotencyKey.startsWith(AI_GENERATION_KEY)
          ? hold.idempotencyKey.slice(AI_GENERATION_KEY.length)
          : null;
        if (generationId !== null) {
          await tx.aiGeneration.updateMany({
            where: { workspaceId: hold.workspaceId, id: generationId, status: "PENDING" },
            data: { status: "FAILED", errorCode: "not_settled" },
          });
        }
        await releaseHold(tx, hold.workspaceId, hold.id, "not_settled", now, config);
      });
      released += 1;
    } catch (error) {
      log?.error({ err: error, holdId: hold.id }, "Stale credit hold release failed");
    }
  }
  return released;
}
