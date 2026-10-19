// scripts/ops/sql/integrity.sql `migrations_unfinished` on the real database. Every case
// runs inside a transaction that is always rolled back: the test database's migration
// history is never changed.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";

import { createTestDb } from "./helpers";

const { system } = createTestDb();
afterAll(async () => {
  await system.$disconnect();
});

const integrity = readFileSync(
  join(import.meta.dirname, "../../scripts/ops/sql/integrity.sql"),
  "utf8",
);
/** The statement of one named check, exactly as integrity.sql has it. */
function statement(check: string) {
  const start = integrity.indexOf(`SELECT '${check}'`);
  if (start < 0) throw new Error(`no check ${check} in integrity.sql`);
  return integrity.slice(start, integrity.indexOf(";", start));
}
const UNFINISHED = statement("migrations_unfinished");
const GUARD_TRIGGERS = statement("guard_triggers_inactive");

class Rollback extends Error {}

/** Runs `setup` and a check in one transaction, returns the count, rolls everything back. */
async function countAfter(check: string, setup: (tx: Prisma.TransactionClient) => Promise<void>) {
  let count = -1;
  try {
    await system.$transaction(async (tx) => {
      await setup(tx);
      // The statement is read from integrity.sql itself (no input): the point is to run
      // exactly what the ops script runs. Wrapped so a check's value column (unnamed in
      // some checks) is read by position.
      // eslint-disable-next-line no-restricted-properties -- constant SQL from the repository
      const rows = await tx.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT r.value AS count FROM (${check}) AS r (name, value)`,
      );
      count = Number(rows[0]?.count ?? -1);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return count;
}
const unfinishedAfter = (setup: (tx: Prisma.TransactionClient) => Promise<void>) =>
  countAfter(UNFINISHED, setup);

const attempt = (
  tx: Prisma.TransactionClient,
  name: string,
  state: { finished: boolean; rolledBack: boolean },
) => tx.$executeRaw`
  INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
  VALUES (${randomUUID()}, ${"0".repeat(64)}, ${name}, now(),
          ${state.finished ? new Date() : null}, ${state.rolledBack ? new Date() : null}, 0)`;

describe("integrity.sql migrations_unfinished", () => {
  it("is 0 for the migrated test database", async () => {
    expect(await unfinishedAfter(() => Promise.resolve())).toBe(0);
  });

  it("ignores an attempt that was rolled back and then applied again", async () => {
    const name = `29990101000000_rolled_back_then_applied_${randomUUID().slice(0, 8)}`;
    expect(
      await unfinishedAfter(async (tx) => {
        await attempt(tx, name, { finished: false, rolledBack: true });
        await attempt(tx, name, { finished: true, rolledBack: false });
      }),
    ).toBe(0);
  });

  it("counts a migration that was only rolled back, and an unresolved failed attempt", async () => {
    const id = randomUUID().slice(0, 8);
    expect(
      await unfinishedAfter(async (tx) => {
        await attempt(tx, `29990101000001_only_rolled_back_${id}`, {
          finished: false,
          rolledBack: true,
        });
      }),
    ).toBe(1);
    expect(
      await unfinishedAfter(async (tx) => {
        // Failed, never resolved — even next to an applied attempt of the same name.
        const name = `29990101000002_failed_${id}`;
        await attempt(tx, name, { finished: true, rolledBack: false });
        await attempt(tx, name, { finished: false, rolledBack: false });
      }),
    ).toBe(1);
  });
});

describe("integrity.sql guard_triggers_inactive", () => {
  const guardsAfter = (...ddl: string[]) =>
    countAfter(GUARD_TRIGGERS, async (tx) => {
      // Constant DDL from this file, never input; rolled back with the transaction.
      // eslint-disable-next-line no-restricted-properties -- constant SQL from this test
      for (const sql of ddl) await tx.$executeRawUnsafe(sql);
    });

  it("lists exactly the triggers the migrations create", async () => {
    const listed = [...GUARD_TRIGGERS.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map(
      ([, table, trigger]) => `${table}.${trigger}`,
    );
    const migrated = await system.$queryRaw<{ name: string }[]>`
      SELECT c.relname || '.' || t.tgname AS name FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`;
    // A new guard trigger must be added to integrity.sql, or a restore could lose it unseen.
    expect([...listed].sort()).toEqual(migrated.map((row) => row.name).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("is 0 for the migrated test database", async () => {
    expect(await guardsAfter()).toBe(0);
  });

  it("counts a guard that is dropped, disabled or fires on replicas only", async () => {
    expect(await guardsAfter("DROP TRIGGER users_platform_admin_grant_guard ON users")).toBe(1);
    expect(
      await guardsAfter("ALTER TABLE content_reviews DISABLE TRIGGER content_reviews_immutable"),
    ).toBe(1);
    // pg_dump keeps ENABLE REPLICA; such a trigger never fires for the application.
    expect(
      await guardsAfter(
        "ALTER TABLE usage_ledger_entries ENABLE REPLICA TRIGGER usage_ledger_entries_append_only",
      ),
    ).toBe(1);
    expect(
      await guardsAfter(
        "ALTER TABLE content_reviews DISABLE TRIGGER content_reviews_immutable",
        "ALTER TABLE social_posts DISABLE TRIGGER social_posts_same_workspace",
      ),
    ).toBe(2);
    // Creator Studio guards (Passes 8–9): the project-deletion guard, the append-only
    // event log and the deletion record are checked like the others.
    expect(
      await guardsAfter(
        "ALTER TABLE creator_jobs DISABLE TRIGGER creator_jobs_project_active",
        "ALTER TABLE creator_project_events ENABLE REPLICA TRIGGER creator_project_events_append_only",
        "DROP TRIGGER creator_storage_deletions_identity ON creator_storage_deletions",
      ),
    ).toBe(3);
    // A table missing under its name (not restored, or renamed) loses all its guards.
    expect(await guardsAfter("ALTER TABLE content_reviews RENAME TO content_reviews_moved")).toBe(
      3,
    );
    expect(await guardsAfter("ALTER TABLE creator_jobs RENAME TO creator_jobs_moved")).toBe(4);
    // ENABLE ALWAYS fires in every session: still a working guard.
    expect(
      await guardsAfter(
        "ALTER TABLE content_reviews ENABLE ALWAYS TRIGGER content_reviews_immutable",
      ),
    ).toBe(0);
  });

  it("the ledger check also ignores a guard that fires on replicas only", async () => {
    expect(
      await countAfter(statement("ledger_guard_triggers_missing"), async (tx) => {
        await tx.$executeRaw`ALTER TABLE credit_ledger_entries ENABLE REPLICA TRIGGER credit_ledger_entries_append_only`;
      }),
    ).toBe(1);
  });
});
