// Database privilege boundary (scripts/ops/sql/db-roles.sql, docs/runbooks/DATABASE_ROLES.md)
// on a disposable database with disposable roles: the runtime role cannot grant platform
// administrators — not directly, not with the old grant marker, not by replacing or
// disabling the guard, not through role membership — while the application still works
// under it, and the operator grant role can grant only through the audited function, with
// a valid TOTP code.
//
// Needs a superuser connection to create roles and a database: ROLE_TEST_ADMIN_DATABASE_URL,
// or the test database's own user when it is a superuser (CI). Skipped otherwise — with a
// visible reason. Everything it creates is dropped afterwards.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { grantPlatformAdmin } from "@/server/admin/platform-admin-grant";
import { createPrismaClient } from "@/server/db/prisma";

import { createTestAuth } from "./auth-harness";
import { resolveTestDatabaseUrl } from "./test-database";
import { totp, wrongCode } from "./totp";

const run = promisify(execFile);
const root = join(import.meta.dirname, "../..");
const SECRET = "db-roles-test-auth-secret-0123456789abcdef0123";
const PASSWORD = "correct horse battery";
const REASON = "TICKET-9 identity verified by video call";

const suffix = randomBytes(4).toString("hex");
const roles = {
  owner: `flexibx_t${suffix}_owner`,
  app: `flexibx_t${suffix}_app`,
  grant: `flexibx_t${suffix}_grant`,
  bridge: `flexibx_t${suffix}_bridge`,
  // Stand-in for a managed-service admin role (rds_superuser on Amazon RDS): NOLOGIN, no
  // SUPERUSER attribute, but CREATEROLE/CREATEDB and a predefined-role membership.
  managedAdmin: `flexibx_t${suffix}_rdssu`,
};
const database = `flexibx_roles_${suffix}_test`;
const secrets = {
  owner: randomBytes(18).toString("hex"),
  app: randomBytes(18).toString("hex"),
  grant: randomBytes(18).toString("hex"),
};

const adminUrl = process.env.ROLE_TEST_ADMIN_DATABASE_URL ?? resolveTestDatabaseUrl();
let admin: PrismaClient | undefined;
let available = false;
let skipReason = "";
const clients: Partial<Record<"owner" | "app" | "grant", PrismaClient>> = {};

function urlFor(role: keyof typeof secrets): string {
  const url = new URL(adminUrl);
  url.username = roles[role];
  url.password = secrets[role];
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

/** libpq environment for psql (no URL or password on the command line). */
function psqlEnv(): Record<string, string | undefined> {
  const url = new URL(adminUrl);
  return {
    PATH: process.env.PATH,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: "10",
  };
}

async function applyRoles(): Promise<{ code: number; output: string }> {
  try {
    const result = await run(
      "psql",
      [
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `owner_role=${roles.owner}`,
        "-v",
        `app_role=${roles.app}`,
        "-v",
        `grant_role=${roles.grant}`,
        "-f",
        join(root, "scripts/ops/sql/db-roles.sql"),
      ],
      { env: psqlEnv() as NodeJS.ProcessEnv },
    );
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, output: (failed.stdout ?? "") + (failed.stderr ?? "") };
  }
}

/**
 * Test-only SQL that cannot use bind parameters: DDL, role and privilege statements, and
 * statements the boundary must refuse. Every statement is a constant of this file or uses
 * identifiers built from fixed prefixes and random hex — never input.
 */
function ddl(client: PrismaClient, sql: string): Promise<number> {
  // eslint-disable-next-line no-restricted-properties -- see above: constant test SQL only
  return client.$executeRawUnsafe(sql);
}

const db = (role: "owner" | "app" | "grant"): PrismaClient => {
  const client = clients[role];
  if (client === undefined) throw new Error("not set up");
  return client;
};

