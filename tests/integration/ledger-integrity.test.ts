// Continuous credit-ledger integrity (src/server/monitoring/ledger-integrity.ts) on the
// real database: detection of each inconsistency, ops-status severity, failure and
// timeout handling, the cadence claim, and proof that the check changes nothing.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import {
  countLedgerInconsistencies,
  LEDGER_INTEGRITY_CHECK,
  runLedgerIntegrityCheck,
} from "@/server/monitoring/ledger-integrity";
import { collectOpsStatus } from "@/server/monitoring/ops-status";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system } = createTestDb();
const HOUR = 3_600_000;

beforeEach(async () => {
  await resetDatabase(system);
});
afterAll(async () => {
  await system.$disconnect();
});

/** A workspace with a credit account; `ledger` writes one consistent entry for it. */
async function account(
  balances: { subscription: number; purchased?: number; held?: number },
  options: { ledger?: "consistent" | "none" | "stale" } = {},
) {
  const { workspaceId } = await createTenant(system, { role: WorkspaceRole.OWNER });
  const now = new Date();
  await system.creditAccount.create({
    data: {
      workspaceId,
      planCode: "starter",
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * 24 * HOUR),
      subscriptionCredits: balances.subscription,
      purchasedCredits: balances.purchased ?? 0,
      heldCredits: balances.held ?? 0,
    },
  });
  const ledger = options.ledger ?? "consistent";
  if (ledger !== "none") {
    const subscriptionAfter =
      ledger === "stale" ? balances.subscription + 7 : balances.subscription;
    await system.creditLedgerEntry.create({
      data: {
        workspaceId,
        kind: "SUBSCRIPTION_GRANT",
        amount: subscriptionAfter,
        subscriptionAfter,
        purchasedAfter: balances.purchased ?? 0,
        heldAfter: balances.held ?? 0,
      },
    });
  }
  return workspaceId;
}

async function openHold(workspaceId: string, amount: number) {
  await system.creditHold.create({
    data: {
      workspaceId,
      feature: "social_reply",
      amount,
      subscriptionPortion: amount,
      purchasedPortion: 0,
      idempotencyKey: `hold-${String(amount)}-${Date.now().toString(36)}`,
      priceVersion: "test",
      status: "HELD",
    },
  });
}

const check = async (name: string, now = new Date()) =>
  (await collectOpsStatus(system, now, { ledgerIntegrityIntervalMs: HOUR })).checks.find(
    (entry) => entry.name === name,
  );

/** Checksum of the three credit tables (any change to any row changes it). */
async function creditChecksum(): Promise<string> {
  const rows = await system.$queryRaw<{ sum: string }[]>`
    SELECT md5(
      COALESCE((SELECT string_agg(t::text, '|' ORDER BY workspace_id) FROM credit_accounts t), '') ||
      COALESCE((SELECT string_agg(t::text, '|' ORDER BY sequence) FROM credit_ledger_entries t), '') ||
      COALESCE((SELECT string_agg(t::text, '|' ORDER BY id) FROM credit_holds t), '')
    ) AS sum`;
  return rows[0]?.sum ?? "";
}

