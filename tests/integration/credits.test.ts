// Credits: every paid AI task holds its price before the provider is called, is charged
// only on success, is released on failure, never twice for one key, never past the
// balance or the workspace's own caps (also under concurrency), and every movement is in
// the append-only ledger. The subscription allowance is spent first and expires with its
// period; purchased credits stay. Automatic top-up respects its threshold and ceiling and
// never charges twice. Real database; the AI provider and the payment provider are
// deterministic stand-ins (no network, no money).
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { generateIdeas, type AiRuntime } from "@/server/ai/ai-service";
import { createFakeProvider, type FakeProviderOptions } from "@/server/ai/fake-provider";
import {
  adminAddCredits,
  adminChangePlan,
  autoRecharge,
  costReport,
  getBillingOverview,
  updateCreditSettings,
} from "@/server/billing/billing-service";
import type { CreditsSettings } from "@/server/billing/config";
import {
  captureHold,
  holdCredits,
  lockAccount,
  releaseHold,
  releaseStaleHolds,
} from "@/server/billing/credits";
import type { ChargeResult, PaymentProvider } from "@/server/billing/payments";
import { addMonth } from "@/server/billing/pricing";
import { AppError } from "@/server/errors/app-error";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

const settings = (trial = 5): CreditsSettings => ({
  trialPeriodCredits: trial,
  prices: { inputPerMTok: null, outputPerMTok: null },
  creditValueMicros: null,
});

const runtime = (
  options: FakeProviderOptions = {},
  credits = settings(),
  payments: PaymentProvider | null = null,
): AiRuntime & { provider: ReturnType<typeof createFakeProvider> } => ({
  provider: createFakeProvider(options),
  timeoutMs: 2000,
  credits,
  payments,
});

const ideas = (ctx: TenantContext, rt: AiRuntime) =>
  generateIdeas(
    db,
    ctx,
    rt,
    { language: undefined, topic: "Winter drinks", count: 3, pillarId: null, campaignId: null },
    "en",
  );

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw error;
  return error;
}

const account = (workspaceId: string) =>
  system.creditAccount.findUniqueOrThrow({ where: { workspaceId } });

async function owner() {
  return createTenant(system, { role: WorkspaceRole.OWNER });
}

describe("paying for AI work", () => {
  it("holds the price, charges it on success, and records every movement", async () => {
    const ctx = await owner();
    await ideas(ctx, runtime());
    expect(await account(ctx.workspaceId)).toMatchObject({
      planCode: "trial",
      subscriptionCredits: 4,
      purchasedCredits: 0,
      heldCredits: 0,
    });
    const ledger = await system.creditLedgerEntry.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { sequence: "asc" },
    });
    expect(ledger.map((entry) => [entry.kind, entry.amount])).toEqual([
      ["SUBSCRIPTION_GRANT", 5],
      ["HOLD", -1],
      ["CAPTURE", 0],
    ]);
    const hold = await system.creditHold.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    const generation = await system.aiGeneration.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(hold).toMatchObject({
      feature: "ai_text",
      status: "CAPTURED",
      capturedAmount: 1,
      reference: `ai_generation:${generation.id}`,
    });
  });

  it("charges nothing for a failed task", async () => {
    const ctx = await owner();
    await rejection(ideas(ctx, runtime({ scenario: "unavailable" })));
    expect(await account(ctx.workspaceId)).toMatchObject({
      subscriptionCredits: 5,
      heldCredits: 0,
    });
    expect(
      await system.creditHold.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } }),
    ).toMatchObject({ status: "RELEASED", capturedAmount: null });
  });

  it("refuses before calling the provider when the balance is too low", async () => {
    const ctx = await owner();
    const rt = runtime({}, settings(0));
    const error = await rejection(ideas(ctx, rt));
    expect(error).toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "credits_insufficient", params: { required: 1, available: 0 } }],
    });
    expect(rt.provider.calls).toBe(0);
    // Nothing reserved: no generation, no hold.
    expect(await system.aiGeneration.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);
    expect(await system.creditHold.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);
  });

  it("never overdraws under concurrent tasks", async () => {
    const ctx = await owner();
    const rt = runtime({}, settings(3));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ideas(ctx, rt)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(await account(ctx.workspaceId)).toMatchObject({
      subscriptionCredits: 0,
      heldCredits: 0,
    });
    expect(rt.provider.calls).toBe(3);
  });

  it("keeps workspaces' credits apart", async () => {
    const first = await owner();
    const second = await owner();
    await ideas(first, runtime());
    expect(await account(first.workspaceId)).toMatchObject({ subscriptionCredits: 4 });
    await ideas(second, runtime());
    expect(await account(second.workspaceId)).toMatchObject({ subscriptionCredits: 4 });
    expect(await account(first.workspaceId)).toMatchObject({ subscriptionCredits: 4 });
  });
});

