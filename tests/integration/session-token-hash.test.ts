// Session tokens stored hashed (src/server/auth/session-token-hash.ts, Pass 39), on the real
// database with the production Better Auth configuration: several devices, sign-out of one
// device, expiry, the migration of rows written before the change (users stay signed in),
// and failure behaviour. Theft of the stored value is in auth.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { signInWithEmail, signUpWithEmail } from "@/server/auth/credentials";
import { hashSessionToken, SESSION_TOKEN_HASH_PREFIX } from "@/server/auth/session-token-hash";
import { createPrismaClient } from "@/server/db/prisma";

import { createTestAuth, depsFor } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";

const { system } = createTestDb();
const SECRET = ["session", "hash", "test", "secret", "0123456789abcdef"].join("-");
const PASSWORD = "correct horse battery";
const COOKIE = "flexibx.session_token";
const harness = createTestAuth(system, SECRET);
const { auth } = harness;
const MIGRATION = readFileSync(
  join(process.cwd(), "prisma/migrations/20261023120000_hash_session_tokens/migration.sql"),
  "utf8",
);

const cookieValue = (setCookie: readonly string[]) => {
  const header = setCookie.find((cookie) => cookie.startsWith(`${COOKIE}=`)) ?? "";
  return decodeURIComponent(header.split(";")[0]?.slice(COOKIE.length + 1) ?? "");
};
const tokenOf = (cookie: string) => cookie.split(".")[0] ?? "";
const headersWith = (cookie: string) =>
  new Headers({ cookie: `${COOKIE}=${encodeURIComponent(cookie)}` });
const emailOf = async (cookie: string) =>
  (await auth.api.getSession({ headers: headersWith(cookie) }))?.user.email ?? null;

async function device(email: string): Promise<string> {
  const result = await signInWithEmail(auth, { email, password: PASSWORD }, depsFor(harness));
  if (result.status !== "SIGNED_IN") throw new Error(result.status);
  return cookieValue(result.setCookie);
}

/** Runs the migration's statements (it is one transaction: BEGIN … COMMIT). */
async function migrate() {
  // eslint-disable-next-line no-restricted-properties -- the committed migration file, no input
  await system.$executeRawUnsafe(MIGRATION.replace(/^--.*$/gm, "").replace(/BEGIN;|COMMIT;/g, ""));
}

beforeEach(async () => {
  await resetDatabase(system);
  await signUpWithEmail(
    auth,
    { email: "multi@example.com", password: PASSWORD, name: "Multi" },
    depsFor(harness),
    "en",
  );
});
afterAll(async () => {
  await system.$disconnect();
});

describe("session tokens stored hashed (Pass 39)", () => {
  it("gives each device its own hashed row; signing out one device keeps the other", async () => {
    const laptop = await device("multi@example.com");
    const phone = await device("multi@example.com");
    const rows = await system.session.findMany({ select: { token: true } });
    expect(rows.map((row) => row.token).sort()).toEqual(
      [hashSessionToken(tokenOf(laptop)), hashSessionToken(tokenOf(phone))].sort(),
    );
    for (const row of rows) expect(row.token.startsWith(SESSION_TOKEN_HASH_PREFIX)).toBe(true);

    await auth.api.signOut({ headers: headersWith(phone) });
    expect(await emailOf(phone)).toBeNull();
    expect(await emailOf(laptop)).toBe("multi@example.com");
    expect(await system.session.count()).toBe(1);
  });

  it("refuses an expired session, whatever the cookie", async () => {
    const cookie = await device("multi@example.com");
    await system.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await emailOf(cookie)).toBeNull();
  });

  it("keeps users signed in across the migration of rows written before it; idempotent", async () => {
    const cookie = await device("multi@example.com");
    // A row as the previous release stored it: the raw token.
    await system.session.updateMany({ data: { token: tokenOf(cookie) } });
    expect(await emailOf(cookie)).toBeNull(); // the new code alone no longer finds it
    await migrate();
    const [row] = await system.session.findMany();
    expect(row?.token).toBe(hashSessionToken(tokenOf(cookie)));
    expect(await emailOf(cookie)).toBe("multi@example.com");
    await migrate(); // a second run changes nothing
    expect((await system.session.findMany())[0]?.token).toBe(row?.token);
    expect(await emailOf(cookie)).toBe("multi@example.com");
  });

  it("serves the disabled token routes as 404", async () => {
    const cookie = await device("multi@example.com");
    for (const path of [
      "/list-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
    ]) {
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: path === "/list-sessions" ? "GET" : "POST",
          headers: {
            cookie: `${COOKIE}=${encodeURIComponent(cookie)}`,
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          ...(path === "/list-sessions" ? {} : { body: "{}" }),
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(await emailOf(cookie)).toBe("multi@example.com");
  });

  it("fails closed when the database is unreachable: no session, no error leak", async () => {
    const cookie = await device("multi@example.com");
    const broken = createTestAuth(
      createPrismaClient("postgresql://nobody:wrong@127.0.0.1:1/none?connect_timeout=1"),
      SECRET,
    );
    const outcome = await broken.auth.api
      .getSession({ headers: headersWith(cookie) })
      .then((session) => ({ session }))
      .catch((error: unknown) => ({ error }));
    expect("session" in outcome ? outcome.session : null).toBeNull();
  });

  // Pass 40: rollback and roll-forward, with the previous release simulated as the same
  // Better Auth configuration without the hashing layer (what a463d1c runs).
  it("rollback signs users out once without errors; roll-forward needs the statement re-run", async () => {
    const previous = createTestAuth(
      new Proxy(system, {
        get: (target, key): unknown =>
          key === "$extends" ? () => target : (Reflect.get(target, key, target) as unknown),
      }),
      SECRET,
    );
    const previousEmailOf = async (cookie: string) =>
      (await previous.auth.api.getSession({ headers: headersWith(cookie) }))?.user.email ?? null;
    const before = await device("multi@example.com"); // signed in on the new release

    // Rolled back: the hashed row is not found — signed out, no error, the row is kept.
    expect(await previousEmailOf(before)).toBeNull();
    expect(await system.session.count()).toBe(1);
    // Signing in again on the previous release stores a raw token, as it always did.
    const result = await signInWithEmail(
      previous.auth,
      { email: "multi@example.com", password: PASSWORD },
      depsFor(previous),
    );
    if (result.status !== "SIGNED_IN") throw new Error(result.status);
    const during = cookieValue(result.setCookie);
    expect(await previousEmailOf(during)).toBe("multi@example.com");

    // Rolled forward: the session from before the rollback is valid again (its row stayed);
    // the one created during the rollback is not — until the hashing statement runs again
    // (Prisma will not re-run an applied migration: SESSION_TOKENS.md § rollback).
    expect(await emailOf(before)).toBe("multi@example.com");
    expect(await emailOf(during)).toBeNull();
    await migrate();
    expect(await emailOf(during)).toBe("multi@example.com");
    expect(await emailOf(before)).toBe("multi@example.com");
  });
});
