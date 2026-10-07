// Phase 2, step 5: the sign-up / sign-in / sign-out form actions on the real database
// with the real Better Auth instance. `next/headers` is replaced by a request double:
// its headers carry the "browser" cookie, and cookies().set() records what Better
// Auth's nextCookies() plugin writes, which then becomes the browser cookie.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitSignIn, submitSignOut, submitSignUp } from "@/app/[locale]/(auth)/actions";
import SignInPage from "@/app/[locale]/(auth)/sign-in/page";
import SignUpPage from "@/app/[locale]/(auth)/sign-up/page";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { getCurrentUser, requirePageUser } from "@/server/auth/session";
import { getSystemDb } from "@/server/db/client";
import { requireWorkspaceAccess } from "@/server/tenancy/access";

import { createTestDb, resetDatabase } from "./helpers";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["auth", "ui", "test", "only", "secret", "0123456789abcdef"].join("-");
  const jar = new Map<string, string>();
  const writes: { name: string; value: string; options: Record<string, unknown> }[] = [];

  function requestHeaders(): Headers {
    const cookie = [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
    return new Headers({
      origin: "http://localhost:3000",
      "next-action": "test-action",
      ...(cookie.length === 0 ? {} : { cookie: cookie.join("; ") }),
    });
  }

  const nextHeaders = () => ({
    headers: () => Promise.resolve(requestHeaders()),
    cookies: () =>
      Promise.resolve({
        set: (name: string, value: string, options: Record<string, unknown>) => {
          writes.push({ name, value, options });
          if (options.maxAge === 0 || value === "") jar.delete(name);
          else jar.set(name, value);
        },
      }),
  });
  return { jar, writes, requestHeaders, nextHeaders };
});
const { requestHeaders } = browser;
vi.mock("next/headers", () => browser.nextHeaders());
vi.mock("next/headers.js", () => browser.nextHeaders());

const { system } = createTestDb();
const COOKIE = "flexibx.session_token";
const PASSWORD = "correct horse battery";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
  browser.writes.length = 0;
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** Runs a form action that must redirect; returns the redirect target. */
async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    (value) => {
      throw new Error(`expected a redirect, got ${JSON.stringify(value)}`);
    },
    (caught: unknown) => caught,
  );
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) throw error;
  return digest.split(";")[2] ?? "";
}

let counter = 0;
const freshEmail = () => {
  counter += 1;
  return `ui-${String(counter)}-${Date.now().toString(36)}@example.com`;
};

async function registered(email = freshEmail()) {
  await redirectOf(submitSignUp("en", null, form({ name: "Reem", email, password: PASSWORD })));
  return email;
}

async function signedIn(email?: string) {
  const address = await registered(email);
  await redirectOf(submitSignIn("en", null, form({ email: address, password: PASSWORD })));
  expect(browser.jar.has(COOKIE)).toBe(true);
  browser.writes.length = 0;
  return address;
}

const sessionCount = () => system.session.count();

// ── sign-up ──────────────────────────────────────────────────────────────────

describe("sign-up", () => {
  it("creates an unverified account, does not sign it in and sends the user to sign-in", async () => {
    const email = freshEmail();
    const target = await redirectOf(
      submitSignUp(
        "ar",
        null,
        form({ name: "ريم", email: ` ${email.toUpperCase()} `, password: PASSWORD }),
      ),
    );
    expect(target).toBe("/ar/sign-in?registered=1");

    const user = await system.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ name: "ريم", emailVerified: false, isPlatformAdmin: false });
    expect(await sessionCount()).toBe(0);
    expect(browser.writes).toEqual([]);
  });

  it("answers an already-registered email exactly like a new one and keeps the original password", async () => {
    const email = await registered();
    browser.writes.length = 0;

    const again = await redirectOf(
      submitSignUp("ar", null, form({ name: "Intruder", email, password: "another password 123" })),
    );
    expect(again).toBe("/ar/sign-in?registered=1");
    expect(await system.user.count()).toBe(1);
    expect(await sessionCount()).toBe(0);
    expect(browser.writes).toEqual([]);

    // The original credentials still work; the attacker's password does not.
    expect(
      await submitSignIn("en", null, form({ email, password: "another password 123" })),
    ).toMatchObject({ messageKey: "auth.errors.invalidCredentials" });
    await redirectOf(submitSignIn("en", null, form({ email, password: PASSWORD })));
  });

  it("rejects invalid input per field, creates nothing and never echoes the password", async () => {
    const secret = "short";
    const state = await submitSignUp(
      "en",
      null,
      form({ name: "", email: "not-an-email", password: secret }),
    );
    expect(state?.messageKey).toBe("auth.errors.invalidInput");
    expect(state?.fields?.map((field) => field.path).sort()).toEqual(["email", "name", "password"]);
    expect(state?.values).toEqual({ name: "", email: "not-an-email" });
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(await system.user.count()).toBe(0);
  });

  it("ignores client-supplied privileged fields", async () => {
    const email = freshEmail();
    await redirectOf(
      submitSignUp(
        "en",
        null,
        form({
          name: "Reem",
          email,
          password: PASSWORD,
          emailVerified: "true",
          isPlatformAdmin: "true",
          locale: "en",
          id: "00000000-0000-0000-0000-000000000000",
        }),
      ),
    );
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ emailVerified: false, isPlatformAdmin: false, locale: "ar" });
    expect(user.id).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("carries a safe next path to sign-in and drops an unsafe one", async () => {
    const withNext = await redirectOf(
      submitSignUp(
        "en",
        null,
        form({ name: "A", email: freshEmail(), password: PASSWORD, next: "/en/workspaces/new" }),
      ),
    );
    expect(withNext).toBe("/en/sign-in?registered=1&next=%2Fen%2Fworkspaces%2Fnew");

    const evil = await redirectOf(
      submitSignUp(
        "en",
        null,
        form({ name: "B", email: freshEmail(), password: PASSWORD, next: "https://evil.example" }),
      ),
    );
    expect(evil).toBe("/en/sign-in?registered=1");
  });
});

