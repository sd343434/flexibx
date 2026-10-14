// TOTP claims under the production role model (migration 20261014150000,
// scripts/ops/sql/db-roles.sql): the runtime and grant roles claim codes only through
// public.two_factor_claim_code(), cannot touch two_factor_used_codes directly (so they
// cannot delete an unexpired claim and replay a code), and the function removes only the
// caller's account's expired claims, by the database clock, exactly once under
// concurrency. Account deletion still removes the account's claims.
//
// Disposable database and roles (support/role-database.ts): needs a superuser connection
// (ROLE_TEST_ADMIN_DATABASE_URL, or the test database's own user in CI). Skipped otherwise.
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { claimTotpCode } from "@/server/auth/totp-replay";

import { createRoleDatabase, ddl, type RoleDatabase, type RoleName } from "./support/role-database";

let roleDb: RoleDatabase | undefined;

beforeAll(async () => {
  roleDb = await createRoleDatabase("totp");
}, 180_000);

afterAll(async () => {
  await roleDb?.teardown();
}, 60_000);

function ready(ctx: { skip: (reason: string) => void }): RoleDatabase {
  if (roleDb === undefined) throw new Error("not set up");
  if (!roleDb.available) ctx.skip(roleDb.skipReason);
  return roleDb;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "SUCCEEDED";
}

const hash = (userId: string, code: string) =>
  createHash("sha256").update(`${userId}:${code}`).digest("hex");

/** An account row written by the owner (the claim path, not sign-up, is under test). */
async function account(owner: PrismaClient): Promise<string> {
  const id = randomUUID();
  await owner.user.create({
    data: { id, email: `totp-${id}@example.com`, name: "Staff", emailVerified: true },
  });
  return id;
}

const claims = (owner: PrismaClient, userId: string) =>
  owner.twoFactorUsedCode.count({ where: { userId } });

