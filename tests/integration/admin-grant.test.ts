// Platform-admin grant workflow (src/server/admin/platform-admin-grant.ts, `pnpm admin:grant`)
// on the real database: proof of possession of the account's authenticator, database
// enforcement of the flag, replay protection, audit, and revocation on MFA loss.
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { grantPlatformAdmin } from "@/server/admin/platform-admin-grant";
import { resetUserMfa } from "@/server/auth/mfa-reset";
import { verifyTotpCode } from "@/server/auth/totp";
import { claimTotpCode } from "@/server/auth/totp-replay";

import { createTestAuth } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";
import { resolveTestDatabaseUrl } from "./test-database";
import { totp, wrongCode } from "./totp";

const { system } = createTestDb();
const SECRET = "admin-grant-test-auth-secret-0123456789abcdef";
const PASSWORD = "correct horse battery";
const test = createTestAuth(system, SECRET);
const deps = { system, authSecret: SECRET };
const REASON = "TICKET-7 identity verified by video call";

beforeEach(async () => {
  await resetDatabase(system);
});
afterAll(async () => {
  await system.$disconnect();
});

const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

let counter = 0;
/** A verified account; with `enroll`, TOTP is enabled by the account's own (test) device. */
async function account(options: { enroll?: boolean } = {}) {
  counter += 1;
  const email = `grant-${String(counter)}-${Date.now().toString(36)}@example.com`;
  await test.auth.api.signUpEmail({ body: { name: "Staff", email, password: PASSWORD } });
  const user = await system.user.update({ where: { email }, data: { emailVerified: true } });
  if (options.enroll !== true) return { id: user.id, email, key: "" };
  const signIn = await test.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const headers = new Headers({ cookie: cookieHeader(signIn) });
  const enabled = await test.auth.api.enableTwoFactor({
    body: { password: PASSWORD, method: "totp" },
    headers,
  });
  if (!("totpURI" in enabled)) throw new Error("no TOTP");
  const key = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
  await test.auth.api.verifyTOTP({ body: { code: totp(key, -1) }, headers });
  return { id: user.id, email, key };
}

const isAdmin = async (id: string) =>
  (await system.user.findUniqueOrThrow({ where: { id } })).isPlatformAdmin;
const grant = (email: string, code: string) =>
  grantPlatformAdmin(deps, { email, operator: "ops on call", reason: REASON, code });

