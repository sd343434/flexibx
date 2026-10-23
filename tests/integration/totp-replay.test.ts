// TOTP replay guard at the Better Auth level (production createAuth, real database): the
// code is claimed inside session creation, before the session row and the cookie exist.
// Faults are injected into the database client the auth instance uses.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";

import { createTestAuth } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";
import { totp } from "./totp";

const { system } = createTestDb();
const SECRET = "totp-replay-test-secret-0123456789abcdefghij";
const PASSWORD = "correct horse battery";

const faults = { claim: false, sessionCreate: false };
function bindAll<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && property in overrides) return overrides[property];
      const value: unknown = Reflect.get(object, property, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}
/** A session delegate whose `create` fails while `faults.sessionCreate` is set. */
function faultySessions<T extends object>(sessions: T): T {
  return new Proxy(sessions, {
    get(delegate, property, receiver) {
      if (property === "create" && faults.sessionCreate) {
        return () => Promise.reject(new Error("injected: session insert failed"));
      }
      const value: unknown = Reflect.get(delegate, property, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(delegate)
        : value;
    },
  });
}
/** The auth instance's client: injects a failure into the claim or the session insert. */
const faulty: PrismaClient = bindAll<PrismaClient>(system, {
  $queryRaw: (...args: unknown[]) =>
    faults.claim
      ? Promise.reject(new Error("injected: claim failed"))
      : (system.$queryRaw as (...a: unknown[]) => Promise<unknown>).apply(system, args),
  session: faultySessions(system.session),
  // Better Auth's adapter gets an extended client (session-token-hash.ts): keep the
  // injected insert failure on it too.
  $extends: (...args: unknown[]) => {
    const extended = (system.$extends as unknown as (...a: unknown[]) => PrismaClient)(...args);
    return bindAll<PrismaClient>(extended, { session: faultySessions(extended.session) });
  },
});

const test = createTestAuth(faulty, SECRET);

beforeEach(async () => {
  faults.claim = false;
  faults.sessionCreate = false;
  await resetDatabase(system);
});
afterAll(async () => {
  await system.$disconnect();
});

const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
const setsSessionCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .some((cookie) => /session_token=[^;]+/.test(cookie) && !/Max-Age=0/i.test(cookie));

let counter = 0;
/** An account with TOTP enabled; returns its email, id and setup key. */
async function enrolledAccount() {
  counter += 1;
  const email = `replay-${String(counter)}-${Date.now().toString(36)}@example.com`;
  await test.auth.api.signUpEmail({ body: { name: "Admin", email, password: PASSWORD } });
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
  const confirmed = await test.auth.api.verifyTOTP({
    body: { code: totp(key) },
    headers,
    asResponse: true,
  });
  expect(confirmed.ok).toBe(true);
  const user = await system.user.findUniqueOrThrow({ where: { email } });
  expect(user.twoFactorEnabled).toBe(true);
  return { email, id: user.id, key };
}

/** Password step: no session, a signed challenge cookie. */
async function challenge(email: string): Promise<Headers> {
  const response = await test.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  expect(((await response.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
  expect(setsSessionCookie(response)).toBe(false);
  return new Headers({ cookie: cookieHeader(response) });
}

async function verify(headers: Headers, code: string): Promise<Response> {
  try {
    return await test.auth.api.verifyTOTP({ body: { code }, headers, asResponse: true });
  } catch (error) {
    // A thrown database error reaches the caller as an exception, not a response.
    return new Response(String(error instanceof Error ? error.message : error), { status: 599 });
  }
}

const sessions = (userId: string) => system.session.count({ where: { userId } });

describe("TOTP replay guard (claim before the session exists)", () => {
  it("accepts a code once; a replay creates no session and sets no cookie", async () => {
    const account = await enrolledAccount();
    const before = await sessions(account.id);
    const code = totp(account.key, 1);

    const first = await verify(await challenge(account.email), code);
    expect(first.status).toBe(200);
    expect(setsSessionCookie(first)).toBe(true);
    expect(await sessions(account.id)).toBe(before + 1);
    const marked = await system.session.count({
      where: { userId: account.id, mfaVerifiedAt: { not: null } },
    });
    expect(marked).toBeGreaterThanOrEqual(1);

    const replay = await verify(await challenge(account.email), code);
    expect(replay.ok).toBe(false);
    expect(setsSessionCookie(replay)).toBe(false);
    expect(await sessions(account.id)).toBe(before + 1);
  });

  it("lets exactly one of many concurrent uses of one code create a session", async () => {
    const account = await enrolledAccount();
    const before = await sessions(account.id);
    const code = totp(account.key, 1);
    const challenges = await Promise.all(Array.from({ length: 5 }, () => challenge(account.email)));
    const responses = await Promise.all(challenges.map((headers) => verify(headers, code)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter(setsSessionCookie)).toHaveLength(1);
    expect(await sessions(account.id)).toBe(before + 1);
  });

  it("fails closed when the claim fails: no session, no cookie, the code stays usable", async () => {
    const account = await enrolledAccount();
    const before = await sessions(account.id);
    const code = totp(account.key, 1);

    const pending = await challenge(account.email);
    faults.claim = true;
    const failed = await verify(pending, code);
    expect(failed.ok).toBe(false);
    expect(setsSessionCookie(failed)).toBe(false);
    expect(await sessions(account.id)).toBe(before);
    expect(await system.twoFactorUsedCode.count({ where: { userId: account.id } })).toBe(0);

    // The failure consumed nothing: the same valid code works once the database is back.
    faults.claim = false;
    const retried = await verify(await challenge(account.email), code);
    expect(retried.status).toBe(200);
    expect(await sessions(account.id)).toBe(before + 1);
  });

  it("fails closed when the session insert fails after the claim: no session, no cookie", async () => {
    const account = await enrolledAccount();
    const before = await sessions(account.id);
    const code = totp(account.key, 1);
    // Taken now, not later: computed after a 30-second boundary, totp(key, 0) would equal
    // `code` (already used). Both stay inside the server's ±1-step window if one is crossed.
    const nextCode = totp(account.key, 0);

    // (The password step itself creates and drops a session: inject after it.)
    const pending = await challenge(account.email);
    faults.sessionCreate = true;
    const failed = await verify(pending, code);
    expect(failed.ok).toBe(false);
    expect(setsSessionCookie(failed)).toBe(false);
    expect(await sessions(account.id)).toBe(before);

    // That code was presented with the right password and accepted, so it counts as used;
    // the next code signs in normally (no lock-out).
    faults.sessionCreate = false;
    const reused = await verify(await challenge(account.email), code);
    expect(reused.ok).toBe(false);
    const next = await verify(await challenge(account.email), nextCode);
    expect(next.status).toBe(200);
    expect(await sessions(account.id)).toBe(before + 1);
  });

  it("does not consume codes for wrong guesses, and backup codes keep working", async () => {
    const account = await enrolledAccount();
    const wrong = await verify(
      await challenge(account.email),
      "000000" === totp(account.key, 1) ? "111111" : "000000",
    );
    expect(wrong.ok).toBe(false);
    expect(await system.twoFactorUsedCode.count({ where: { userId: account.id } })).toBe(0);

    const signIn = await challenge(account.email);
    const row = await system.twoFactor.findUniqueOrThrow({ where: { userId: account.id } });
    expect(row.backupCodes).not.toContain("-"); // stored encrypted
    // A regenerated set (password + session) gives us plain codes to try.
    const valid = await verify(signIn, totp(account.key, 1));
    expect(valid.status).toBe(200);
    const session = new Headers({ cookie: cookieHeader(valid) });
    const codes = await test.auth.api.generateBackupCodes({
      body: { password: PASSWORD },
      headers: session,
    });
    const backup = codes.backupCodes[0] ?? "";
    const viaBackup = await test.auth.api.verifyBackupCode({
      body: { code: backup },
      headers: await challenge(account.email),
      asResponse: true,
    });
    expect(viaBackup.status).toBe(200);
    expect(setsSessionCookie(viaBackup)).toBe(true);
  });
});
