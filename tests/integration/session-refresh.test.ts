// Rolling sessions end to end: the database expiry and the browser cookie must roll
// together. Server Components cannot write cookies, so (1) the proxy renews the cookie
// on page requests, and (2) Better Auth's nextCookies() plugin skips the refresh inside
// an RSC render and writes cookies in server actions / route handlers.
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInWithEmail, signUpWithEmail } from "@/server/auth/credentials";
import { hasSessionCookie, refreshSessionCookies } from "@/server/auth/session-refresh";
import { getSystemDb } from "@/server/db/client";

import { createTestAuth, depsFor, type TestAuth } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";

// What `next/headers` would expose to Better Auth's nextCookies() plugin for the current
// "request", plus a jar that records cookies() writes.
const next = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["session", "refresh", "test", "only", "0123456789abcdef"].join("-");
  return {
    headers: null as Headers | null,
    written: [] as { name: string; value: string; options: Record<string, unknown> }[],
  };
});
vi.mock("next/headers.js", () => ({
  headers: () => {
    if (next.headers === null) throw new Error("`headers` was called outside a request scope.");
    return Promise.resolve(next.headers);
  },
  cookies: () => {
    if (next.headers === null) throw new Error("`cookies` was called outside a request scope.");
    return Promise.resolve({
      set: (name: string, value: string, options: Record<string, unknown>) =>
        next.written.push({ name, value, options }),
    });
  },
}));

const { system } = createTestDb();
const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const COOKIE = "flexibx.session_token";
const DAY = 86_400_000;
const harness = createTestAuth(system, process.env.AUTH_SECRET ?? "");
const { auth } = harness;

