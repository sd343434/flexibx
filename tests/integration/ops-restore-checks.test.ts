// scripts/ops/sql/restore-checks.sql and schema-objects.sql (run by db-verify.sh after a
// restore) on the real migrated database: every check is 0 on consistent data made by the
// services, each one counts the corruption it is about, and the committed list of
// expected indexes and constraints equals the migrated schema. Every corruption is made
// inside a transaction that is always rolled back.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { FakeVideoProvider } from "@/server/ai/providers/video/fake";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import {
  requestVideoGeneration,
  runVideoJob,
} from "@/server/videos/generation/video-generation-service";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const sql = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../scripts/ops/sql", name), "utf8");

beforeEach(async () => {
  await resetDatabase(system);
});
afterAll(async () => {
  await system.$disconnect();
});

/** The statements of an ops SQL file, exactly as psql runs them (comments dropped). */
function statements(file: string): string[] {
  return sql(file)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

class Rollback extends Error {}

/** Runs `setup`, then every restore check, in one transaction that is rolled back. */
async function checksAfter(
  setup: (tx: Prisma.TransactionClient) => Promise<unknown> = () => Promise.resolve(),
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  try {
    await system.$transaction(async (tx) => {
      await setup(tx);
      for (const statement of statements("restore-checks.sql")) {
        // Constant SQL read from the repository (no input): exactly what db-verify.sh runs.
        // eslint-disable-next-line no-restricted-properties -- constant SQL from the repository
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(statement);
        const row = Object.values(rows[0] ?? {});
        result[String(row[0])] = Number(row[1]);
      }
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result;
}

async function schemaObjects(
  setup: (tx: Prisma.TransactionClient) => Promise<unknown> = () => Promise.resolve(),
): Promise<string[]> {
  let lines: string[] = [];
  try {
    await system.$transaction(async (tx) => {
      await setup(tx);
      const [statement] = statements("schema-objects.sql");
      // eslint-disable-next-line no-restricted-properties -- constant SQL from the repository
      const rows = await tx.$queryRawUnsafe<{ kind: string; tbl: string; name: string }[]>(
        statement ?? "",
      );
      lines = rows.map((row) => `${row.kind}\t${row.tbl}\t${row.name}`);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return lines;
}

const EXPECTED = sql("expected-schema-objects.tsv")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"));

/** A finished video job (reserved, captured, released) and an open credit hold. */
async function consistentData() {
  const ctx = await createTenant(system);
  const storage = new MemoryStorageService();
  const deps = {
    db,
    provider: new FakeVideoProvider({ scenarios: [] }),
    writeTarget: () =>
      Promise.resolve({
        provider: "LEGACY_S3" as const,
        storage,
        confirm: () => Promise.resolve(),
      }),
    maxPolls: 5,
    sleep: () => Promise.resolve(),
  };
  const { jobId } = await requestVideoGeneration(deps, ctx, {
    title: "Clip",
    prompt: "A cup of coffee on a table",
    durationSeconds: 8,
    aspectRatio: "16:9",
    resolution: "720p",
    audio: false,
    tier: "DRAFT",
  });
  expect(await runVideoJob(deps, ctx.workspaceId, jobId)).toMatchObject({ status: "finished" });
  return { ctx, jobId };
}

describe("restore-checks.sql", () => {
  it("is all zero on consistent data made by the services", async () => {
    await consistentData();
    const checks = await checksAfter();
    expect(Object.keys(checks).sort()).toEqual(
      [
        "credit_balances_negative",
        "credit_holds_settlement_mismatch",
        "credit_ledger_negative_after",
        "indexes_invalid",
        "video_usage_vs_jobs",
      ].sort(),
    );
    expect(Object.values(checks).every((value) => value === 0)).toBe(true);
  });

  it("counts a video job whose totals no longer match its usage ledger", async () => {
    const { jobId } = await consistentData();
    const checks = await checksAfter(
      (tx) => tx.$executeRaw`
        UPDATE video_generation_jobs SET released_micros = released_micros - 1
        WHERE id = ${jobId}::uuid`,
    );
    expect(checks.video_usage_vs_jobs).toBe(1);
  });

  it("counts an index left invalid", async () => {
    const checks = await checksAfter(
      (tx) => tx.$executeRaw`
        UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = 'insights_sync_runs_one_running'::regclass`,
    );
    expect(checks.indexes_invalid).toBe(1);
  });

  it("counts negative credits and a hold whose settlement does not match its status", async () => {
    const { ctx } = await consistentData();
    const checks = await checksAfter(async (tx) => {
      // The tables' own CHECKs and triggers would refuse these rows: removed in this
      // transaction only (rolled back), as in a source where a guard was switched off.
      await tx.$executeRaw`
        DO $$ DECLARE r record; BEGIN
          FOR r IN SELECT conrelid::regclass AS t, conname FROM pg_constraint
            WHERE conrelid IN ('credit_accounts'::regclass, 'credit_holds'::regclass)
              AND contype = 'c'
          LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.t, r.conname); END LOOP;
        END $$`;
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        INSERT INTO credit_accounts (workspace_id, plan_code, period_start, period_end,
          subscription_credits, purchased_credits, held_credits)
        VALUES (${ctx.workspaceId}::uuid, 'test', now(), now() + interval '30 days', -5, 0, 0)
        ON CONFLICT (workspace_id) DO UPDATE SET subscription_credits = -5`;
      await tx.$executeRaw`
        INSERT INTO credit_holds (workspace_id, feature, amount, subscription_portion,
          purchased_portion, idempotency_key, price_version, status, settled_at)
        VALUES (${ctx.workspaceId}::uuid, 'social_reply', 1, 1, 0, 'k-restore', 'test',
          'HELD', now())`;
    });
    expect(checks.credit_balances_negative).toBe(1);
    expect(checks.credit_holds_settlement_mismatch).toBe(1);
  });
});

describe("schema-objects.sql", () => {
  it("equals the committed expected-schema-objects.tsv (regenerate it after a migration)", async () => {
    expect(await schemaObjects()).toEqual(EXPECTED);
    // The guards a restore must bring back are in the list.
    expect(EXPECTED).toContain("unique_index\tinsights_sync_runs\tinsights_sync_runs_one_running");
    expect(EXPECTED).toContain("constraint_c\tinsights_sync_runs\tinsights_sync_runs_state_check");
  });

  it("shows a dropped unique index and a constraint added by hand", async () => {
    const present = await schemaObjects(async (tx) => {
      await tx.$executeRaw`DROP INDEX insights_sync_runs_one_running`;
      await tx.$executeRaw`ALTER TABLE users ADD CONSTRAINT users_hand_made CHECK (true)`;
    });
    expect(EXPECTED.filter((line) => !present.includes(line))).toEqual([
      "unique_index\tinsights_sync_runs\tinsights_sync_runs_one_running",
    ]);
    expect(present.filter((line) => !EXPECTED.includes(line))).toEqual([
      "constraint_c\tusers\tusers_hand_made",
    ]);
  });
});
