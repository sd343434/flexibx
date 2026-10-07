// Better Auth on the real schema + migration (Phase 2, step 2). The auth instance is
// built with the production factory (createAuth) and the system client.
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "@/server/errors/app-error";
import { createAuth, type AuthLogLevel } from "@/server/auth/auth-config";
import { signInWithEmail, signUpWithEmail } from "@/server/auth/credentials";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();

const BASE = "http://localhost:3000";
const SECRET = ["integration", "test", "only", "secret", "0123456789abcdef"].join("-");
const PASSWORD = "correct horse battery";
const COOKIE = "flexibx.session_token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const logs: { level: AuthLogLevel; message: string }[] = [];
const auth = createAuth({
  db: system,
  secret: SECRET,
  baseURL: BASE,
  isProduction: false,
  log: (level, message) => logs.push({ level, message }),
});

// ── helpers ──────────────────────────────────────────────────────────────────

function sessionSetCookie(setCookie: readonly string[]): string {
  const header = setCookie.find((cookie) => cookie.startsWith(`${COOKIE}=`));
  if (header === undefined) throw new Error("no session cookie");
  return header;
}
const cookieValue = (setCookie: string) =>
  decodeURIComponent(setCookie.split(";")[0]?.slice(COOKIE.length + 1) ?? "");
const tokenOf = (cookie: string) => cookie.split(".")[0] ?? "";
const cookieHeader = (value: string) => `${COOKIE}=${encodeURIComponent(value)}`;
const headersWith = (value: string) => new Headers({ cookie: cookieHeader(value) });

async function register(email: string, name = "Test User") {
  return signUpWithEmail(auth, { email, password: PASSWORD, name });
}

async function signIn(email: string, password = PASSWORD) {
  const result = await signInWithEmail(auth, { email, password }, new Headers());
  if (result.status !== "SIGNED_IN") throw new Error(`sign-in failed: ${result.status}`);
  return cookieValue(sessionSetCookie(result.setCookie));
}

function post(path: string, headers: Record<string, string>, body: unknown = {}) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await resetDatabase(system);
  logs.length = 0;
});

afterAll(async () => {
  await system.$disconnect();
});

// ── sign-up ──────────────────────────────────────────────────────────────────

