// `pnpm admin:mfa-reset` (scripts/admin/mfa-reset.ts → src/server/auth/mfa-reset.ts) under
// the RESTRICTED runtime role of docs/runbooks/DATABASE_ROLES.md — not the owner, a
// superuser or the grant role — on a disposable database with disposable roles: the real
// CLI resets the account (two-factor removed, every session ended, platform-admin flag
// revoked by the trigger, audit written), touches nothing else, cannot rewrite its own
// audit trail, and a refused step leaves no partial change.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { grantPlatformAdmin } from "@/server/admin/platform-admin-grant";
import { resetUserMfa } from "@/server/auth/mfa-reset";

import { createTestAuth } from "./auth-harness";
import {
  createRoleDatabase,
  ddl,
  repositoryRoot,
  type RoleDatabase,
} from "./support/role-database";
import { totp } from "./totp";

const run = promisify(execFile);
const SECRET = "mfa-reset-role-test-auth-secret-0123456789abcdef";
const PASSWORD = "correct horse battery";
const REASON = "TICKET-42 identity verified by video call";

let roles: RoleDatabase | undefined;
beforeAll(async () => {
  roles = await createRoleDatabase("mr");
}, 180_000);
afterAll(async () => {
  await roles?.teardown();
}, 60_000);
/** The role database (setup failures throw in beforeAll, so tests never see undefined). */
const rdb = (): RoleDatabase => {
  if (roles === undefined) throw new Error("role database not set up");
  return roles;
};