beforeEach(async () => {
  await resetDatabase(system);
  next.headers = null;
  next.written.length = 0;
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

let counter = 0;
async function signedIn(test: TestAuth = harness) {
  const instance = test.auth;
  counter += 1;
  const email = `roll-${String(counter)}@example.com`;
  await signUpWithEmail(instance, { email, password: PASSWORD, name: "R" }, depsFor(test), "en");
  const result = await signInWithEmail(instance, { email, password: PASSWORD }, depsFor(test));
  if (result.status !== "SIGNED_IN") throw new Error("sign-in failed");
  const setCookie = result.setCookie.find((c) => c.includes(".session_token=")) ?? "";
  const pair = setCookie.split(";")[0] ?? "";
  const token = decodeURIComponent(pair.split("=")[1] ?? "").split(".")[0] ?? "";
  return { cookieHeader: pair, value: pair.slice(pair.indexOf("=") + 1), token };
}

/** Pretend the session was last refreshed `daysAgo` days ago (7-day sessions). */
async function age(token: string, daysAgo: number) {
  await system.session.update({
    where: { token },
    data: { expiresAt: new Date(Date.now() + (7 - daysAgo) * DAY) },
  });
}
const expiresAt = async (token: string) =>
  (await system.session.findUniqueOrThrow({ where: { token } })).expiresAt.getTime();
const attribute = (setCookie: string, name: string) =>
  new RegExp(`;\\s*${name}(=([^;]*))?`, "i").exec(setCookie)?.[2];

describe("proxy-side refresh (page requests)", () => {
  it("does nothing without a session cookie", async () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie("NEXT_LOCALE=ar; other=1")).toBe(false);
    expect(hasSessionCookie(`NEXT_LOCALE=ar; ${COOKIE}=x.y`)).toBe(true);
    expect(await refreshSessionCookies(auth, "NEXT_LOCALE=ar", BASE)).toEqual([]);
  });

  it("does not rewrite the cookie for a session refreshed less than a day ago", async () => {
    const user = await signedIn();
    const before = await expiresAt(user.token);
    expect(await refreshSessionCookies(auth, user.cookieHeader, BASE)).toEqual([]);
    expect(await expiresAt(user.token)).toBe(before);
  });

  it("renews the browser cookie together with the database expiry once the session rolls", async () => {
    const user = await signedIn();
    await age(user.token, 2);

    const cookies = await refreshSessionCookies(auth, user.cookieHeader, BASE);
    expect(cookies).toHaveLength(1);
    const [renewed = ""] = cookies;
    expect(renewed.startsWith(`${COOKIE}=${user.value};`)).toBe(true); // same signed token
    expect(attribute(renewed, "Max-Age")).toBe("604800"); // a fresh 7 days
    expect(renewed).toMatch(/;\s*HttpOnly/i);
    expect(renewed).toMatch(/;\s*SameSite=Lax/i);
    expect(attribute(renewed, "Path")).toBe("/");
    expect(await expiresAt(user.token)).toBeGreaterThan(Date.now() + 6.9 * DAY);
  });

  it("clears the cookie of an expired or revoked session", async () => {
    const expired = await signedIn();
    await system.session.update({
      where: { token: expired.token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const revoked = await signedIn();
    await system.session.delete({ where: { token: revoked.token } });

    for (const user of [expired, revoked]) {
      const cookies = await refreshSessionCookies(auth, user.cookieHeader, BASE);
      for (const cookie of cookies) expect(attribute(cookie, "Max-Age")).toBe("0");
      expect(
        await auth.api.getSession({ headers: new Headers({ cookie: user.cookieHeader }) }),
      ).toBeNull();
    }
  });

  it("keeps Secure and the __Secure- prefix on https", async () => {
    const secureHarness = createTestAuth(system, process.env.AUTH_SECRET ?? "", {
      baseURL: "https://app.flexibx.test",
      isProduction: true,
    });
    const secureAuth = secureHarness.auth;
    const user = await signedIn(secureHarness);
    expect(user.cookieHeader.startsWith("__Secure-flexibx.session_token=")).toBe(true);
    await age(user.token, 3);
    const [renewed = ""] = await refreshSessionCookies(
      secureAuth,
      user.cookieHeader,
      "https://app.flexibx.test",
    );
    expect(renewed.startsWith("__Secure-flexibx.session_token=")).toBe(true);
    expect(renewed).toMatch(/;\s*Secure/i);
    expect(attribute(renewed, "Max-Age")).toBe("604800");
  });

  it("is applied by the real proxy to page responses, alongside the CSP", async () => {
    const { default: proxy } = await import("@/proxy");
    const user = await signedIn(); // same secret + database as the app's getAuth()
    await age(user.token, 2);

    const response = await proxy(
      new NextRequest(`${BASE}/ar`, { headers: { cookie: user.cookieHeader } }),
    );
    const renewed = response.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
    expect(renewed).toBeDefined();
    expect(attribute(renewed ?? "", "Max-Age")).toBe("604800");
    expect(response.headers.get("content-security-policy")).toContain("'nonce-");

    const anonymous = await proxy(new NextRequest(`${BASE}/ar`));
    expect(anonymous.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
  });
});

describe("nextCookies() plugin (server components, server actions)", () => {
  it("is installed as the last plugin", () => {
    expect(auth.options.plugins.at(-1)?.id).toBe("next-cookies");
  });

  it("skips the rolling refresh inside a Server Component render (no DB/cookie mismatch)", async () => {
    const user = await signedIn();
    await age(user.token, 2);
    const before = await expiresAt(user.token);

    next.headers = new Headers({ RSC: "1", cookie: user.cookieHeader });
    const session = await auth.api.getSession({ headers: next.headers });
    expect(session?.session.userId).toBeDefined();
    expect(await expiresAt(user.token)).toBe(before);
    expect(next.written).toEqual([]);
  });

  it("refreshes and writes the cookie through next/headers in a server action", async () => {
    const user = await signedIn();
    await age(user.token, 2);

    next.headers = new Headers({ "next-action": "abc123", cookie: user.cookieHeader });
    await auth.api.getSession({ headers: next.headers });
    expect(await expiresAt(user.token)).toBeGreaterThan(Date.now() + 6.9 * DAY);
    const written = next.written.find((c) => c.name === COOKIE);
    expect(written?.value).toBe(decodeURIComponent(user.value));
    expect(written?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 604800,
    });
  });
});