// ── sign-in ──────────────────────────────────────────────────────────────────

describe("sign-in", () => {
  it("creates a database session and sets the HttpOnly, SameSite=Lax session cookie", async () => {
    const email = await registered();
    const target = await redirectOf(submitSignIn("en", null, form({ email, password: PASSWORD })));
    expect(target).toBe("/en/workspaces");

    expect(await sessionCount()).toBe(1);
    const written = browser.writes.find((cookie) => cookie.name === COOKIE);
    expect(written?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 604800,
    });
    expect((await getCurrentUser())?.email).toBe(email);
  });

  it("gives one generic answer for a wrong password, an unknown email and malformed input", async () => {
    const email = await registered();
    browser.writes.length = 0;

    const attempts = [
      { email, password: "wrong password 123" },
      { email: freshEmail(), password: PASSWORD },
      { email: "not-an-email", password: PASSWORD },
      { email: "", password: "" },
    ];
    const states = [];
    for (const attempt of attempts) {
      const state = await submitSignIn("en", null, form(attempt));
      expect(JSON.stringify(state)).not.toContain(attempt.password || "<none>");
      states.push({ messageKey: state?.messageKey, fields: state?.fields });
    }
    for (const state of states) {
      expect(state).toEqual({ messageKey: "auth.errors.invalidCredentials", fields: undefined });
    }
    expect(browser.writes).toEqual([]);
    expect(await sessionCount()).toBe(0);
  });

  it.each([
    ["/en/w/acme?tab=1", "/en/w/acme?tab=1"],
    ["/ar/workspaces/new", "/ar/workspaces/new"],
    ["https://evil.example/en", "/en/workspaces"],
    ["//evil.example", "/en/workspaces"],
    ["/\\evil.example", "/en/workspaces"],
    ["javascript:alert(1)", "/en/workspaces"],
    ["/api/auth/sign-out", "/en/workspaces"],
    ["", "/en/workspaces"],
  ])("after sign-in, next=%j leads to %s", async (next, expected) => {
    const email = await registered();
    expect(
      await redirectOf(submitSignIn("en", null, form({ email, password: PASSWORD, next }))),
    ).toBe(expected);
  });
});

// ── sign-out ─────────────────────────────────────────────────────────────────

describe("sign-out", () => {
  it("deletes the session, clears the cookie and closes protected access", async () => {
    const email = await signedIn();
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    const workspace = await system.workspace.create({ data: { name: "Acme", slug: "acme-team" } });
    await system.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
    });
    const staleCookie = requestHeaders().get("cookie") ?? "";
    expect((await requireWorkspaceAccess("acme-team")).workspaceId).toBe(workspace.id);

    expect(await redirectOf(submitSignOut("ar"))).toBe("/ar/sign-in");

    expect(await sessionCount()).toBe(0);
    const cleared = browser.writes.find((cookie) => cookie.name === COOKIE);
    expect(cleared?.options.maxAge).toBe(0);
    expect(browser.jar.has(COOKIE)).toBe(false);
    expect(await getCurrentUser()).toBeNull();
    await expect(requireWorkspaceAccess("acme-team")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    // Replaying the old cookie does not bring the session back.
    browser.jar.set(COOKIE, decodeURIComponent(staleCookie.split("=").slice(1).join("=")));
    expect(await getCurrentUser()).toBeNull();
  });

  it("only ends the current session", async () => {
    const email = await signedIn();
    const first = new Map(browser.jar);
    browser.jar.clear();
    await redirectOf(submitSignIn("en", null, form({ email, password: PASSWORD })));
    expect(await sessionCount()).toBe(2);

    await redirectOf(submitSignOut("en"));
    expect(await sessionCount()).toBe(1);
    for (const [name, value] of first) browser.jar.set(name, value);
    expect((await getCurrentUser())?.email).toBe(email);
  });

  it("is harmless without a session", async () => {
    expect(await redirectOf(submitSignOut("en"))).toBe("/en/sign-in");
    expect(await sessionCount()).toBe(0);
  });
});

// ── page guards ──────────────────────────────────────────────────────────────

describe("page guards", () => {
  it("protected pages send anonymous visitors to sign-in with a return path", async () => {
    await expect(redirectOf(requirePageUser("ar", "/ar/workspaces"))).resolves.toBe(
      "/ar/sign-in?next=%2Far%2Fworkspaces",
    );
    await expect(redirectOf(requirePageUser("en", "https://evil.example"))).resolves.toBe(
      "/en/sign-in",
    );
  });

  it("protected pages return the signed-in user", async () => {
    const email = await signedIn();
    expect((await requirePageUser("en", "/en/workspaces")).email).toBe(email);
  });

  it("signed-in users visiting sign-in or sign-up are sent on (safely)", async () => {
    await signedIn();
    const params = Promise.resolve({ locale: "en" });
    await expect(
      redirectOf(SignInPage({ params, searchParams: Promise.resolve({ next: "/en/w/acme" }) })),
    ).resolves.toBe("/en/w/acme");
    await expect(
      redirectOf(
        SignUpPage({ params, searchParams: Promise.resolve({ next: "https://evil.example" }) }),
      ),
    ).resolves.toBe("/en/workspaces");
  });
});
