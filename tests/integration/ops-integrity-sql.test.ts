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
const start = integrity.indexOf("SELECT 'migrations_unfinished'");
const UNFINISHED = integrity.slice(start, integrity.indexOf(";", start));

class Rollback extends Error {}

/** Runs `setup` and the check in one transaction, returns the count, rolls everything back. */
async function unfinishedAfter(setup: (tx: Prisma.TransactionClient) => Promise<void>) {
  let count = -1;
  try {
    await system.$transaction(async (tx) => {
      await setup(tx);
      // The statement is read from integrity.sql itself (no input): the point is to run
      // exactly what the ops script runs.
      // eslint-disable-next-line no-restricted-properties -- constant SQL from the repository
      const rows = await tx.$queryRawUnsafe<{ count: bigint }[]>(UNFINISHED);
      count = Number(rows[0]?.count ?? -1);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return count;
}

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