beforeAll(async () => {
  admin = createPrismaClient(adminUrl);
  const [me] = await admin.$queryRaw<{ rolsuper: boolean }[]>`
    SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
  if (me?.rolsuper !== true) {
    skipReason = "needs a superuser connection (ROLE_TEST_ADMIN_DATABASE_URL)";
    return;
  }
  // Identifiers come from fixed prefixes and hex: safe to interpolate.
  await ddl(admin, `CREATE ROLE ${roles.owner} LOGIN PASSWORD '${secrets.owner}'`);
  await ddl(admin, `CREATE ROLE ${roles.app} LOGIN PASSWORD '${secrets.app}'`);
  await ddl(admin, `CREATE ROLE ${roles.grant} LOGIN PASSWORD '${secrets.grant}'`);
  await ddl(admin, `CREATE ROLE ${roles.bridge} NOLOGIN`);
  await ddl(admin, `CREATE ROLE ${roles.managedAdmin} NOLOGIN CREATEROLE CREATEDB`);
  await ddl(admin, `GRANT pg_signal_backend TO ${roles.managedAdmin}`);
  await ddl(admin, `CREATE DATABASE ${database} OWNER ${roles.owner}`);
  // Migrations run as the owner (migration role), exactly as the migrate job would.
  await run(join(root, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: urlFor("owner") },
  });
  const applied = await applyRoles();
  if (applied.code !== 0) throw new Error(`db-roles.sql failed: ${applied.output}`);
  for (const role of ["owner", "app", "grant"] as const)
    clients[role] = createPrismaClient(urlFor(role));
  available = true;
}, 180_000);

afterAll(async () => {
  for (const client of Object.values(clients)) await client.$disconnect();
  if (admin !== undefined && skipReason === "") {
    await ddl(admin, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [roles.app, roles.grant, roles.bridge, roles.managedAdmin, roles.owner]) {
      await ddl(admin, `DROP ROLE IF EXISTS ${role}`);
    }
  }
  await admin?.$disconnect();
}, 60_000);

/** The Postgres error text of a rejected call (privilege errors are what we assert on). */
async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "SUCCEEDED";
}

let counter = 0;
/** A verified account with TOTP enrolled — created by the APPLICATION under the runtime role. */
async function enrolledAccount() {
  const test = createTestAuth(db("app"), SECRET);
  counter += 1;
  const email = `roles-${String(counter)}-${suffix}@example.com`;
  await test.auth.api.signUpEmail({ body: { name: "Staff", email, password: PASSWORD } });
  const user = await db("app").user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await test.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .join("; ");
  const headers = new Headers({ cookie });
  const enabled = await test.auth.api.enableTwoFactor({
    body: { password: PASSWORD, method: "totp" },
    headers,
  });
  if (!("totpURI" in enabled)) throw new Error("no TOTP");
  const key = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
  // Enrollment replaces the session: keep the new cookie.
  const confirmed = await test.auth.api.verifyTOTP({
    body: { code: totp(key, -1) },
    headers,
    asResponse: true,
  });
  const session = new Headers({
    cookie: confirmed.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .filter((pair) => !pair.endsWith("="))
      .join("; "),
  });
  return { id: user.id, email, key, test, headers: session };
}

const isAdmin = async (id: string) =>
  (await db("owner").user.findUniqueOrThrow({ where: { id } })).isPlatformAdmin;

describe("database privilege boundary (runtime / grant / owner roles)", () => {
  it("runs, or says why it cannot", (ctx) => {
    if (!available) ctx.skip(skipReason);
    expect(available).toBe(true);
  });

  it("the runtime role cannot set the flag: directly, with the old marker, in one statement, on insert", async (ctx) => {
    if (!available) ctx.skip(skipReason);
    const app = db("app");
    const user = await app.user.create({
      data: { email: `plain-${suffix}@example.com`, name: "P", emailVerified: true },
    });
    // Make the account otherwise eligible, so only the privilege can stop it.
    await db("owner")
      .$executeRaw`UPDATE users SET two_factor_enabled = true WHERE id = ${user.id}::uuid`;

    expect(
      await failure(
        app.$executeRaw`UPDATE users SET is_platform_admin = true WHERE id = ${user.id}::uuid`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await failure(
        app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('flexibx.platform_admin_grant', ${user.id}, true)`;
          await tx.$executeRaw`UPDATE users SET is_platform_admin = true WHERE id = ${user.id}::uuid`;
        }),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failure(
        app.$executeRaw`UPDATE users u SET is_platform_admin = true
          FROM (SELECT set_config('flexibx.platform_admin_grant', ${user.id}, true)) s
          WHERE u.id = ${user.id}::uuid`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await failure(
        app.$executeRaw`INSERT INTO users (email, name, email_verified, two_factor_enabled, is_platform_admin)
          VALUES (${`evil-${suffix}@example.com`}, 'E', true, true, true)`,
      ),
    ).toMatch(/granted only through the admin grant workflow/);
    expect(
      await failure(
        app.$transaction(async (tx) => {
          const id = "00000000-0000-0000-0000-0000000000aa";
          await tx.$queryRaw`SELECT set_config('flexibx.platform_admin_grant', ${id}, true)`;
          await tx.$executeRaw`INSERT INTO users (id, email, name, email_verified, two_factor_enabled, is_platform_admin)
            VALUES (${id}::uuid, ${`evil2-${suffix}@example.com`}, 'E', true, true, true)`;
        }),
      ),
    ).toMatch(/granted only through the admin grant workflow/);
    expect(
      await failure(app.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } })),
    ).toMatch(/permission denied|denied/i);
    expect(await isAdmin(user.id)).toBe(false);
  });

  it("the runtime role cannot disable, drop or replace the guard, call the grant functions, or create objects", async (ctx) => {
    if (!available) ctx.skip(skipReason);
    const app = db("app");
    const someone = "00000000-0000-0000-0000-000000000001";
    const attempts: [string, Promise<unknown>][] = [
      [
        "disable trigger",
        ddl(app, `ALTER TABLE users DISABLE TRIGGER users_platform_admin_grant_guard`),
      ],
      ["drop trigger", ddl(app, `DROP TRIGGER users_platform_admin_grant_guard ON users`)],
      [
        "replace guard function",
        ddl(
          app,
          `CREATE OR REPLACE FUNCTION public.platform_admin_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        ),
      ],
      [
        "replace grant function",
        ddl(
          app,
          `CREATE OR REPLACE FUNCTION public.platform_admin_grant(uuid, text, text) RETURNS text LANGUAGE sql AS $$ SELECT 'GRANTED' $$`,
        ),
      ],
      [
        "take function ownership",
        ddl(
          app,
          `ALTER FUNCTION public.platform_admin_grant(uuid, text, text) OWNER TO ${roles.app}`,
        ),
      ],
      [
        "call grant function",
        app.$queryRaw`SELECT public.platform_admin_grant(${someone}::uuid, 'ops', 'a reason here')`,
      ],
      [
        "call revoke function",
        app.$queryRaw`SELECT public.platform_admin_revoke(${someone}::uuid, 'ops', 'a reason here')`,
      ],
      ["create table in public", ddl(app, `CREATE TABLE public.shadow_users (id int)`)],
      [
        "create function in public",
        ddl(
          app,
          `CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT 'epoch'::timestamptz $$`,
        ),
      ],
      ["create schema", ddl(app, `CREATE SCHEMA evil`)],
      ["become the owner", ddl(app, `SET ROLE ${roles.owner}`)],
      ["alter users", ddl(app, `ALTER TABLE users ADD COLUMN x int`)],
      ["truncate users", ddl(app, `TRUNCATE users CASCADE`)],
      ["rewrite audit", ddl(app, `UPDATE audit_logs SET action = 'x'`)],
      ["erase audit", ddl(app, `DELETE FROM audit_logs`)],
      ["read migrations", ddl(app, `SELECT count(*) FROM _prisma_migrations`)],
    ];
    for (const [label, attempt] of attempts) {
      expect(await failure(attempt), label).toMatch(
        /permission denied|must be owner|must be member/,
      );
    }

    const [facts] = await db("owner").$queryRaw<
      {
        definer: boolean;
        config: string[] | null;
        owner: string;
        publicExecute: boolean;
        appExecute: boolean;
        appMember: boolean;
        grantMember: boolean;
        triggerOwner: string;
      }[]
    >`SELECT p.prosecdef AS definer, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExecute",
             has_function_privilege(${roles.app}, p.oid, 'EXECUTE') AS "appExecute",
             pg_has_role(${roles.app}, ${roles.owner}, 'MEMBER') AS "appMember",
             pg_has_role(${roles.grant}, ${roles.owner}, 'MEMBER') AS "grantMember",
             (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.users'::regclass) AS "triggerOwner"
      FROM pg_proc p WHERE p.oid = 'public.platform_admin_grant(uuid, text, text)'::regprocedure`;
    expect(facts).toEqual({
      definer: true,
      config: ["search_path=pg_catalog, pg_temp"],
      owner: roles.owner,
      publicExecute: false,
      appExecute: false,
      appMember: false,
      grantMember: false,
      triggerOwner: roles.owner,
    });
  });

  it("the grant role cannot set the flag directly either, and sees no sessions or accounts", async (ctx) => {
    if (!available) ctx.skip(skipReason);
    const grant = db("grant");
    const someone = "00000000-0000-0000-0000-000000000002";
    expect(
      await failure(
        grant.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('flexibx.platform_admin_grant', ${someone}, true)`;
          await tx.$executeRaw`UPDATE users SET is_platform_admin = true WHERE id = ${someone}::uuid`;
        }),
      ),
    ).toMatch(/permission denied/);
    expect(await failure(ddl(grant, `SELECT token FROM sessions LIMIT 1`))).toMatch(
      /permission denied/,
    );
    expect(await failure(ddl(grant, `SELECT password FROM accounts LIMIT 1`))).toMatch(
      /permission denied/,
    );
    expect(await failure(ddl(grant, `ALTER TABLE users DISABLE TRIGGER ALL`))).toMatch(
      /must be owner/,
    );
  });

  it("the application works under the runtime role; grants go only through the grant role with a valid code", async (ctx) => {
    if (!available) ctx.skip(skipReason);
    const person = await enrolledAccount();

    // The runtime role, even with a valid code, is refused by the database (nothing kept).
    const viaRuntime = await failure(
      grantPlatformAdmin(
        { system: db("app"), authSecret: SECRET },
        { email: person.email, operator: "ops", reason: REASON, code: totp(person.key) },
      ),
    );
    expect(viaRuntime).toMatch(/permission denied/);
    expect(await isAdmin(person.id)).toBe(false);

    const deps = { system: db("grant"), authSecret: SECRET };
    expect(
      await grantPlatformAdmin(deps, {
        email: person.email,
        operator: "ops",
        reason: REASON,
        code: wrongCode(person.key),
      }),
    ).toEqual({ status: "DENIED", reason: "INVALID_CODE" });
    expect(await isAdmin(person.id)).toBe(false);

    expect(
      await grantPlatformAdmin(deps, {
        email: person.email,
        operator: "ops",
        reason: REASON,
        code: totp(person.key),
      }),
    ).toEqual({ status: "GRANTED", userId: person.id });
    expect(await isAdmin(person.id)).toBe(true);
    const audit = await db("owner").auditLog.findMany({
      where: { entityId: person.id, action: { startsWith: "platform_admin." } },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((entry) => entry.action)).toEqual([
      "platform_admin.grant_denied",
      "platform_admin.granted",
    ]);
    expect(audit[1]?.metadata).toMatchObject({ operator: "ops", databaseUser: roles.grant });

    // Revocation through the grant role's function.
    const [revoked] = await db("grant").$queryRaw<{ result: string }[]>`
      SELECT public.platform_admin_revoke(${person.id}::uuid, 'ops', ${REASON}) AS result`;
    expect(revoked?.result).toBe("REVOKED");
    expect(await isAdmin(person.id)).toBe(false);

    // Granted again; then the APPLICATION turns two-factor off: the trigger removes the
    // flag although the runtime role has no privilege on that column.
    expect(
      await grantPlatformAdmin(deps, {
        email: person.email,
        operator: "ops",
        reason: REASON,
        code: totp(person.key, 1),
      }),
    ).toMatchObject({ status: "GRANTED" });
    await person.test.auth.api.disableTwoFactor({
      body: { password: PASSWORD },
      headers: person.headers,
    });
    expect(await isAdmin(person.id)).toBe(false);
  }, 60_000);

  it("the CLI uses ADMIN_GRANT_DATABASE_URL; with only the runtime credential it fails closed", async (ctx) => {
    if (!available) ctx.skip(skipReason);
    const person = await enrolledAccount();
    const cli = async (env: Record<string, string>, code: string) => {
      const child = run(
        join(root, "node_modules/.bin/tsx"),
        [
          "--import",
          "./scripts/video-retention/register.mjs",
          "scripts/admin/grant.ts",
          "--email",
          person.email,
          "--confirm",
          person.email,
          "--operator",
          "ops",
          "--reason",
          REASON,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            AUTH_SECRET: SECRET,
            ...env,
          },
        },
      );
      child.child.stdin?.end(`${code}\n`);
      return child.then(
        (result) => ({ code: 0, out: result.stdout + result.stderr }),
        (error: unknown) => {
          const failed = error as { code?: number; stdout?: string; stderr?: string };
          return { code: failed.code ?? -1, out: (failed.stdout ?? "") + (failed.stderr ?? "") };
        },
      );
    };
    const runtimeOnly = await cli({ DATABASE_URL: urlFor("app") }, totp(person.key));
    expect(runtimeOnly.code).toBe(1);
    expect(runtimeOnly.out).toContain('"status":"FAILED"');
    expect(runtimeOnly.out).not.toContain(secrets.app);
    expect(await isAdmin(person.id)).toBe(false);

    const withGrantRole = await cli(
      { DATABASE_URL: urlFor("app"), ADMIN_GRANT_DATABASE_URL: urlFor("grant") },
      totp(person.key, 1),
    );
    expect(withGrantRole.code).toBe(0);
    expect(withGrantRole.out).toContain('"status":"GRANTED"');
    expect(await isAdmin(person.id)).toBe(true);

    // A connection failure with the grant credential (wrong password) reports only the
    // error class: no URL, user or password in the output.
    const broken = new URL(urlFor("grant"));
    broken.password = `${secrets.grant}-wrong`;
    const refused = await cli(
      { DATABASE_URL: urlFor("app"), ADMIN_GRANT_DATABASE_URL: broken.toString() },
      totp(person.key, -1),
    );
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('"status":"FAILED"');
    for (const output of [runtimeOnly.out, withGrantRole.out, refused.out]) {
      expect(output).not.toContain(secrets.grant);
      expect(output).not.toContain(secrets.app);
      expect(output).not.toMatch(/postgres(ql)?:\/\//);
      expect(output).not.toContain(roles.grant);
    }
  }, 120_000);

  it("refuses a runtime role that can reach the owner through an intermediate role, changing nothing", async (ctx) => {
    if (!available) ctx.skip(skipReason);
    if (admin === undefined) throw new Error("not set up");
    const owner = admin;
    await ddl(owner, `GRANT ${roles.owner} TO ${roles.bridge}`);
    await ddl(owner, `GRANT ${roles.bridge} TO ${roles.app}`);
    try {
      const refused = await applyRoles();
      expect(refused.code).not.toBe(0);
      expect(refused.output).toContain(
        `${roles.app} can reach ${roles.owner} through role membership`,
      );
    } finally {
      await ddl(owner, `REVOKE ${roles.bridge} FROM ${roles.app}`);
      await ddl(owner, `REVOKE ${roles.owner} FROM ${roles.bridge}`);
    }
    // Idempotent: applying again after the membership is gone succeeds, and the boundary holds.
    expect((await applyRoles()).code).toBe(0);
    expect(
      await failure(
        ddl(db("app"), `ALTER TABLE users DISABLE TRIGGER users_platform_admin_grant_guard`),
      ),
    ).toMatch(/must be owner/);
  }, 60_000);
  // Membership is refused by what it grants, not only by the SUPERUSER attribute of the
  // target: a predefined role, a managed-service admin role reached through a group role,
  // or any group role at all. Each attempt changes nothing; removing it restores a clean run.
  const membershipCases = [
    {
      name: "a predefined role granted directly (pg_write_all_data) to the runtime role",
      member: () => roles.app,
      grants: (): [string, string][] => [["pg_write_all_data", roles.app]],
      expected: () =>
        `${roles.app} must not be a member of any role (member of: pg_write_all_data)`,
    },
    {
      name: "a managed-service admin role (rds_superuser stand-in) reached by the grant role through a group",
      member: () => roles.grant,
      grants: (): [string, string][] => [
        [roles.managedAdmin, roles.bridge],
        [roles.bridge, roles.grant],
      ],
      expected: () =>
        `${roles.grant} must not be a member of any role (member of: ${roles.bridge}, ${roles.managedAdmin}, pg_signal_backend)`,
    },
    {
      name: "pg_read_all_data reached indirectly by the runtime role",
      member: () => roles.app,
      grants: (): [string, string][] => [
        ["pg_read_all_data", roles.bridge],
        [roles.bridge, roles.app],
      ],
      expected: () =>
        `${roles.app} must not be a member of any role (member of: ${roles.bridge}, pg_read_all_data)`,
    },
    {
      name: "an unprivileged group role (no membership is allowed at all)",
      member: () => roles.grant,
      grants: (): [string, string][] => [[roles.bridge, roles.grant]],
      expected: () =>
        `${roles.grant} must not be a member of any role (member of: ${roles.bridge})`,
    },
  ];

  for (const scenario of membershipCases) {
    it(`refuses ${scenario.name}, changing nothing`, async (ctx) => {
      if (!available) ctx.skip(skipReason);
      if (admin === undefined) throw new Error("not set up");
      const owner = admin;
      const grants = scenario.grants();
      for (const [role, member] of grants) await ddl(owner, `GRANT ${role} TO ${member}`);
      // A privilege the run would have revoked had it not stopped: it must survive.
      await ddl(db("owner"), `GRANT SELECT ON public.sessions TO ${roles.grant}`);
      try {
        const refused = await applyRoles();
        expect(refused.code).not.toBe(0);
        expect(refused.output).toContain(scenario.expected());
        const [still] = await db("owner").$queryRaw<{ granted: boolean }[]>`
          SELECT has_table_privilege(${roles.grant}, 'public.sessions', 'SELECT') AS granted`;
        expect(still?.granted).toBe(true);
      } finally {
        for (const [role, member] of [...grants].reverse())
          await ddl(owner, `REVOKE ${role} FROM ${member}`);
        await ddl(db("owner"), `REVOKE SELECT ON public.sessions FROM ${roles.grant}`);
      }
      expect((await applyRoles()).code).toBe(0);
    }, 60_000);
  }

  it("after a clean run the limited roles belong to no role and cannot assume a privileged one", async (ctx) => {
    if (!available) ctx.skip(skipReason);
    expect((await applyRoles()).code).toBe(0);
    for (const role of ["app", "grant"] as const) {
      const memberships = await db("owner").$queryRaw<{ rolname: string }[]>`
        SELECT r.rolname FROM pg_roles r
        WHERE r.rolname <> ${roles[role]} AND pg_has_role(${roles[role]}, r.oid, 'MEMBER')`;
      expect(memberships, role).toEqual([]);
      for (const target of [
        "pg_write_all_data",
        "pg_read_all_data",
        roles.owner,
        roles.managedAdmin,
      ]) {
        expect(await failure(ddl(db(role), `SET ROLE ${target}`)), `${role} -> ${target}`).toMatch(
          /permission denied to set role/,
        );
      }
    }
  }, 60_000);
});
