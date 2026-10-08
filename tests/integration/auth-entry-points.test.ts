// Proof that every user-controlled authentication entry point passes the rate-limit
// checkpoint (rate-limit-policy.ts) before Better Auth does any work, that each passes
// it exactly once per bucket, and that the public HTTP route serves nothing that could
// skip it. Real database, production Better Auth configuration, real public route.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as RouteModule from "@/app/api/auth/[...all]/route";
import {
  changePassword,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  verifyEmailToken,
} from "@/server/auth/account-security";
import { DISABLED_HTTP_PATHS, type Auth } from "@/server/auth/auth-config";
import { signInWithEmail, signUpWithEmail, type SignInResult } from "@/server/auth/credentials";
import { rateLimited, type RateLimitCheck, type RateLimiter } from "@/server/auth/rate-limit";
import type { RateLimitBucket } from "@/server/auth/rate-limit-policy";
import { isAppError } from "@/server/errors/app-error";

import { createTestAuth, TEST_IP_HEADER } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
  cookies: () => Promise.reject(new Error("`cookies` was called outside a request scope.")),
}));

const BASE = "http://localhost:3000";
const { system } = createTestDb();
const SECRET = ["entry", "points", "test", "only", "0123456789abcdef"].join("-");
const PASSWORD = "correct horse battery";
const COOKIE = "flexibx.session_token";
const test = createTestAuth(system, SECRET, { ipHeader: TEST_IP_HEADER });

let route: typeof RouteModule;

beforeAll(async () => {
  // The real route module builds its own auth instance from the environment; the same
  // secret lets it read sessions created through `test.auth`.
  process.env.APP_URL = BASE;
  process.env.AUTH_SECRET = SECRET;
  route = await import("@/app/api/auth/[...all]/route");
});

beforeEach(async () => {
  await resetDatabase(system);
  test.mailer.clear();
});

