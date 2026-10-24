// scripts/ops/rehash-session-tokens.sh (Pass 41): the roll-forward step after a rollback
// to a release that stored session tokens raw. Runs the real script against the integration
// database, with sessions written by the current release and by the previous one (the same
// Better Auth configuration without the hashing layer).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { signInWithEmail, signUpWithEmail } from "@/server/auth/credentials";
import { hashSessionToken } from "@/server/auth/session-token-hash";

import { createTestAuth, depsFor, type TestAuth } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";
import { resolveTestDatabaseUrl } from "./test-database";

const SCRIPT = join(import.meta.dirname, "../../scripts/ops/rehash-session-tokens.sh");
const url = resolveTestDatabaseUrl();
const { system } = createTestDb();
const SECRET = ["rehash", "script", "test", "secret", "0123456789abcdef"].join("-");
const PASSWORD = "correct horse battery";
const COOKIE = "flexibx.session_token";
const current = createTestAuth(system, SECRET);
const previous = createTestAuth(
  new Proxy(system, {
    get: (target, key): unknown =>
      key === "$extends" ? () => target : (Reflect.get(target, key, target) as unknown),
  }),
  SECRET,
);

function run(env: Record<string, string>) {
  const result = spawnSync("bash", [SCRIPT], {
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

async function signIn(harness: TestAuth): Promise<string> {
  const result = await signInWithEmail(
    harness.auth,
    { email: "rehash@example.com", password: PASSWORD },
    depsFor(harness),
  );
  if (result.status !== "SIGNED_IN") throw new Error(result.status);
  const header = result.setCookie.find((cookie) => cookie.startsWith(`${COOKIE}=`)) ?? "";
  return decodeURIComponent(header.split(";")[0]?.slice(COOKIE.length + 1) ?? "");
}
const tokenOf = (cookie: string) => cookie.split(".")[0] ?? "";
const emailOn = async (harness: TestAuth, cookie: string) =>
  (
    await harness.auth.api.getSession({
      headers: new Headers({ cookie: `${COOKIE}=${encodeURIComponent(cookie)}` }),
    })
  )?.user.email ?? null;

beforeEach(async () => {
  await resetDatabase(system);
  await signUpWithEmail(
    current.auth,
    { email: "rehash@example.com", password: PASSWORD, name: "Rehash" },
    depsFor(current),
    "en",
  );
});
afterAll(async () => {
  await system.$disconnect();
});

describe("rehash-session-tokens.sh (roll-forward after a rollback)", () => {
  it("hashes only raw tokens, touches nothing else, prints counts only, is idempotent", async () => {
    const hashedBefore = await signIn(current);
    const raw = await signIn(previous); // written raw by the previous release
    expect(await emailOn(current, raw)).toBeNull(); // not found until rehashed

    const snapshot = async () => ({
      sessions: await system.session.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          token: true,
          userId: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
          ipAddress: true,
          userAgent: true,
          mfaVerifiedAt: true,
        },
      }),
      users: await system.user.findMany({ orderBy: { id: "asc" } }),
      accounts: await system.account.count(),
    });
    const before = await snapshot();

    const first = run({ REHASH_DATABASE_URL: url });
    expect(first.status).toBe(0);
    expect(JSON.parse(first.out.trim())).toEqual({ status: "OK", rehashed: 1, sessions: 2 });
    // Neither token (raw or hashed), nor the URL or its password, reaches the output.
    for (const secret of [tokenOf(raw), hashSessionToken(tokenOf(raw)), url]) {
      expect(first.out).not.toContain(secret);
    }
    const password = new URL(url).password;
    if (password !== "") expect(first.out).not.toContain(password);

    const after = await snapshot();
    expect(after.users).toEqual(before.users);
    expect(after.accounts).toBe(before.accounts);
    for (const [index, row] of after.sessions.entries()) {
      const was = before.sessions[index];
      expect({ ...row, token: "" }).toEqual({ ...was, token: "" }); // every other column
      expect(row.token).toBe(
        was?.token.startsWith("h1$") ? was.token : hashSessionToken(was?.token ?? ""),
      );
    }

    // Both sessions work on the current release; a second run changes nothing.
    expect(await emailOn(current, raw)).toBe("rehash@example.com");
    expect(await emailOn(current, hashedBefore)).toBe("rehash@example.com");
    const second = run({ REHASH_DATABASE_URL: url });
    expect(JSON.parse(second.out.trim())).toEqual({ status: "OK", rehashed: 0, sessions: 2 });
    expect(await snapshot()).toEqual(after);
  });

  it("refuses without a URL, and fails without leaking it when the database is unreachable", () => {
    expect(run({}).status).not.toBe(0);
    const unreachable = "postgresql://nobody:not-a-real-password@127.0.0.1:1/none";
    const result = run({ REHASH_DATABASE_URL: unreachable, PGCONNECT_TIMEOUT: "2" });
    expect(result.status).toBe(1);
    expect(result.out).toContain('"status":"FAILED"');
    expect(result.out).not.toContain("not-a-real-password");
  });
});