describe("credit ledger integrity check", () => {
  it("healthy ledger: ok, zero counts, ops-status ok", async () => {
    const workspace = await account({ subscription: 10, purchased: 5, held: 3 });
    await openHold(workspace, 3);
    await account({ subscription: 0 }, { ledger: "none" }); // empty account, no entry: fine

    const run = await runLedgerIntegrityCheck(system, new Date(), { intervalMs: HOUR });
    expect(run).toEqual({
      status: "ok",
      counts: { balance_without_ledger: 0, balance_mismatch: 0, held_mismatch: 0 },
    });
    for (const name of [
      "credit_ledger_balance_without_ledger",
      "credit_ledger_balance_mismatch",
      "credit_ledger_held_mismatch",
      "credit_ledger_integrity_check_failed",
      "credit_ledger_integrity_age_seconds",
    ]) {
      expect((await check(name))?.level, name).toBe("ok");
    }
  });

  it("detects a balance without any ledger entry (critical)", async () => {
    await account({ subscription: 25 }, { ledger: "none" });
    const run = await runLedgerIntegrityCheck(system, new Date(), { intervalMs: HOUR });
    expect(run).toMatchObject({ status: "violations", counts: { balance_without_ledger: 1 } });
    expect(await check("credit_ledger_balance_without_ledger")).toMatchObject({
      value: 1,
      level: "critical",
    });
    const status = await collectOpsStatus(system, new Date(), { ledgerIntegrityIntervalMs: HOUR });
    expect(status.status).toBe("critical");
    // Counts only: no workspace id in the status.
    expect(JSON.stringify(status)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("detects a balance that differs from the last ledger entry (critical)", async () => {
    await account({ subscription: 10 }, { ledger: "stale" });
    await account({ subscription: 3 }); // consistent one is not counted
    const run = await runLedgerIntegrityCheck(system, new Date(), { intervalMs: HOUR });
    expect(run).toMatchObject({
      status: "violations",
      counts: { balance_without_ledger: 0, balance_mismatch: 1, held_mismatch: 0 },
    });
    expect(await check("credit_ledger_balance_mismatch")).toMatchObject({
      value: 1,
      level: "critical",
    });
  });

  it("detects held credits that differ from the open holds (critical)", async () => {
    const workspace = await account({ subscription: 10, held: 4 });
    await openHold(workspace, 1); // 4 held on the account, 1 in open holds
    const run = await runLedgerIntegrityCheck(system, new Date(), { intervalMs: HOUR });
    expect(run).toMatchObject({ status: "violations", counts: { held_mismatch: 1 } });
    expect(await check("credit_ledger_held_mismatch")).toMatchObject({
      value: 1,
      level: "critical",
    });
  });

  it("changes nothing (read-only transaction; table checksums identical)", async () => {
    const workspace = await account({ subscription: 10, held: 4 });
    await openHold(workspace, 1);
    await account({ subscription: 25 }, { ledger: "none" });
    const before = await creditChecksum();
    await runLedgerIntegrityCheck(system, new Date(), { intervalMs: HOUR });
    await countLedgerInconsistencies(system);
    expect(await creditChecksum()).toBe(before);
  });

  it("a query failure is recorded as an error (critical), never as ok", async () => {
    await account({ subscription: 10 });
    // A client whose transaction fails (e.g. the database went away mid-check).
    const failing = new Proxy(system, {
      get(target, property, receiver) {
        if (property === "$transaction") {
          return () => Promise.reject(new Error("injected: connection lost"));
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const run = await runLedgerIntegrityCheck(failing, new Date(), { intervalMs: HOUR });
    expect(run).toEqual({ status: "error", errorCode: "database_error" });
    expect(await check("credit_ledger_integrity_check_failed")).toMatchObject({
      value: 1,
      level: "critical",
    });
    // Never completed: the age check is a warning (unknown), not ok.
    expect(await check("credit_ledger_integrity_age_seconds")).toMatchObject({
      value: null,
      level: "warning",
    });
    const status = await collectOpsStatus(system, new Date(), { ledgerIntegrityIntervalMs: HOUR });
    expect(status.status).toBe("critical");
  });

  it("a statement timeout (lock wait) is recorded as a timeout error", async () => {
    await account({ subscription: 10 });
    // Another session holds an exclusive lock on credit_accounts for longer than the
    // check's statement timeout.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = system.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE credit_accounts IN ACCESS EXCLUSIVE MODE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    try {
      const run = await runLedgerIntegrityCheck(system, new Date(), {
        intervalMs: HOUR,
        timeoutMs: 300,
      });
      expect(run).toEqual({ status: "error", errorCode: "timeout" });
    } finally {
      release();
      await holder;
    }
    const row = await system.opsCheckResult.findUniqueOrThrow({
      where: { name: LEDGER_INTEGRITY_CHECK },
    });
    expect(row).toMatchObject({ status: "error", errorCode: "timeout", completedAt: null });
  });

  it("runs at most once per interval, across concurrent ticks", async () => {
    await account({ subscription: 10 });
    const now = new Date();
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => runLedgerIntegrityCheck(system, now, { intervalMs: HOUR })),
    );
    expect(runs.filter((run) => run.status === "ok")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "skipped")).toHaveLength(4);
    // Before the interval has passed: skipped; after: runs again.
    expect(
      await runLedgerIntegrityCheck(system, new Date(now.getTime() + HOUR - 1000), {
        intervalMs: HOUR,
      }),
    ).toEqual({ status: "skipped" });
    expect(
      (await runLedgerIntegrityCheck(system, new Date(now.getTime() + HOUR), { intervalMs: HOUR }))
        .status,
    ).toBe("ok");
  });

  it("a stale result is a warning; the last completed counts stay until the next run", async () => {
    await account({ subscription: 10 }, { ledger: "stale" });
    const long = new Date(Date.now() - 3 * HOUR);
    await runLedgerIntegrityCheck(system, long, { intervalMs: HOUR }, () => long);
    const now = new Date();
    expect(await check("credit_ledger_integrity_age_seconds", now)).toMatchObject({
      level: "warning",
    });
    expect(await check("credit_ledger_balance_mismatch", now)).toMatchObject({
      value: 1,
      level: "critical",
    });
  });
});