describe("platform admin grant (proof of possession)", () => {
  it("grants only with a current code from the account's own authenticator", async () => {
    const person = await account({ enroll: true });
    expect(await grant(person.email, wrongCode(person.key))).toEqual({
      status: "DENIED",
      reason: "INVALID_CODE",
    });
    expect(await isAdmin(person.id)).toBe(false);

    const code = totp(person.key);
    expect(await grant(person.email.toUpperCase(), code)).toEqual({
      status: "GRANTED",
      userId: person.id,
    });
    expect(await isAdmin(person.id)).toBe(true);
    // Repeating the request changes nothing.
    expect(await grant(person.email, totp(person.key, 1))).toEqual({
      status: "ALREADY_ADMIN",
      userId: person.id,
    });

    const audit = await system.auditLog.findMany({
      where: { entityId: person.id, action: { startsWith: "platform_admin." } },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((entry) => entry.action)).toEqual([
      "platform_admin.grant_denied",
      "platform_admin.granted",
    ]);
    expect(audit[0]?.metadata).toMatchObject({ denial: "INVALID_CODE", operator: "ops on call" });
    expect(JSON.stringify(audit)).not.toContain(code);
    expect(JSON.stringify(audit)).not.toContain(person.key);
  });

  it("an attacker's enrollment is exposed: the real person's authenticator does not match", async () => {
    // Someone who knows the password enrolled THEIR device (person.key) on the account.
    const hijacked = await account({ enroll: true });
    // The real person, on the identity-verified call, reads a code from their own device
    // (a different secret): the grant is refused.
    const theirCode = totp("JBSWY3DPEHPK3PXP"); // another device's secret
    const result = await grant(hijacked.email, theirCode);
    expect(result).toMatchObject({ status: "DENIED" });
    expect(await isAdmin(hijacked.id)).toBe(false);
  });

  it("refuses accounts without a verified email, without two-factor, or with a locked factor", async () => {
    expect(await grant("nobody@example.com", "123456")).toEqual({
      status: "DENIED",
      reason: "NOT_FOUND",
    });

    const noMfa = await account();
    expect(await grant(noMfa.email, "123456")).toEqual({
      status: "DENIED",
      reason: "MFA_NOT_ENROLLED",
    });

    const unverified = await account({ enroll: true });
    await system.user.update({ where: { id: unverified.id }, data: { emailVerified: false } });
    expect(await grant(unverified.email, totp(unverified.key))).toEqual({
      status: "DENIED",
      reason: "EMAIL_UNVERIFIED",
    });

    const locked = await account({ enroll: true });
    await system.twoFactor.update({
      where: { userId: locked.id },
      data: { lockedUntil: new Date(Date.now() + 10 * 60_000) },
    });
    expect(await grant(locked.email, totp(locked.key))).toEqual({
      status: "DENIED",
      reason: "MFA_LOCKED",
    });
    for (const id of [noMfa.id, unverified.id, locked.id]) expect(await isAdmin(id)).toBe(false);
  });

  it("refuses a code that was already used (sign-in or an earlier grant)", async () => {
    const person = await account({ enroll: true });
    const code = totp(person.key, 1);
    expect(await claimTotpCode(system, person.id, code)).toBe(true); // a sign-in
    expect(await grant(person.email, code)).toEqual({ status: "DENIED", reason: "INVALID_CODE" });
    expect(await isAdmin(person.id)).toBe(false);
  });

  it("the database refuses the flag outside the workflow", async () => {
    const person = await account({ enroll: true });
    await expect(
      system.user.update({ where: { id: person.id }, data: { isPlatformAdmin: true } }),
    ).rejects.toThrow();
    // A grant marker for ANOTHER account does not help.
    const other = await account({ enroll: true });
    await expect(
      system.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('flexibx.platform_admin_grant', ${other.id}, true)`;
        await tx.user.update({ where: { id: person.id }, data: { isPlatformAdmin: true } });
      }),
    ).rejects.toThrow();
    expect(await isAdmin(person.id)).toBe(false);
  });

  it("losing two-factor removes the flag; only a new grant restores it", async () => {
    const person = await account({ enroll: true });
    expect(await grant(person.email, totp(person.key))).toMatchObject({ status: "GRANTED" });

    await resetUserMfa(system, { email: person.email, operator: "ops on call", reason: REASON });
    expect(await isAdmin(person.id)).toBe(false);
    expect(
      await system.auditLog.count({
        where: { entityId: person.id, action: "platform_admin.revoked" },
      }),
    ).toBe(1);

    // A direct flag change after re-enabling two-factor does not bring it back either.
    await system.user.update({ where: { id: person.id }, data: { twoFactorEnabled: true } });
    expect(await isAdmin(person.id)).toBe(false);
  });

  it("verifies codes exactly like Better Auth (same secret, same window)", async () => {
    const person = await account({ enroll: true });
    const row = await system.twoFactor.findUniqueOrThrow({ where: { userId: person.id } });
    const { symmetricDecrypt } = await import("better-auth/crypto");
    const secret = await symmetricDecrypt({ key: SECRET, data: row.secret });
    const now = new Date();
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotpCode(secret, totp(person.key, offset), now), String(offset)).toBe(true);
    }
    expect(verifyTotpCode(secret, totp(person.key, 3), now)).toBe(false);
    expect(verifyTotpCode(secret, "12345", now)).toBe(false);
    expect(verifyTotpCode(secret, "abcdef", now)).toBe(false);
  });
});

describe("pnpm admin:grant (CLI)", () => {
  const run = promisify(execFile);
  const root = join(import.meta.dirname, "../..");
  async function cli(args: readonly string[], stdin: string) {
    const child = run(
      join(root, "node_modules/.bin/tsx"),
      ["--import", "./scripts/video-retention/register.mjs", "scripts/admin/grant.ts", ...args],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: resolveTestDatabaseUrl(),
          APP_URL: "http://localhost:3000",
          AUTH_SECRET: SECRET,
          LOG_LEVEL: "silent",
        },
      },
    );
    child.child.stdin?.end(stdin);
    return child.then(
      (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
      (error: unknown) => {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return {
          code: failed.code ?? -1,
          stdout: failed.stdout ?? "",
          stderr: failed.stderr ?? "",
        };
      },
    );
  }

  it("refuses a code on the command line and grants with a code from standard input", async () => {
    const person = await account({ enroll: true });
    const base = [
      "--email",
      person.email,
      "--confirm",
      person.email,
      "--operator",
      "ops",
      "--reason",
      REASON,
    ];

    const onCommandLine = await cli([...base, "--code", "123456"], "");
    expect(onCommandLine.code).toBe(2);
    expect(onCommandLine.stdout).toContain("REFUSED");
    expect(onCommandLine.stdout + onCommandLine.stderr).not.toContain("123456");

    const mismatch = await cli(["--email", person.email, "--confirm", "other@example.com"], "");
    expect(mismatch.code).toBe(2);

    const code = totp(person.key);
    const granted = await cli(base, `${code}\n`);
    expect(granted.code).toBe(0);
    expect(JSON.parse(granted.stdout)).toEqual({ status: "GRANTED", userId: person.id });
    expect(granted.stdout + granted.stderr).not.toContain(code);
    expect(await isAdmin(person.id)).toBe(true);
  }, 60_000);

  /** Runs the CLI in a pseudo-terminal (support/pty-run.py) and types `send` at the prompt. */
  function tty(args: readonly string[], send: string) {
    const child = spawn("python3", ["-I", join(root, "tests/integration/support/pty-run.py")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: resolveTestDatabaseUrl(),
        APP_URL: "http://localhost:3000",
        AUTH_SECRET: SECRET,
        LOG_LEVEL: "silent",
        TERM: "xterm",
      },
    });
    child.stdin.end(
      JSON.stringify({
        argv: [
          join(root, "node_modules/.bin/tsx"),
          "--import",
          "./scripts/video-retention/register.mjs",
          "scripts/admin/grant.ts",
          ...args,
        ],
        waitFor: "Current 6-digit code",
        send,
        timeoutSeconds: 60,
      }),
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    return new Promise<{ output: string; exitCode: number; sent: boolean }>((resolve) => {
      child.on("close", () => {
        resolve(JSON.parse(stdout) as { output: string; exitCode: number; sent: boolean });
      });
    });
  }
  /** The terminal's echo setting after the CLI exited (`stty -a`, printed by pty-run.py). */
  const echoAfter = (output: string) => {
    const settings = /@@STTY (.*)@@/.exec(output)?.[1]?.split(/\s+/) ?? [];
    return settings.includes("echo") ? "on" : settings.includes("-echo") ? "off" : "unknown";
  };

  it("on a terminal: the code is not echoed, and echo is back on afterwards", async () => {
    const person = await account({ enroll: true });
    const args = ["--email", person.email, "--confirm", person.email, "--operator", "ops"];
    const reasoned = [...args, "--reason", REASON];

    const wrong = wrongCode(person.key);
    const denied = await tty(reasoned, `${wrong}\r`);
    expect(denied.sent).toBe(true);
    expect(denied.output).toContain('"status":"DENIED"');
    expect(denied.output).not.toContain(wrong);
    expect(echoAfter(denied.output)).toBe("on");
    expect(denied.exitCode).toBe(2);
    expect(await isAdmin(person.id)).toBe(false);

    const cancelled = await tty(reasoned, "12\u0003");
    expect(cancelled.output).toContain('"status":"CANCELLED"');
    expect(echoAfter(cancelled.output)).toBe("on");
    expect(cancelled.exitCode).toBe(130);
    expect(await isAdmin(person.id)).toBe(false);

    const code = totp(person.key);
    const granted = await tty(reasoned, `${code}\r`);
    expect(granted.output).toContain('"status":"GRANTED"');
    expect(granted.output).not.toContain(code);
    expect(echoAfter(granted.output)).toBe("on");
    expect(granted.exitCode).toBe(0);
    expect(await isAdmin(person.id)).toBe(true);
    // The audit trail never holds the code either.
    const audit = await system.auditLog.findMany({ where: { entityId: person.id } });
    expect(JSON.stringify(audit)).not.toContain(code);
    expect(JSON.stringify(audit)).not.toContain(wrong);
  }, 120_000);
});