afterAll(async () => {
  const { getSystemDb } = await import("@/server/db/client");
  await getSystemDb().$disconnect();
  await system.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

let ipCounter = 0;
function client(): Headers {
  ipCounter += 1;
  return new Headers({ [TEST_IP_HEADER]: `203.0.113.${String((ipCounter % 250) + 1)}` });
}

let counter = 0;
async function account(): Promise<string> {
  counter += 1;
  const email = `entry-${String(counter)}-${Date.now().toString(36)}@example.com`;
  await signUpWithEmail(
    test.auth,
    { name: "Reem", email, password: PASSWORD },
    { limit: test.limit, headers: client() },
    "en",
  );
  return email;
}

async function sessionCookie(email: string): Promise<string> {
  const result: SignInResult = await signInWithEmail(
    test.auth,
    { email, password: PASSWORD },
    { limit: test.limit, headers: client() },
  );
  if (result.status !== "SIGNED_IN") throw new Error(`not signed in: ${result.status}`);
  const header = result.setCookie.find((cookie) => cookie.startsWith(`${COOKIE}=`)) ?? "";
  return header.split(";")[0] ?? "";
}

/** A limiter that records every check and refuses the bucket named `refuse`. */
function recordingLimiter(refuse?: RateLimitBucket) {
  const calls: RateLimitCheck[] = [];
  const limit: RateLimiter = (check) => {
    calls.push(check);
    return check.bucket === refuse ? Promise.reject(rateLimited(check.bucket)) : Promise.resolve();
  };
  return { calls, limit };
}

/** Spies on every Better Auth server endpoint of `auth` (calls still go through). */
function spyOnBetterAuth(auth: Auth) {
  const api = auth.api as unknown as Record<string, (...args: unknown[]) => unknown>;
  const spies = Object.keys(api)
    .filter((name) => typeof api[name] === "function")
    .map((name) => ({ name, spy: vi.spyOn(api, name) }));
  return {
    calledNames: () => spies.filter(({ spy }) => spy.mock.calls.length > 0).map(({ name }) => name),
    restore: () => {
      for (const { spy } of spies) spy.mockRestore();
    },
  };
}

/** Everything a Better Auth call could change, to show a refused call changed nothing. */
async function authState() {
  const [users, accounts, sessions, verifications] = await Promise.all([
    system.user.findMany({ orderBy: { id: "asc" } }),
    system.account.findMany({ orderBy: { id: "asc" } }),
    system.session.findMany({ orderBy: { id: "asc" } }),
    system.verification.findMany({ orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify({ users, accounts, sessions, verifications });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

// ── entry points ─────────────────────────────────────────────────────────────

interface EntryPoint {
  readonly name: string;
  /** The checkpoint buckets, in order, each passed exactly once. */
  readonly buckets: readonly RateLimitBucket[];
  /** The Better Auth server endpoint it reaches when allowed. */
  readonly betterAuth: string;
  readonly run: (
    limit: RateLimiter,
    context: { email: string; cookie: string },
  ) => Promise<unknown>;
}

const RESET_TOKEN = "A".repeat(24);

const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    name: "signUpWithEmail",
    buckets: ["sign-up"],
    betterAuth: "signUpEmail",
    run: (limit) =>
      signUpWithEmail(
        test.auth,
        { name: "New", email: `new-${String(Date.now())}@example.com`, password: PASSWORD },
        { limit, headers: client() },
        "en",
      ),
  },
  {
    name: "signInWithEmail",
    buckets: ["sign-in", "sign-in-account"],
    betterAuth: "signInEmail",
    run: (limit, { email }) =>
      signInWithEmail(test.auth, { email, password: PASSWORD }, { limit, headers: client() }),
  },
  {
    name: "resendVerificationEmail",
    buckets: ["verification-resend", "verification-resend-account"],
    betterAuth: "sendVerificationEmail",
    run: (limit, { email }) =>
      resendVerificationEmail({ auth: test.auth, limit, headers: client() }, { email }, "en"),
  },
  {
    name: "verifyEmailToken",
    buckets: ["verify-email"],
    betterAuth: "verifyEmail",
    run: async (limit, { email }) => {
      const { createEmailVerificationToken } = await import("better-auth/api");
      const token = await createEmailVerificationToken(SECRET, email);
      return verifyEmailToken({ auth: test.auth, limit, headers: client() }, { token });
    },
  },
  {
    name: "requestPasswordReset",
    buckets: ["password-reset-request", "password-reset-request-account"],
    betterAuth: "requestPasswordReset",
    run: (limit, { email }) =>
      requestPasswordReset({ auth: test.auth, limit, headers: client() }, { email }, "en"),
  },
  {
    name: "resetPasswordWithToken",
    buckets: ["password-reset"],
    betterAuth: "resetPassword",
    run: (limit) =>
      resetPasswordWithToken(
        { auth: test.auth, limit, headers: client() },
        { token: RESET_TOKEN, newPassword: "another long passphrase" },
      ),
  },
  {
    name: "changePassword",
    buckets: ["change-password"],
    betterAuth: "changePassword",
    run: async (limit, { cookie }) => {
      const session = await test.auth.api.getSession({ headers: new Headers({ cookie }) });
      if (session === null) throw new Error("no session");
      return changePassword(
        { auth: test.auth, limit, headers: new Headers({ cookie }) },
        session.user.id,
        { currentPassword: "wrong current password", newPassword: "another long passphrase" },
      );
    },
  },
];

async function context() {
  const email = await account();
  const cookie = await sessionCookie(email);
  return { email, cookie };
}

describe("every entry point passes the checkpoint first", () => {
  for (const entry of ENTRY_POINTS) {
    for (const refused of entry.buckets) {
      it(`${entry.name}: refused at ${refused} → RATE_LIMITED, Better Auth never called`, async () => {
        const ctx = await context();
        const before = await authState();
        const { calls, limit } = recordingLimiter(refused);
        const spies = spyOnBetterAuth(test.auth);
        try {
          const error = await rejection(entry.run(limit, ctx));
          expect(isAppError(error) && error.code).toBe("RATE_LIMITED");
          // getSession is the test's own lookup for changePassword, before the limiter.
          expect(spies.calledNames().filter((name) => name !== "getSession")).toEqual([]);
        } finally {
          spies.restore();
        }
        expect(calls.map((call) => call.bucket)).toEqual(
          entry.buckets.slice(0, entry.buckets.indexOf(refused) + 1),
        );
        expect(await authState()).toBe(before);
      });
    }

    it(`${entry.name}: allowed → each bucket exactly once, then Better Auth once`, async () => {
      const ctx = await context();
      const { calls, limit } = recordingLimiter();
      const api = test.auth.api as unknown as Record<string, (...args: unknown[]) => unknown>;
      const spy = vi.spyOn(api, entry.betterAuth);
      try {
        await entry.run(limit, ctx).catch(() => undefined);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(calls.map((call) => call.bucket)).toEqual(entry.buckets);
    });
  }
});

describe("the real checkpoint counts each request exactly once", () => {
  async function counts(): Promise<Record<string, number>> {
    const rows = await system.rateLimit.findMany();
    return Object.fromEntries(
      rows.map((row) => [
        row.key.replace(/^[^|]*\|/, "").replace(/\/[0-9a-f]{32}$/, "/<subject>"),
        row.count,
      ]),
    );
  }

  it("one sign-in: one count per bucket, nothing under Better Auth's own paths", async () => {
    const email = await account();
    await system.rateLimit.deleteMany();
    await signInWithEmail(
      test.auth,
      { email, password: PASSWORD },
      { limit: test.limit, headers: client() },
    );
    expect(await counts()).toEqual({
      "/flexibx/rate-limit/sign-in": 1,
      "/flexibx/rate-limit/sign-in-account/<subject>": 1,
    });
  });

  it("one reset request, one resend, one change: one count per bucket", async () => {
    const email = await account();
    const cookie = await sessionCookie(email);
    const session = await test.auth.api.getSession({ headers: new Headers({ cookie }) });
    await system.rateLimit.deleteMany();
    const deps = { auth: test.auth, limit: test.limit, headers: client() };
    await requestPasswordReset(deps, { email }, "en");
    await resendVerificationEmail(deps, { email }, "en");
    await changePassword({ ...deps, headers: new Headers({ cookie }) }, session?.user.id ?? "", {
      currentPassword: "wrong current password",
      newPassword: "another long passphrase",
    });
    expect(await counts()).toEqual({
      "/flexibx/rate-limit/password-reset-request": 1,
      "/flexibx/rate-limit/password-reset-request-account/<subject>": 1,
      "/flexibx/rate-limit/verification-resend": 1,
      "/flexibx/rate-limit/verification-resend-account/<subject>": 1,
      "/flexibx/rate-limit/change-password/<subject>": 1,
    });
  });

  it("the public route cannot reach the checkpoint (no counting, no bucket burning)", async () => {
    await system.rateLimit.deleteMany();
    for (const path of [
      "/flexibx/rate-limit/sign-in",
      `/flexibx/rate-limit/sign-in-account/${"a".repeat(32)}`,
      "/flexibx//rate-limit/sign-in",
      "/FLEXIBX/rate-limit/sign-in",
      "/flexibx%2Frate-limit%2Fsign-in",
    ]) {
      const response = await route.POST(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: { origin: BASE, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status, path).toBe(404);
    }
    expect(await system.rateLimit.count()).toBe(0);
  });
});

// ── public HTTP surface ──────────────────────────────────────────────────────

/**
 * The only Better Auth endpoints the public route may serve. None of them takes a
 * password, sends an email or consumes a token: session reads and management for an
 * existing session, and OAuth plumbing (no provider is configured). Every other
 * endpoint — including any a Better Auth upgrade adds — must answer 404.
 */
const PUBLIC_ENDPOINTS = new Set([
  "GET /get-session",
  "POST /sign-out",
  "GET /ok",
  "GET /error",
  "POST /sign-in/social",
  "GET /callback/:id",
  "POST /callback/:id",
  "POST /link-social",
  "POST /update-session",
  "POST /update-user",
  "POST /delete-user",
  "GET /delete-user/callback",
  "POST /change-email",
  "GET /list-sessions",
  "POST /revoke-session",
  "POST /revoke-sessions",
  "POST /revoke-other-sessions",
  "GET /list-accounts",
  "POST /unlink-account",
  "POST /refresh-token",
  "POST /get-access-token",
  "GET /account-info",
]);

/** Spellings of `path` a router could treat as the same endpoint. */
function aliases(path: string): string[] {
  return [
    path,
    `${path}/`,
    `${path}//`,
    path.toUpperCase(),
    `/${path}`,
    path.replaceAll("/", "//"),
    `/.${path}`,
    `/x/..${path}`,
    path.replaceAll("-", "%2D"),
    path.replaceAll("-", "%2d"),
    `/${encodeURIComponent(path.slice(1))}`,
    path.replace(/^\//, "/%2F"),
    `${path}%20`,
    `${path}?x=1`,
    `${path}#x`,
  ];
}

describe("the public HTTP route", () => {
  async function serve(method: string, path: string, cookie?: string, body = "{}") {
    const headers = new Headers({ origin: BASE, "content-type": "application/json" });
    if (cookie !== undefined) headers.set("cookie", cookie);
    const request = new Request(`${BASE}/api/auth${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body }),
    });
    return method === "GET" ? route.GET(request) : route.POST(request);
  }

  it("serves only the allowlisted Better Auth endpoints; everything else is 404", async () => {
    const { getAuth } = await import("@/server/auth/auth");
    const endpoints = Object.values(
      getAuth().api as unknown as Record<string, { path?: string; options?: { method?: unknown } }>,
    ).filter((endpoint) => typeof endpoint.path === "string");
    const served: string[] = [];
    for (const endpoint of endpoints) {
      const path = endpoint.path ?? "";
      for (const method of ([] as unknown[]).concat(endpoint.options?.method ?? "GET")) {
        if (method !== "GET" && method !== "POST") continue;
        const response = await serve(method, path.replace(/:[A-Za-z]+/g, "x"));
        // 405: a method the endpoint does not accept (POST /get-session).
        if (response.status !== 404 && response.status !== 405) served.push(`${method} ${path}`);
      }
    }
    expect(served.sort()).toEqual([...PUBLIC_ENDPOINTS].sort());
  });

  it("regression: /verify-password is not a password oracle — any method, any alias", async () => {
    const email = await account();
    const cookie = await sessionCookie(email);
    for (const variant of aliases("/verify-password")) {
      for (const method of ["GET", "POST"]) {
        const answers = new Set<string>();
        for (const password of ["wrong guess", PASSWORD]) {
          const response = await serve(method, variant, cookie, JSON.stringify({ password }));
          expect(response.status, `${method} ${variant}`).toBe(404);
          answers.add(await response.text());
        }
        // A wrong and the correct password get byte-identical answers.
        expect(answers.size, `${method} ${variant}`).toBe(1);
      }
    }
  });

  it("no disabled path is reachable through an alias (case, slashes, encoding)", async () => {
    for (const path of DISABLED_HTTP_PATHS) {
      for (const variant of aliases(path)) {
        for (const method of ["GET", "POST"]) {
          const response = await serve(method, variant);
          expect(response.status, `${method} ${variant}`).toBe(404);
        }
      }
    }
  });

  it("only GET and POST reach Better Auth (other methods have no handler: Next.js 405)", () => {
    expect(
      Object.keys(route)
        .filter((name) => /^[A-Z]+$/.test(name))
        .sort(),
    ).toEqual(["GET", "POST"]);
  });

  it("no allowlisted endpoint checks a password for a signed-in user", async () => {
    const email = await account();
    const cookie = await sessionCookie(email);
    // delete-user is the only allowlisted endpoint with a password field; it is
    // disabled, so it answers 404 before looking at the password.
    for (const password of ["wrong guess", PASSWORD]) {
      const response = await serve("POST", "/delete-user", cookie, JSON.stringify({ password }));
      expect(response.status).toBe(404);
    }
    expect(await system.user.count()).toBe(1);
  });
});

// ── static: every Better Auth call site in src ──────────────────────────────

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("Better Auth call sites", () => {
  it("are exactly the checked entry points plus sign-out, the session reads and the checkpoint", () => {
    const sites: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bauth\.api\.(\w+)\s*\(|\bauth\.handler\s*\(/g)) {
        sites.push(`${file.slice(process.cwd().length + 1)} ${match[1] ?? "handler"}`);
      }
    }
    expect(sites.sort()).toEqual(
      [
        // Limited — proven above (each passes the checkpoint before this call).
        "src/server/auth/credentials.ts signUpEmail",
        "src/server/auth/credentials.ts signInEmail",
        "src/server/auth/account-security.ts sendVerificationEmail",
        "src/server/auth/account-security.ts verifyEmail",
        "src/server/auth/account-security.ts requestPasswordReset",
        "src/server/auth/account-security.ts resetPassword",
        "src/server/auth/account-security.ts changePassword",
        // Not limited by design: ends the caller's own session.
        "src/server/auth/credentials.ts signOut",
        // Read-only session lookups.
        "src/server/auth/session.ts getSession",
        "src/server/auth/session-refresh.ts handler",
        // The checkpoint itself.
        "src/server/auth/rate-limit.ts handler",
      ].sort(),
    );
  });

  it("server actions reach Better Auth only through the checked functions", () => {
    const actions = readFileSync(join(process.cwd(), "src/server/auth/auth-actions.ts"), "utf8");
    expect(actions).not.toMatch(/\.api\./);
    expect(actions).toMatch(/limit: getRateLimiter\(\)/);
    const members = readFileSync(
      join(process.cwd(), "src/server/workspaces/member-actions.ts"),
      "utf8",
    );
    const invite = members.indexOf('bucket: "invitation-create"');
    const accept = members.indexOf('bucket: "invitation-accept"');
    expect(invite).toBeGreaterThan(-1);
    expect(accept).toBeGreaterThan(-1);
    expect(invite).toBeLessThan(members.indexOf("createInvitation(getDb()"));
    expect(accept).toBeLessThan(members.indexOf("acceptInvitationForCurrentUser(token)"));
  });
});

describe("/verify-password", () => {
  it("has no production caller in src (only the disabled-path entry names it)", () => {
    const mentions: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      if (/verify-?password/i.test(source)) mentions.push(file.slice(process.cwd().length + 1));
    }
    expect(mentions).toEqual(["src/server/auth/auth-config.ts"]);
    const config = readFileSync(join(process.cwd(), "src/server/auth/auth-config.ts"), "utf8");
    expect(config).not.toMatch(/\bverifyPassword\b/);
  });
});

describe("allowlisted endpoints with a valid session", () => {
  it("cannot change email or privileges, send mail, create sessions or consume tokens", async () => {
    const email = await account();
    const cookie = await sessionCookie(email);
    const before = await authState();
    const headers = (extra: Record<string, string> = {}) => ({
      origin: BASE,
      "content-type": "application/json",
      cookie,
      ...extra,
    });
    const post = (path: string, body: unknown) =>
      route.POST(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
        }),
      );
    const get = (path: string) =>
      route.GET(new Request(`${BASE}/api/auth${path}`, { headers: headers() }));

    const attempts: [string, Promise<Response>][] = [
      ["update-user email", post("/update-user", { email: "attacker@example.com" })],
      ["update-user admin", post("/update-user", { isPlatformAdmin: true, emailVerified: true })],
      ["update-user locale", post("/update-user", { locale: "xx" })],
      ["change-email", post("/change-email", { newEmail: "attacker@example.com" })],
      ["delete-user", post("/delete-user", { password: PASSWORD })],
      ["delete-user callback", get("/delete-user/callback?token=abc")],
      ["update-session", post("/update-session", { userId: "x", expiresAt: "2999-01-01" })],
      ["sign-in social", post("/sign-in/social", { provider: "google" })],
      ["link-social", post("/link-social", { provider: "google" })],
      ["oauth callback", get("/callback/google?code=x&state=y")],
      ["refresh-token", post("/refresh-token", { providerId: "google" })],
      ["get-access-token", post("/get-access-token", { providerId: "google" })],
    ];
    for (const [name, attempt] of attempts) {
      const response = await attempt;
      expect(response.status, name).not.toBe(500);
      if (name !== "update-user locale" && name !== "update-session") {
        expect(response.ok, name).toBe(false);
      }
    }
    const after = JSON.parse(await authState()) as { users: { updatedAt: string }[] };
    const was = JSON.parse(before) as typeof after;
    // update-user with no settable field may only touch updatedAt.
    for (const state of [after, was]) for (const user of state.users) user.updatedAt = "";
    expect(after).toEqual(was);
  });
});
