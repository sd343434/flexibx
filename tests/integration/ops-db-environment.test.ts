// scripts/ops/db-environment.sh (Pass 15): the environment marker that the staging
// migrate job and the staging gate assert before touching a database. Runs the real
// script against the integration database (its comment is saved and put back).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "./helpers";
import { resolveTestDatabaseUrl } from "./test-database";

const SCRIPT = join(import.meta.dirname, "../../scripts/ops/db-environment.sh");
const url = resolveTestDatabaseUrl();
const { system } = createTestDb();
const database = new URL(url).pathname.slice(1);
let original: string | null = null;

async function setComment(comment: string | null) {
  // Identifier and literal quoted by PostgreSQL (format %I / %L); test database only.
  const rows = await system.$queryRaw<{ statement: string }[]>`
    SELECT format('COMMENT ON DATABASE %I IS %L', current_database(), ${comment}::text) AS statement`;
  const statement = rows[0]?.statement;
  if (statement === undefined) throw new Error("no statement");
  // eslint-disable-next-line no-restricted-properties -- statement built by format() above
  await system.$executeRawUnsafe(statement);
}

function run(...args: string[]) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", DATABASE_URL: url },
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

beforeAll(async () => {
  const rows = await system.$queryRaw<{ comment: string | null }[]>`
    SELECT shobj_description(oid, 'pg_database') AS comment
    FROM pg_database WHERE datname = current_database()`;
  original = rows[0]?.comment ?? null;
  await setComment(null);
});
afterAll(async () => {
  await setComment(original);
  await system.$disconnect();
});

describe("database environment marker", () => {
  it("fails the assertion on an unmarked database", () => {
    const result = run("assert", "staging");
    expect(result.status).toBe(1);
    expect(result.out).toContain(`database ${database} is unmarked, expected staging`);
  });

  it("marks only with the database's name repeated, then asserts it", () => {
    expect(run("mark", "staging").status).toBe(2);
    expect(run("mark", "staging", "--confirm-database", "another_db").status).toBe(2);
    const marked = run("mark", "staging", "--confirm-database", database);
    expect(marked.status).toBe(0);
    expect(marked.out).toContain('"status":"MARKED"');
    expect(run("assert", "staging")).toMatchObject({ status: 0 });
    expect(run("show").out).toContain('"environment":"staging"');
  });

  it("refuses the wrong environment and never re-marks a marked database", () => {
    const wrong = run("assert", "production");
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain("is staging, expected production");
    const remark = run("mark", "production", "--confirm-database", database);
    expect(remark.status).toBe(2);
    expect(remark.out).toContain("already marked staging");
    expect(run("assert", "staging").status).toBe(0);
  });

  it("refuses to overwrite a comment it did not write, and unknown environments", async () => {
    await setComment("owned by someone else");
    expect(run("mark", "staging", "--confirm-database", database).status).toBe(2);
    expect(run("assert", "staging").status).toBe(1);
    expect(run("assert", "qa").status).toBe(2);
    await setComment(null);
  });

  it("never prints the connection URL or its password", () => {
    const password = new URL(url).password;
    for (const args of [["show"], ["assert", "staging"], ["assert", "production"]]) {
      const { out } = run(...args);
      expect(out).not.toContain(url);
      if (password !== "") expect(out).not.toContain(password);
    }
  });
});