describe("TOTP claim under the runtime and grant roles", () => {
  it("runs, or says why it cannot", (ctx) => {
    const db = ready(ctx);
    expect(db.available).toBe(true);
  });

  it("the function is owned by the owner, SECURITY DEFINER, fixed search_path, executable only by the two roles", async (ctx) => {
    const db = ready(ctx);
    const [fn] = await db.db("owner").$queryRaw<
      { owner: string; definer: boolean; config: string[] | null; publicExec: boolean }[]
    >`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExec"
      FROM pg_proc p WHERE p.oid = 'public.two_factor_claim_code(uuid, text)'::regprocedure`;
    expect(fn?.owner).toBe(db.roles.owner);
    expect(fn?.definer).toBe(true);
    expect(fn?.config).toEqual(["search_path=pg_catalog, pg_temp"]);
    expect(fn?.publicExec).toBe(false);
    for (const role of ["app", "grant"] as const) {
      const [row] = await db.db("owner").$queryRaw<{ exec: boolean }[]>`
        SELECT has_function_privilege(${db.roles[role]}, 'public.two_factor_claim_code(uuid, text)', 'EXECUTE') AS exec`;
      expect(row?.exec, role).toBe(true);
    }
  });

  for (const role of ["app", "grant"] as const satisfies readonly RoleName[]) {
    it(`${role} role: claims once, has no table privilege, and cannot remove an unexpired claim to replay`, async (ctx) => {
      const db = ready(ctx);
      const owner = db.db("owner");
      const client = db.db(role);
      const userId = await account(owner);
      expect(await claimTotpCode(client, userId, "123456")).toBe(true);
      expect(await claimTotpCode(client, userId, "123456")).toBe(false);

      for (const statement of [
        `DELETE FROM two_factor_used_codes WHERE user_id = '${userId}'`,
        `DELETE FROM two_factor_used_codes`,
        `UPDATE two_factor_used_codes SET expires_at = now() - interval '1 hour' WHERE user_id = '${userId}'`,
        `INSERT INTO two_factor_used_codes (user_id, code_hash, expires_at) VALUES ('${userId}', '${hash(userId, "000000")}', now())`,
        `TRUNCATE two_factor_used_codes`,
        `SELECT count(*) FROM two_factor_used_codes`,
      ]) {
        expect(await failure(ddl(client, statement)), statement).toMatch(/permission denied/);
      }
      // The claim survived every attempt: the code is still refused.
      expect(await claims(owner, userId)).toBe(1);
      expect(await claimTotpCode(client, userId, "123456")).toBe(false);
    }, 60_000);
  }

  it("removes only the calling account's expired claims (database clock), never another account's", async (ctx) => {
    const db = ready(ctx);
    const owner = db.db("owner");
    const [a, b] = [await account(owner), await account(owner)];
    for (const [id, code, age] of [
      [a, "111111", "1 second"],
      [a, "222222", "-1 minute"], // still valid (expires in a minute)
      [b, "111111", "1 second"],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO two_factor_used_codes (user_id, code_hash, expires_at)
        VALUES (${id}::uuid, ${hash(id, code)}, now() - ${age}::interval)`;
    }
    expect(await claimTotpCode(db.db("app"), a, "333333")).toBe(true);
    // a: expired 111111 removed, unexpired 222222 kept, 333333 added; b untouched.
    const left = await owner.twoFactorUsedCode.findMany({
      where: { userId: { in: [a, b] } },
      select: { userId: true, codeHash: true },
    });
    expect(
      left
        .filter((row) => row.userId === a)
        .map((row) => row.codeHash)
        .sort(),
    ).toEqual([hash(a, "222222"), hash(a, "333333")].sort());
    expect(left.filter((row) => row.userId === b)).toHaveLength(1);
    // The unexpired code is still refused; the expired one is accepted again.
    expect(await claimTotpCode(db.db("app"), a, "222222")).toBe(false);
    expect(await claimTotpCode(db.db("app"), a, "111111")).toBe(true);
  });

  it("exactly one of many concurrent claims of a code wins (both roles at once)", async (ctx) => {
    const db = ready(ctx);
    const userId = await account(db.db("owner"));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        claimTotpCode(db.db(i % 2 === 0 ? "app" : "grant"), userId, "424242"),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claims(db.db("owner"), userId)).toBe(1);
  }, 60_000);

  it("rejects malformed arguments and unknown accounts with an error, never a fresh claim", async (ctx) => {
    const db = ready(ctx);
    const app = db.db("app");
    const userId = await account(db.db("owner"));
    for (const bad of [
      "x' OR '1'='1",
      hash(userId, "1").toUpperCase(),
      hash(userId, "1").slice(1),
      "",
    ]) {
      expect(
        await failure(app.$queryRaw`SELECT public.two_factor_claim_code(${userId}::uuid, ${bad})`),
        bad,
      ).toMatch(/invalid arguments/);
    }
    expect(
      await failure(
        app.$queryRaw`SELECT public.two_factor_claim_code(NULL::uuid, ${hash(userId, "1")})`,
      ),
    ).toMatch(/invalid arguments/);
    await expect(claimTotpCode(app, randomUUID(), "123456")).rejects.toThrow();
    expect(await claims(db.db("owner"), userId)).toBe(0);
  });

  it("a caller's temporary table of the same name does not divert the function", async (ctx) => {
    const db = ready(ctx);
    const app = db.db("app");
    const userId = await account(db.db("owner"));
    // One connection for the temp table and the call (an interactive transaction).
    await app.$transaction(async (tx) => {
      await ddl(
        tx as unknown as PrismaClient,
        `CREATE TEMP TABLE two_factor_used_codes (user_id uuid, code_hash text, expires_at timestamptz) ON COMMIT DROP`,
      );
      expect(await claimTotpCode(tx, userId, "515151")).toBe(true);
    });
    expect(await claims(db.db("owner"), userId)).toBe(1);
  });

  it("deleting an account (runtime role) still removes its claims", async (ctx) => {
    const db = ready(ctx);
    const app = db.db("app");
    const userId = await account(db.db("owner"));
    expect(await claimTotpCode(app, userId, "626262")).toBe(true);
    await app.user.delete({ where: { id: userId } });
    expect(await claims(db.db("owner"), userId)).toBe(0);
  });
});
