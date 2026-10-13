import { Prisma, type PrismaClient } from "@/generated/prisma/client";

// Continuous credit-ledger integrity (the same invariants scripts/ops/sql/integrity.sql
// checks after a restore), run by the scheduled tick at a configurable cadence — never per
// HTTP request. GET /api/internal/ops-status only reads the stored result (ops-status.ts).
//
// - Read-only: one READ ONLY transaction with a statement timeout; it cannot change a
//   balance, a ledger entry or a hold (tested with table checksums).
// - Bounded: one run per interval across all processes (atomic claim on
//   ops_check_results), each statement capped by `timeoutMs`.
// - Counts only: no workspace id or amount leaves this module.
// - A failure is recorded as `error` (critical in ops-status), never as "no violation".
//
// SYSTEM PATH (reviewed): cross-workspace aggregate counts over credit_accounts,
// credit_ledger_entries and credit_holds.

export const LEDGER_INTEGRITY_CHECK = "credit-ledger-integrity";
export const LEDGER_INTEGRITY_TIMEOUT_MS = 20_000;

export interface LedgerIntegrityCounts {
  /** Accounts with a non-zero balance (or held credits) and no ledger entry at all. */
  readonly balance_without_ledger: number;
  /** Accounts whose balances differ from their last ledger entry. */
  readonly balance_mismatch: number;
  /** Accounts whose held credits differ from the sum of their open holds. */
  readonly held_mismatch: number;
}

export type LedgerIntegrityRun =
  | { readonly status: "skipped" }
  | { readonly status: "ok" | "violations"; readonly counts: LedgerIntegrityCounts }
  | { readonly status: "error"; readonly errorCode: "timeout" | "database_error" };

interface CountRow {
  readonly balance_without_ledger: bigint;
  readonly balance_mismatch: bigint;
  readonly held_mismatch: bigint;
}

/** The three counts, in one read-only transaction with a statement timeout. */
export async function countLedgerInconsistencies(
  system: PrismaClient,
  timeoutMs: number = LEDGER_INTEGRITY_TIMEOUT_MS,
): Promise<LedgerIntegrityCounts> {
  const rows = await system.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      return tx.$queryRaw<CountRow[]>`
        SELECT
          count(*) FILTER (
            WHERE last.workspace_id IS NULL
              AND (a.subscription_credits <> 0 OR a.purchased_credits <> 0 OR a.held_credits <> 0)
          ) AS balance_without_ledger,
          count(*) FILTER (
            WHERE last.workspace_id IS NOT NULL
              AND (last.subscription_after <> a.subscription_credits
                OR last.purchased_after <> a.purchased_credits
                OR last.held_after <> a.held_credits)
          ) AS balance_mismatch,
          count(*) FILTER (WHERE a.held_credits <> COALESCE(open.held, 0)) AS held_mismatch
        FROM credit_accounts a
        LEFT JOIN LATERAL (
          SELECT e.workspace_id, e.subscription_after, e.purchased_after, e.held_after
          FROM credit_ledger_entries e
          WHERE e.workspace_id = a.workspace_id
          ORDER BY e.sequence DESC
          LIMIT 1
        ) last ON true
        LEFT JOIN LATERAL (
          SELECT sum(h.amount) AS held FROM credit_holds h
          WHERE h.workspace_id = a.workspace_id AND h.status = 'HELD'
        ) open ON true`;
    },
    { timeout: timeoutMs + 5_000, maxWait: 5_000 },
  );
  const row = rows[0];
  if (row === undefined) throw new Error("ledger integrity query returned no row");
  return {
    balance_without_ledger: Number(row.balance_without_ledger),
    balance_mismatch: Number(row.balance_mismatch),
    held_mismatch: Number(row.held_mismatch),
  };
}

/** A statement timeout, lock timeout or expired transaction; anything else is a database error. */
function errorCode(error: unknown): "timeout" | "database_error" {
  const meta =
    error instanceof Prisma.PrismaClientKnownRequestError ? JSON.stringify(error.meta ?? {}) : "";
  const text = `${error instanceof Error ? error.message : ""} ${meta}`;
  return /57014|55P03|statement timeout|lock timeout|transaction already closed|expired/i.test(text)
    ? "timeout"
    : "database_error";
}

/**
 * Runs the check when the previous run started at least `intervalMs` ago (atomic claim:
 * concurrent ticks run it once), and stores the outcome. Returns `skipped` otherwise.
 */
export async function runLedgerIntegrityCheck(
  system: PrismaClient,
  now: Date,
  options: { readonly intervalMs: number; readonly timeoutMs?: number },
  clock: () => Date = () => new Date(),
): Promise<LedgerIntegrityRun> {
  const due = new Date(now.getTime() - options.intervalMs);
  const claimed = await system.$queryRaw<{ name: string }[]>`
    INSERT INTO ops_check_results (name, status, started_at, updated_at)
    VALUES (${LEDGER_INTEGRITY_CHECK}, 'running', ${now}, ${now})
    ON CONFLICT (name) DO UPDATE
      SET status = 'running', started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at
      WHERE ops_check_results.started_at <= ${due}
    RETURNING name`;
  if (claimed.length === 0) return { status: "skipped" };

  let result: LedgerIntegrityRun;
  try {
    const counts = await countLedgerInconsistencies(system, options.timeoutMs);
    const total = counts.balance_without_ledger + counts.balance_mismatch + counts.held_mismatch;
    result = { status: total === 0 ? "ok" : "violations", counts };
  } catch (error) {
    result = { status: "error", errorCode: errorCode(error) };
  }

  const finishedAt = clock();
  const durationMs = Math.max(0, finishedAt.getTime() - now.getTime());
  await system.opsCheckResult.update({
    where: { name: LEDGER_INTEGRITY_CHECK },
    data:
      result.status === "error"
        ? { status: "error", errorCode: result.errorCode, finishedAt, durationMs }
        : {
            status: result.status,
            counts: { ...result.counts },
            errorCode: null,
            completedAt: finishedAt,
            finishedAt,
            durationMs,
          },
  });
  return result;
}