let counter = 0;
/** A verified account with TOTP, created through the application under the runtime role. */
async function enrolledAccount() {
  const test = createTestAuth(rdb().db("app"), SECRET);
  counter += 1;
  const email = `reset-${String(counter)}-${Date.now().toString(36)}@example.com`;
  await test.auth.api.signUpEmail({ body: { name: "Staff", email, password: PASSWORD } });
  const user = await rdb()
    .db("app")
    .user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await test.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const headers = new Headers({
    cookie: signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .join("; "),
  });
  const enabled = await test.auth.api.enableTwoFactor({
    body: { password: PASSWORD, method: "totp" },
    headers,
  });
  if (!("totpURI" in enabled)) throw new Error("no TOTP");
  const key = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
  await test.auth.api.verifyTOTP({ body: { code: totp(key, -1) }, headers });
  // A second, independent session (another device).
  await rdb()
    .db("app")
    .session.create({
      data: {
        userId: user.id,
        token: `other-device-${String(counter)}-${Date.now().toString(36)}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  return { id: user.id, email, key };
}

/** Everything that belongs to one account, as the owner sees it (for "unchanged" checks). */
async function accountState(id: string) {
  const [row] = await rdb().db("owner").$queryRaw<{ state: string }[]>`
    SELECT md5(concat_ws('#',
      (SELECT u::text FROM users u WHERE u.id = ${id}::uuid),
      (SELECT string_agg(t::text, ';') FROM two_factors t WHERE t.user_id = ${id}::uuid),
      (SELECT string_agg(s::text, ';' ORDER BY s.id) FROM sessions s WHERE s.user_id = ${id}::uuid))) AS state`;
  return row?.state ?? "";
}

const owner = () => rdb().db("owner");
const sessions = (userId: string) => owner().session.count({ where: { userId } });

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "SUCCEEDED";
}

async function cli(databaseUrl: string, email: string) {
  try {
    const result = await run(
      join(repositoryRoot, "node_modules/.bin/tsx"),
      [
        "--import",
        "./scripts/video-retention/register.mjs",
        "scripts/admin/mfa-reset.ts",
        "--email",
        email,
        "--confirm",
        email,
        "--operator",
        "ops on call",
        "--reason",
        REASON,
      ],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          APP_URL: "http://localhost:3000",
          DATABASE_URL: databaseUrl,
          LOG_LEVEL: "silent",
        } as unknown as NodeJS.ProcessEnv,
      },
    );
    return { code: 0, out: result.stdout + result.stderr };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, out: (failed.stdout ?? "") + (failed.stderr ?? "") };
  }
}

describe("admin:mfa-reset under the restricted runtime role", () => {
  it("runs, or says why it cannot", (ctx) => {
    if (!rdb().available) ctx.skip(rdb().skipReason);
    expect(rdb().available).toBe(true);
  });

  it("the runtime role is not the owner, not privileged, and reaches no other role", async (ctx) => {
    if (!rdb().available) ctx.skip(rdb().skipReason);
    const [facts] = await owner().$queryRaw<
      {
        privileged: boolean;
        reachesOwner: boolean;
        reachesGrant: boolean;
        ownsSomething: boolean;
      }[]
    >`SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls) AS privileged,
             pg_has_role(r.oid, ${rdb().roles.owner}, 'MEMBER') AS "reachesOwner",
             pg_has_role(r.oid, ${rdb().roles.grant}, 'MEMBER') AS "reachesGrant",
             EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid)
               OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid) AS "ownsSomething"
      FROM pg_roles r WHERE r.rolname = ${rdb().roles.app}`;
    expect(facts).toEqual({
      privileged: false,
      reachesOwner: false,
      reachesGrant: false,
      ownsSomething: false,
    });
  });

  it("the real CLI resets an administrator's MFA with the runtime credential, and nothing else changes", async (ctx) => {
    if (!rdb().available) ctx.skip(rdb().skipReason);
    const target = await enrolledAccount();
    const bystander = await enrolledAccount();
    // The target is a platform administrator (granted the approved way).
    expect(
      await grantPlatformAdmin(
        { system: rdb().db("grant"), authSecret: SECRET },
        { email: target.email, operator: "ops", reason: REASON, code: totp(target.key) },
      ),
    ).toMatchObject({ status: "GRANTED" });
    expect(await sessions(target.id)).toBeGreaterThanOrEqual(2);
    const bystanderBefore = await accountState(bystander.id);
    const auditBefore = await owner().auditLog.count();

    const result = await cli(rdb().urlFor("app"), target.email);
    expect(result.code).toBe(0);
    const outcome = JSON.parse(result.out.trim()) as {
      status: string;
      userId: string;
      sessionsEnded: number;
    };
    expect(outcome).toMatchObject({ status: "RESET", userId: target.id });
    expect(outcome.sessionsEnded).toBeGreaterThanOrEqual(2);
    // No credential in the output.
    expect(result.out).not.toContain(rdb().secretOf("app"));
    expect(result.out).not.toMatch(/postgres(ql)?:\/\//);

    const user = await owner().user.findUniqueOrThrow({ where: { id: target.id } });
    expect(user.twoFactorEnabled).toBe(false);
    expect(user.isPlatformAdmin).toBe(false); // removed by the trigger, not by the runtime role
    expect(await owner().twoFactor.count({ where: { userId: target.id } })).toBe(0);
    expect(await sessions(target.id)).toBe(0);

    const audit = await owner().auditLog.findMany({
      where: {
        entityId: target.id,
        action: { in: ["user.mfa_reset_by_operator", "platform_admin.revoked"] },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((entry) => entry.action)).toEqual([
      "user.mfa_reset_by_operator",
      "platform_admin.revoked",
    ]);
    expect(audit[0]?.metadata).toMatchObject({
      operator: "ops on call",
      reason: REASON,
      sessionsEnded: outcome.sessionsEnded,
    });
    expect(audit[1]?.metadata).toMatchObject({ cause: "mfa_reset" });
    expect(await owner().auditLog.count()).toBe(auditBefore + 2);

    // Unrelated account: byte-identical (user row, two-factor row, sessions).
    expect(await accountState(bystander.id)).toBe(bystanderBefore);

    // The runtime role cannot rewrite or erase those audit entries.
    for (const entry of audit) {
      expect(
        await failure(
          rdb()
            .db("app")
            .auditLog.update({ where: { id: entry.id }, data: { action: "x" } }),
        ),
      ).toMatch(/denied/i);
      expect(
        await failure(
          rdb()
            .db("app")
            .auditLog.delete({ where: { id: entry.id } }),
        ),
      ).toMatch(/denied/i);
    }
    expect(
      await owner().auditLog.count({
        where: { entityId: target.id, action: "user.mfa_reset_by_operator" },
      }),
    ).toBe(1);
  }, 120_000);

  it("an unknown account: NOT_FOUND, exit 2, nothing written", async (ctx) => {
    if (!rdb().available) ctx.skip(rdb().skipReason);
    const auditBefore = await owner().auditLog.count();
    const result = await cli(rdb().urlFor("app"), "nobody-here@example.com");
    expect(result.code).toBe(2);
    expect(result.out).toContain('"status":"NOT_FOUND"');
    expect(await owner().auditLog.count()).toBe(auditBefore);
  }, 60_000);

  it("a refused step fails the whole reset: no partial or inconsistent change", async (ctx) => {
    if (!rdb().available) ctx.skip(rdb().skipReason);
    const target = await enrolledAccount();
    expect(
      await grantPlatformAdmin(
        { system: rdb().db("grant"), authSecret: SECRET },
        { email: target.email, operator: "ops", reason: REASON, code: totp(target.key) },
      ),
    ).toMatchObject({ status: "GRANTED" });
    const before = await accountState(target.id);
    const auditBefore = await owner().auditLog.count();

    // The LAST step (the audit insert) is refused, after the deletes and the update ran.
    await ddl(rdb().db("owner"), `REVOKE INSERT ON public.audit_logs FROM ${rdb().roles.app}`);
    try {
      expect(
        await failure(
          resetUserMfa(rdb().db("app"), { email: target.email, operator: "ops", reason: REASON }),
        ),
      ).toMatch(/permission denied/);
    } finally {
      // Back to the documented privileges (the script is idempotent).
      expect((await rdb().applyRoles()).code).toBe(0);
    }
    expect(await accountState(target.id)).toBe(before);
    expect(await owner().auditLog.count()).toBe(auditBefore);
    expect(
      (await owner().user.findUniqueOrThrow({ where: { id: target.id } })).isPlatformAdmin,
    ).toBe(true);

    // The grant role (no DELETE on two_factors or sessions) is refused too, changing nothing.
    expect(
      await failure(
        resetUserMfa(rdb().db("grant"), { email: target.email, operator: "ops", reason: REASON }),
      ),
    ).toMatch(/permission denied/);
    expect(await accountState(target.id)).toBe(before);

    // With the documented privileges restored, the same reset succeeds.
    expect(
      await resetUserMfa(rdb().db("app"), { email: target.email, operator: "ops", reason: REASON }),
    ).toMatchObject({ status: "RESET", userId: target.id });
    expect(
      (await owner().user.findUniqueOrThrow({ where: { id: target.id } })).isPlatformAdmin,
    ).toBe(false);
  }, 120_000);
});