describe("holds", () => {
  const request = (workspaceId: string, key: string, now = new Date()) => ({
    workspaceId,
    feature: "ad_plan" as const,
    idempotencyKey: key,
    reference: null,
    userId: null,
    timeZone: "Asia/Riyadh",
    now,
  });

  it("holds once per key: a retry never charges twice", async () => {
    const ctx = await owner();
    const first = await db.$transaction((tx) =>
      holdCredits(tx, request(ctx.workspaceId, "k1"), settings()),
    );
    const again = await db.$transaction((tx) =>
      holdCredits(tx, request(ctx.workspaceId, "k1"), settings()),
    );
    expect(again.holdId).toBe(first.holdId);
    expect(await account(ctx.workspaceId)).toMatchObject({
      subscriptionCredits: 2,
      heldCredits: 3,
    });
    // Settling twice changes nothing more.
    for (let i = 0; i < 2; i += 1) {
      await db.$transaction((tx) =>
        captureHold(tx, ctx.workspaceId, first.holdId, {}, new Date(), settings()),
      );
    }
    await db.$transaction((tx) =>
      releaseHold(tx, ctx.workspaceId, first.holdId, "late", new Date(), settings()),
    );
    expect(await account(ctx.workspaceId)).toMatchObject({
      subscriptionCredits: 2,
      heldCredits: 0,
    });
  });

  it("spends the allowance first, gives purchased credits back first, and expires the allowance with its period", async () => {
    const ctx = await owner();
    const start = new Date("2026-10-01T00:00:00Z");
    await db.$transaction((tx) => lockAccount(tx, ctx.workspaceId, start, settings(2)));
    await adminAddCredits(
      db,
      ctx.userId,
      {
        workspaceId: ctx.workspaceId,
        kind: "PURCHASE",
        amount: 10,
        externalRef: "INV-1",
        requestKey: crypto.randomUUID(),
      },
      settings(2),
      start,
    );
    // 3 credits: 2 from the allowance, 1 purchased.
    const hold = await db.$transaction((tx) =>
      holdCredits(tx, request(ctx.workspaceId, "plan-1", start), settings(2)),
    );
    expect(await system.creditHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject(
      {
        subscriptionPortion: 2,
        purchasedPortion: 1,
      },
    );
    // Next period: the unused allowance expired, a new one is granted, purchased stays.
    const next = addMonth(start);
    await db.$transaction((tx) => lockAccount(tx, ctx.workspaceId, next, settings(2)));
    expect(await account(ctx.workspaceId)).toMatchObject({
      subscriptionCredits: 2,
      purchasedCredits: 9,
      heldCredits: 3,
    });
    // Releasing the old hold gives back the purchased part only (its allowance expired).
    await db.$transaction((tx) =>
      releaseHold(tx, ctx.workspaceId, hold.holdId, "failed", next, settings(2)),
    );
    expect(await account(ctx.workspaceId)).toMatchObject({
      subscriptionCredits: 2,
      purchasedCredits: 10,
      heldCredits: 0,
    });
  });

  it("enforces the workspace's daily, period and per-feature caps", async () => {
    const ctx = await owner();
    const config = settings(100);
    const now = new Date();
    await db.$transaction((tx) => lockAccount(tx, ctx.workspaceId, now, config));
    const overview = await getBillingOverview(db, ctx, config, null, now);
    await updateCreditSettings(
      db,
      ctx,
      {
        dailyCap: 4,
        periodCap: "",
        featureCaps: { ad_plan: 6 },
        autoRechargeEnabled: false,
        autoRechargeThreshold: "",
        autoRechargeAmount: "",
        autoRechargePeriodMax: "",
        version: overview.version,
      },
      config,
      null,
      now,
    );
    await db.$transaction((tx) => holdCredits(tx, request(ctx.workspaceId, "a", now), config));
    // 3 + 3 > 4 a day.
    expect(
      await rejection(
        db.$transaction((tx) => holdCredits(tx, request(ctx.workspaceId, "b", now), config)),
      ),
    ).toMatchObject({ code: "RATE_LIMITED", fields: [{ code: "credits_daily_cap" }] });
    // Next day: the daily cap allows it, the ad_plan cap (6 per period) still counts both days.
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await db.$transaction((tx) => holdCredits(tx, request(ctx.workspaceId, "c", tomorrow), config));
    const dayAfter = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    expect(
      await rejection(
        db.$transaction((tx) => holdCredits(tx, request(ctx.workspaceId, "d", dayAfter), config)),
      ),
    ).toMatchObject({ fields: [{ code: "credits_feature_cap", params: { maximum: 6 } }] });
  });
});

describe("billing settings and administration", () => {
  it("lets owners manage, admins view, and nobody else see the credits", async () => {
    const ctx = await owner();
    const admin = { ...ctx, role: WorkspaceRole.ADMIN };
    const manager = { ...ctx, role: WorkspaceRole.MANAGER };
    const overview = await getBillingOverview(db, admin, settings(), null);
    expect(overview).toMatchObject({ planCode: "trial", available: 5, paymentsConfigured: false });
    expect(await rejection(getBillingOverview(db, manager, settings(), null))).toMatchObject({
      code: "FORBIDDEN",
    });
    const input = {
      dailyCap: 10,
      periodCap: "",
      autoRechargeEnabled: false,
      autoRechargeThreshold: "",
      autoRechargeAmount: "",
      autoRechargePeriodMax: "",
      version: overview.version,
    };
    expect(await rejection(updateCreditSettings(db, admin, input, settings(), null))).toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
    await updateCreditSettings(db, ctx, input, settings(), null);
    expect(await account(ctx.workspaceId)).toMatchObject({
      dailyCap: 10,
      updatedByUserId: ctx.userId,
    });
    expect(
      await system.auditLog.count({
        where: { workspaceId: ctx.workspaceId, action: "billing.settings_updated" },
      }),
    ).toBe(1);
  });

  it("refuses automatic top-up without a payment provider", async () => {
    const ctx = await owner();
    const overview = await getBillingOverview(db, ctx, settings(), null);
    const error = await rejection(
      updateCreditSettings(
        db,
        ctx,
        {
          dailyCap: "",
          periodCap: "",
          autoRechargeEnabled: true,
          autoRechargeThreshold: 2,
          autoRechargeAmount: 10,
          autoRechargePeriodMax: 30,
          version: overview.version,
        },
        settings(),
        null,
      ),
    );
    expect(error).toMatchObject({ fields: [{ code: "credits_payment_unavailable" }] });
  });

  it("adds credits and changes plans for administrators, never below zero", async () => {
    const ctx = await owner();
    await adminAddCredits(
      db,
      ctx.userId,
      {
        workspaceId: ctx.workspaceId,
        kind: "PURCHASE",
        amount: 50,
        externalRef: "INV-7",
        requestKey: crypto.randomUUID(),
      },
      settings(),
    );
    expect(
      await rejection(
        adminAddCredits(
          db,
          ctx.userId,
          {
            workspaceId: ctx.workspaceId,
            kind: "ADJUSTMENT",
            amount: -60,
            requestKey: crypto.randomUUID(),
          },
          settings(),
        ),
      ),
    ).toMatchObject({ fields: [{ code: "credits_amount_invalid" }] });
    await adminChangePlan(
      db,
      ctx.userId,
      {
        workspaceId: ctx.workspaceId,
        planCode: "starter",
        expectedVersion: (await account(ctx.workspaceId)).version,
      },
      settings(),
    );
    expect(await account(ctx.workspaceId)).toMatchObject({
      planCode: "starter",
      subscriptionCredits: 2000,
      purchasedCredits: 50,
    });
    expect(
      await rejection(
        adminChangePlan(
          db,
          ctx.userId,
          {
            workspaceId: ctx.workspaceId,
            planCode: "gold",
            expectedVersion: (await account(ctx.workspaceId)).version,
          },
          settings(),
        ),
      ),
    ).toMatchObject({ fields: [{ code: "credits_plan_unknown" }] });
  });

  it("keeps the ledger append-only", async () => {
    const ctx = await owner();
    await ideas(ctx, runtime());
    await expect(
      system.creditLedgerEntry.updateMany({
        where: { workspaceId: ctx.workspaceId },
        data: { amount: 100 },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("reports provider cost and margin only when they are known", async () => {
    const ctx = await owner();
    const priced: CreditsSettings = {
      trialPeriodCredits: 5,
      prices: { inputPerMTok: 2, outputPerMTok: 8 },
      creditValueMicros: 20_000,
    };
    // The fake provider reports no tokens: cost unknown, margin unknown.
    await ideas(ctx, runtime({}, priced));
    const report = await costReport(db, ctx.workspaceId, new Date(0), priced);
    expect(report).toMatchObject({
      credits: 1,
      providerCostMicros: null,
      marginMicros: null,
      unknownCost: 1,
    });
  });
});

describe("automatic top-up", () => {
  function payments(answers: (ChargeResult | Error)[]): PaymentProvider & { keys: string[] } {
    const keys: string[] = [];
    return {
      name: "test-payments",
      keys,
      charge(input) {
        keys.push(input.idempotencyKey);
        const answer = answers.shift() ?? { status: "succeeded", reference: "PAY-x" };
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    };
  }

  async function enable(ctx: TenantContext, provider: PaymentProvider) {
    const overview = await getBillingOverview(db, ctx, settings(), provider);
    await updateCreditSettings(
      db,
      ctx,
      {
        dailyCap: "",
        periodCap: "",
        autoRechargeEnabled: true,
        autoRechargeThreshold: 4,
        autoRechargeAmount: 10,
        autoRechargePeriodMax: 20,
        version: overview.version,
      },
      settings(),
      provider,
    );
  }

  it("tops up below the threshold, within the period's ceiling", async () => {
    const ctx = await owner();
    const provider = payments([]);
    await enable(ctx, provider);
    // 5 → 4: not below the threshold yet.
    await ideas(ctx, runtime({}, settings(), provider));
    expect(provider.keys).toHaveLength(0);
    // 4 → 3: below 4 → +10.
    await ideas(ctx, runtime({}, settings(), provider));
    expect(provider.keys).toHaveLength(1);
    expect(await account(ctx.workspaceId)).toMatchObject({
      subscriptionCredits: 3,
      purchasedCredits: 10,
    });
    // Spend down and top up again: 20 per period at most.
    await system.creditAccount.update({
      where: { workspaceId: ctx.workspaceId },
      data: { purchasedCredits: 0, subscriptionCredits: 0 },
    });
    expect(await autoRecharge(db, ctx.workspaceId, settings(), provider)).toBe("succeeded");
    await system.creditAccount.update({
      where: { workspaceId: ctx.workspaceId },
      data: { purchasedCredits: 0 },
    });
    expect(await autoRecharge(db, ctx.workspaceId, settings(), provider)).toBe("ceiling_reached");
    expect(provider.keys).toHaveLength(2);
    expect(new Set(provider.keys).size).toBe(2);
  });

  it("never charges again while a top-up's outcome is unknown, and records failures", async () => {
    const ctx = await owner();
    const provider = payments([new Error("network"), { status: "failed", code: "card_declined" }]);
    await enable(ctx, provider);
    await system.creditAccount.update({
      where: { workspaceId: ctx.workspaceId },
      data: { subscriptionCredits: 0 },
    });
    expect(await autoRecharge(db, ctx.workspaceId, settings(), provider)).toBe("uncertain");
    expect(await autoRecharge(db, ctx.workspaceId, settings(), provider)).toBe("skipped");
    expect(provider.keys).toHaveLength(1);
    // An operator resolves the unknown charge as not made; the next attempt is declined.
    await system.creditRecharge.updateMany({
      where: { workspaceId: ctx.workspaceId },
      data: { status: "FAILED", failureCode: "resolved_not_charged", settledAt: new Date() },
    });
    expect(await autoRecharge(db, ctx.workspaceId, settings(), provider)).toBe("failed");
    expect(
      await system.creditRecharge.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "asc" },
        select: { status: true, failureCode: true },
      }),
    ).toEqual([
      { status: "FAILED", failureCode: "resolved_not_charged" },
      { status: "FAILED", failureCode: "card_declined" },
    ]);
    expect(await account(ctx.workspaceId)).toMatchObject({ purchasedCredits: 0 });
  });
});

describe("holds that were never settled", () => {
  it("are released by the scheduler, and the generation behind them is marked failed", async () => {
    const ctx = await owner();
    await ideas(ctx, runtime({}, settings(10)));
    const done = await system.aiGeneration.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    // A second generation whose outcome write never happened: pending behind a held price.
    const generation = { id: crypto.randomUUID() };
    await system.$executeRaw`CREATE TEMP TABLE pending_generation AS SELECT * FROM ai_generations WHERE id = ${done.id}::uuid`;
    await system.$executeRaw`UPDATE pending_generation SET id = ${generation.id}::uuid, status = 'PENDING', output = NULL, error_code = NULL`;
    await system.$executeRaw`INSERT INTO ai_generations SELECT * FROM pending_generation`;
    await system.$executeRaw`DROP TABLE pending_generation`;
    const hold = await db.$transaction((tx) =>
      holdCredits(
        tx,
        {
          workspaceId: ctx.workspaceId,
          feature: "ai_text",
          idempotencyKey: `ai_generation:${generation.id}`,
          reference: null,
          userId: null,
          timeZone: "Asia/Riyadh",
          now: new Date(),
        },
        settings(10),
      ),
    );
    expect(await account(ctx.workspaceId)).toMatchObject({ heldCredits: 1 });

    // Too recent to be abandoned: untouched.
    expect(await releaseStaleHolds(system, db, new Date(), settings(10))).toBe(0);
    const later = new Date(Date.now() + 20 * 60_000);
    expect(await releaseStaleHolds(system, db, later, settings(10))).toBe(1);

    expect(await system.creditHold.findUniqueOrThrow({ where: { id: hold.holdId } })).toMatchObject(
      {
        status: "RELEASED",
      },
    );
    expect(await account(ctx.workspaceId)).toMatchObject({
      heldCredits: 0,
      subscriptionCredits: 9,
    });
    expect(
      await system.aiGeneration.findUniqueOrThrow({ where: { id: generation.id } }),
    ).toMatchObject({ status: "FAILED", errorCode: "not_settled" });
    // Released once: a second run finds nothing.
    expect(await releaseStaleHolds(system, db, later, settings(10))).toBe(0);
  });
});

describe("manual grants from the admin page", () => {
  it("applies a grant once when the same form is submitted twice at the same moment", async () => {
    const ctx = await owner();
    const grant = {
      workspaceId: ctx.workspaceId,
      kind: "PURCHASE",
      amount: 25,
      externalRef: "INV-9",
      requestKey: crypto.randomUUID(),
    };
    const outcomes = await Promise.all([
      adminAddCredits(db, ctx.userId, grant, settings()),
      adminAddCredits(db, ctx.userId, grant, settings()),
      adminAddCredits(db, ctx.userId, grant, settings()),
    ]);
    expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(1);
    expect(await account(ctx.workspaceId)).toMatchObject({ purchasedCredits: 25 });
    expect(
      await system.creditLedgerEntry.count({
        where: { workspaceId: ctx.workspaceId, kind: "PURCHASE" },
      }),
    ).toBe(1);
    expect(
      await system.auditLog.count({
        where: { action: "billing.credits_added", entityId: ctx.workspaceId },
      }),
    ).toBe(1);

    // A retry later (the answer was lost) changes nothing; a new form is a new grant.
    expect(await adminAddCredits(db, ctx.userId, grant, settings())).toEqual({ applied: false });
    await adminAddCredits(
      db,
      ctx.userId,
      { ...grant, requestKey: crypto.randomUUID() },
      settings(),
    );
    expect(await account(ctx.workspaceId)).toMatchObject({ purchasedCredits: 50 });
  });

  it("refuses a grant without a request key", async () => {
    const ctx = await owner();
    expect(
      await rejection(
        adminAddCredits(
          db,
          ctx.userId,
          { workspaceId: ctx.workspaceId, kind: "PURCHASE", amount: 5 },
          settings(),
        ),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("the ledger cannot be rewritten or erased", () => {
  it("refuses UPDATE and DELETE in the database, through any client or raw SQL", async () => {
    const ctx = await owner();
    await ideas(ctx, runtime());
    const before = await system.creditLedgerEntry.count({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(before).toBeGreaterThan(0);
    // The unguarded system client goes straight to the database triggers.
    await expect(
      system.creditLedgerEntry.deleteMany({ where: { workspaceId: ctx.workspaceId } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      system.creditLedgerEntry.updateMany({
        where: { workspaceId: ctx.workspaceId },
        data: { amount: 999 },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      system.$executeRaw`DELETE FROM credit_ledger_entries WHERE workspace_id = ${ctx.workspaceId}::uuid`,
    ).rejects.toThrow(/append-only/);
    // Nested writes through the guarded client are refused before reaching the database.
    const hold = await system.creditHold.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    await expect(
      db.creditHold.update({
        where: { id: hold.id, workspaceId: ctx.workspaceId },
        data: { entries: { deleteMany: {} } },
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISSING" });
    await expect(
      db.workspace.update({
        where: { id: ctx.workspaceId },
        data: { creditLedgerEntries: { deleteMany: {} } },
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISSING" });
    expect(await system.creditLedgerEntry.count({ where: { workspaceId: ctx.workspaceId } })).toBe(
      before,
    );
  });

  it("allows deleting only the workspace a purge transaction names", async () => {
    const ctx = await owner();
    const other = await owner();
    await ideas(ctx, runtime());
    await ideas(other, runtime());
    await expect(
      system.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('flexibx.purge_workspace', ${ctx.workspaceId}, true)`;
        await tx.$executeRaw`DELETE FROM credit_ledger_entries WHERE workspace_id = ${other.workspaceId}::uuid`;
      }),
    ).rejects.toThrow(/append-only/);
    await system.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('flexibx.purge_workspace', ${ctx.workspaceId}, true)`;
      await tx.$executeRaw`DELETE FROM credit_ledger_entries WHERE workspace_id = ${ctx.workspaceId}::uuid`;
    });
    expect(await system.creditLedgerEntry.count({ where: { workspaceId: ctx.workspaceId } })).toBe(
      0,
    );
    expect(
      await system.creditLedgerEntry.count({ where: { workspaceId: other.workspaceId } }),
    ).toBeGreaterThan(0);
    // The setting was local to that transaction.
    await expect(
      system.$executeRaw`DELETE FROM credit_ledger_entries WHERE workspace_id = ${other.workspaceId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });
});

describe("plan changes from the admin page", () => {
  it("applies once when the same form is submitted several times at once", async () => {
    const ctx = await owner();
    await adminAddCredits(
      db,
      ctx.userId,
      {
        workspaceId: ctx.workspaceId,
        kind: "PURCHASE",
        amount: 5,
        requestKey: crypto.randomUUID(),
      },
      settings(),
    );
    const before = await account(ctx.workspaceId);
    const form = {
      workspaceId: ctx.workspaceId,
      planCode: "growth",
      expectedVersion: before.version,
    };
    const outcomes = await Promise.allSettled([
      adminChangePlan(db, ctx.userId, form, settings()),
      adminChangePlan(db, ctx.userId, form, settings()),
      adminChangePlan(db, ctx.userId, form, settings()),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ fields: [{ code: "stale_status" }] });
      }
    }
    const after = await account(ctx.workspaceId);
    expect(after).toMatchObject({
      planCode: "growth",
      subscriptionCredits: 10000,
      version: before.version + 1,
    });
    // One allowance granted, one audit entry with the previous plan.
    expect(
      await system.creditLedgerEntry.count({
        where: { workspaceId: ctx.workspaceId, kind: "SUBSCRIPTION_GRANT", note: "growth" },
      }),
    ).toBe(1);
    const audits = await system.auditLog.findMany({
      where: { action: "billing.plan_changed", entityId: ctx.workspaceId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ planCode: "growth", previousPlan: "trial" });

    // A later retry of the same (now stale) form changes nothing either.
    expect(await rejection(adminChangePlan(db, ctx.userId, form, settings()))).toMatchObject({
      fields: [{ code: "stale_status" }],
    });
    expect((await account(ctx.workspaceId)).periodStart).toEqual(after.periodStart);
  });
});

describe("releasing abandoned holds", () => {
  it("one hold that cannot be released never blocks the others", async () => {
    const ctx = await owner();
    const hold = (key: string) =>
      db.$transaction((tx) =>
        holdCredits(
          tx,
          {
            workspaceId: ctx.workspaceId,
            feature: "ai_text",
            idempotencyKey: key,
            reference: null,
            userId: null,
            timeZone: "Asia/Riyadh",
            now: new Date(),
          },
          settings(10),
        ),
      );
    // The oldest hold names a generation id that is not a uuid: releasing it fails.
    await hold("ai_generation:not-a-uuid");
    await hold("k-good-1");
    await hold("k-good-2");
    const later = new Date(Date.now() + 20 * 60_000);
    const errors: unknown[] = [];
    const released = await releaseStaleHolds(system, db, later, settings(10), 50, {
      error: (object) => errors.push(object),
    });
    expect(released).toBe(2);
    expect(errors).toHaveLength(1);
    expect(
      await system.creditHold.count({
        where: { workspaceId: ctx.workspaceId, status: "RELEASED" },
      }),
    ).toBe(2);
  });
});