describe("sign-up", () => {
  it("creates a user in the existing users table with a Postgres UUID and Arabic default locale", async () => {
    expect(await register("new@example.com")).toEqual({ status: "ACCEPTED" });
    const user = await system.user.findUniqueOrThrow({ where: { email: "new@example.com" } });
    expect(user.id).toMatch(UUID);
    expect(user).toMatchObject({ locale: "ar", emailVerified: false, isPlatformAdmin: false });
  });

  it("normalizes the email (trim + lowercase) and accepts any case at sign-in", async () => {
    await register("  Mixed.Case@Example.COM ");
    const user = await system.user.findFirstOrThrow({ where: { email: "mixed.case@example.com" } });
    expect(user.email).toBe("mixed.case@example.com");
    expect(await signIn("MIXED.case@example.com")).toContain(".");
  });

  it("never lets input set isPlatformAdmin or locale", async () => {
    // Flexibx entry point: unknown keys are dropped before Better Auth sees them.
    await signUpWithEmail(auth, {
      email: "admin-try@example.com",
      password: PASSWORD,
      name: "X",
      ...({ isPlatformAdmin: true, locale: "en" } as object),
    });
    expect(
      await system.user.findUniqueOrThrow({ where: { email: "admin-try@example.com" } }),
    ).toMatchObject({ isPlatformAdmin: false, locale: "ar" });

    // Better Auth itself rejects input:false fields outright.
    const forbidden = {
      email: "direct@example.com",
      password: PASSWORD,
      name: "X",
      isPlatformAdmin: true,
    };
    const direct = await auth.api.signUpEmail({ body: forbidden, asResponse: true });
    expect(direct.status).toBe(400);
    expect(await system.user.count({ where: { isPlatformAdmin: true } })).toBe(0);
  });

  it("hashes passwords with Better Auth's scrypt (no plaintext stored)", async () => {
    await register("hash@example.com");
    const account = await system.account.findFirstOrThrow({
      where: { user: { email: "hash@example.com" } },
    });
    expect(account.id).toMatch(UUID);
    expect(account.providerId).toBe("credential");
    expect(account.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(account.password).not.toContain(PASSWORD);
  });

  it("answers an existing email exactly like a new one and creates nothing", async () => {
    const first = await register("dup@example.com");
    const second = await register("dup@example.com", "Someone Else");
    expect(second).toEqual(first);
    expect(await system.user.count({ where: { email: "dup@example.com" } })).toBe(1);
    expect(await system.session.count()).toBe(0); // no auto sign-in on either path
  });

  it("rejects invalid input with field codes only", async () => {
    await expect(
      signUpWithEmail(auth, { email: "not-an-email", password: "short", name: "" }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof AppError &&
        error.code === "VALIDATION_FAILED" &&
        !JSON.stringify(error.fields).includes("short"),
    );
  });
});

// ── sign-in, enumeration ─────────────────────────────────────────────────────

describe("sign-in", () => {
  it("signs in with the right password and creates a database session", async () => {
    await register("login@example.com");
    const cookie = await signIn("login@example.com");
    const session = await system.session.findUniqueOrThrow({ where: { token: tokenOf(cookie) } });
    expect(session.id).toMatch(UUID);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
  });

  it("returns one generic result for a wrong password, an unknown email and malformed input", async () => {
    await register("login@example.com");
    const attempt = (email: string, password: string) =>
      signInWithEmail(auth, { email, password }, new Headers());
    const wrong = await attempt("login@example.com", "not the password");
    expect(wrong).toEqual({ status: "INVALID_CREDENTIALS" });
    expect(await attempt("nobody@example.com", "not the password")).toEqual(wrong);
    expect(await attempt("not-an-email", "x")).toEqual(wrong);
    expect(await system.session.count()).toBe(0);
  });

  it("does not expose Better Auth's sign-up/sign-in over HTTP (no enumeration surface)", async () => {
    await register("exists@example.com");
    for (const email of ["exists@example.com", "missing@example.com"]) {
      const origin = { origin: BASE };
      expect(
        (await post("/sign-up/email", origin, { email, password: PASSWORD, name: "N" })).status,
      ).toBe(404);
      expect((await post("/sign-in/email", origin, { email, password: PASSWORD })).status).toBe(
        404,
      );
    }
    expect(await system.user.count()).toBe(1);
  });

  it("a Phase 1 user without credentials cannot sign in, and no account is created", async () => {
    await createTenant(system);
    const user = await system.user.findFirstOrThrow();
    expect(
      await signInWithEmail(auth, { email: user.email, password: PASSWORD }, new Headers()),
    ).toEqual({ status: "INVALID_CREDENTIALS" });
    expect(await system.account.count()).toBe(0);
  });
});

// ── sessions ─────────────────────────────────────────────────────────────────

describe("sessions", () => {
  it("retrieves the session from the signed cookie, also through the HTTP handler", async () => {
    await register("me@example.com");
    const cookie = await signIn("me@example.com");
    const session = await auth.api.getSession({ headers: headersWith(cookie) });
    expect(session?.user.email).toBe("me@example.com");

    const response = await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, { headers: { cookie: cookieHeader(cookie) } }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { user: { email: string } }).user.email).toBe(
      "me@example.com",
    );
  });

  it("stores the raw token, but only a cookie signed with AUTH_SECRET is accepted", async () => {
    await register("raw@example.com");
    const cookie = await signIn("raw@example.com");
    const token = tokenOf(cookie);
    expect(await system.session.count({ where: { token } })).toBe(1);
    // No custom hashing layer: a database copy of the token alone cannot be used.
    expect(await auth.api.getSession({ headers: headersWith(token) })).toBeNull();
    expect(await auth.api.getSession({ headers: headersWith(`${token}.forged`) })).toBeNull();

    const otherSecret = createAuth({
      db: system,
      secret: `${SECRET}-rotated`,
      baseURL: BASE,
      isProduction: false,
      log: () => undefined,
    });
    // Rotating AUTH_SECRET invalidates every existing cookie.
    expect(await otherSecret.api.getSession({ headers: headersWith(cookie) })).toBeNull();
  });

  it("rejects expired sessions", async () => {
    await register("expiry@example.com");
    const cookie = await signIn("expiry@example.com");
    await system.session.update({
      where: { token: tokenOf(cookie) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await auth.api.getSession({ headers: headersWith(cookie) })).toBeNull();
  });

  it("rolls a session forward to 7 days once it is older than a day", async () => {
    await register("rolling@example.com");
    const cookie = await signIn("rolling@example.com");
    const where = { token: tokenOf(cookie) };
    await system.session.update({
      where,
      data: { expiresAt: new Date(Date.now() + 5 * 86_400_000) },
    });
    await auth.api.getSession({ headers: headersWith(cookie) });
    const rolled = await system.session.findUniqueOrThrow({ where });
    expect(rolled.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);

    // Fresh sessions (< 1 day since last refresh) are not rewritten on every request.
    const before = rolled.expiresAt.getTime();
    await auth.api.getSession({ headers: headersWith(cookie) });
    expect((await system.session.findUniqueOrThrow({ where })).expiresAt.getTime()).toBe(before);
  });

  it("signs out (session row deleted, cookie cleared)", async () => {
    await register("out@example.com");
    const cookie = await signIn("out@example.com");
    const response = await post("/sign-out", { cookie: cookieHeader(cookie), origin: BASE });
    expect(response.status).toBe(200);
    expect(sessionSetCookie(response.headers.getSetCookie())).toMatch(/Max-Age=0/);
    expect(await system.session.count({ where: { token: tokenOf(cookie) } })).toBe(0);
    expect(await auth.api.getSession({ headers: headersWith(cookie) })).toBeNull();
  });

  it("revokes all of a user's sessions from the server; a password change revokes the others", async () => {
    await register("revoke@example.com");
    const a = await signIn("revoke@example.com");
    const b = await signIn("revoke@example.com");
    const changed = await auth.api.changePassword({
      headers: headersWith(a),
      body: {
        currentPassword: PASSWORD,
        newPassword: "another long password",
        revokeOtherSessions: true,
      },
      asResponse: true,
    });
    expect(changed.status).toBe(200);
    const rotated = cookieValue(sessionSetCookie(changed.headers.getSetCookie()));
    expect(await auth.api.getSession({ headers: headersWith(b) })).toBeNull();
    expect(await auth.api.getSession({ headers: headersWith(a) })).toBeNull();
    expect(await auth.api.getSession({ headers: headersWith(rotated) })).not.toBeNull();

    const user = await system.user.findUniqueOrThrow({ where: { email: "revoke@example.com" } });
    await (await auth.$context).internalAdapter.deleteUserSessions(user.id);
    expect(await auth.api.getSession({ headers: headersWith(rotated) })).toBeNull();
    expect(await system.session.count({ where: { userId: user.id } })).toBe(0);
  });
});

// ── origin / CSRF ────────────────────────────────────────────────────────────

describe("origin and CSRF protection", () => {
  it("stays active in Better Auth's test mode (NODE_ENV=test or TEST=true)", () => {
    // Vitest sets TEST=true, which Better Auth treats as test mode — the mode in which it
    // disables origin/CSRF checks unless configured otherwise. The rejections in this
    // block therefore prove the explicit `disableOriginCheck: false` takes effect.
    expect(process.env.NODE_ENV === "test" || process.env.TEST === "true").toBe(true);
    expect(auth.options.advanced.disableOriginCheck).toBe(false);
  });

  it("without the explicit setting, Better Auth's test mode would accept a foreign origin", async () => {
    await register("unprotected@example.com");
    const cookie = await signIn("unprotected@example.com");
    const defaults = betterAuth({
      secret: SECRET,
      baseURL: BASE,
      trustedOrigins: [BASE],
      database: prismaAdapter(system, { provider: "postgresql" }),
      telemetry: { enabled: false },
      advanced: { cookiePrefix: "flexibx", database: { generateId: false } },
    });
    const response = await defaults.handler(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader(cookie),
          origin: "https://evil.example",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200); // documents the library default this config overrides
  });

  it("rejects a cookie-authenticated mutation from an untrusted origin", async () => {
    await register("csrf@example.com");
    const cookie = await signIn("csrf@example.com");
    const response = await post("/sign-out", {
      cookie: cookieHeader(cookie),
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(await system.session.count({ where: { token: tokenOf(cookie) } })).toBe(1);
  });

  it("rejects cross-site mutations with no Origin/Referer, or a cross-site Referer", async () => {
    await register("csrf@example.com");
    const cookie = await signIn("csrf@example.com");
    expect((await post("/sign-out", { cookie: cookieHeader(cookie) })).status).toBe(403);
    expect(
      (await post("/sign-out", { cookie: cookieHeader(cookie), referer: "https://evil.example/x" }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          "/change-password",
          { cookie: cookieHeader(cookie), origin: "https://evil.example" },
          { currentPassword: PASSWORD, newPassword: "attacker chosen pw" },
        )
      ).status,
    ).toBe(403);
    expect(await auth.api.getSession({ headers: headersWith(cookie) })).not.toBeNull();
  });
});

// ── logs, tenancy, Phase 1 data ──────────────────────────────────────────────

describe("logging and data boundaries", () => {
  it("never logs session tokens, passwords or IP addresses", async () => {
    await register("logs@example.com");
    const cookie = await signIn("logs@example.com");
    await signInWithEmail(
      auth,
      { email: "logs@example.com", password: "wrong password!" },
      new Headers(),
    );
    await post("/sign-out", {
      cookie: cookieHeader(cookie),
      origin: "https://evil.example",
      "x-forwarded-for": "203.0.113.7",
    });
    await auth.api.getSession({ headers: headersWith(cookie) });

    expect(logs.length).toBeGreaterThan(0); // the rejected origin is logged
    const output = JSON.stringify(logs);
    expect(output).not.toContain(tokenOf(cookie));
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain("wrong password!");
    expect(output).not.toContain("203.0.113.7");
  });

  it("does not record client IPs unless a trusted IP header is configured", async () => {
    await register("ip@example.com");
    const result = await signInWithEmail(
      auth,
      { email: "ip@example.com", password: PASSWORD },
      new Headers({ "x-forwarded-for": "203.0.113.7" }),
    );
    expect(result.status).toBe("SIGNED_IN");
    const session = await system.session.findFirstOrThrow();
    expect(session.ipAddress ?? "").toBe("");
  });

  it("keeps auth tables out of the application (tenant-guarded) client", async () => {
    const code = async (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error: unknown) => (error instanceof AppError ? error.code : "other"),
      );
    expect(await code(db.session.findMany())).toBe("TENANT_SCOPE_MISSING");
    expect(await code(db.account.findMany())).toBe("TENANT_SCOPE_MISSING");
    expect(await code(db.verification.findMany())).toBe("TENANT_SCOPE_MISSING");
    expect(await code(db.user.findMany({ include: { sessions: true } }))).toBe(
      "TENANT_SCOPE_MISSING",
    );
  });

  it("leaves existing Phase 1 users, workspaces, memberships and audit logs untouched", async () => {
    const tenant = await createTenant(system);
    await system.auditLog.create({
      data: {
        workspaceId: tenant.workspaceId,
        action: "workspace.created",
        entityType: "workspace",
      },
    });
    const snapshot = async () => ({
      users: await system.user.findMany({ orderBy: { id: "asc" } }),
      workspaces: await system.workspace.findMany({ orderBy: { id: "asc" } }),
      members: await system.workspaceMember.findMany({ orderBy: { id: "asc" } }),
      audit: await system.auditLog.findMany({ orderBy: { id: "asc" } }),
    });
    const before = await snapshot();

    await register("other@example.com");
    const cookie = await signIn("other@example.com");
    await post("/sign-out", { cookie: cookieHeader(cookie), origin: BASE });

    const after = await snapshot();
    expect(after.workspaces).toEqual(before.workspaces);
    expect(after.members).toEqual(before.members);
    expect(after.audit).toEqual(before.audit);
    for (const user of before.users) expect(after.users).toContainEqual(user);
    expect(after.users).toHaveLength(before.users.length + 1);
  });
});
