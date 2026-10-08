// Phase 2, Step 8: account security through the real entry points — form actions,
// the public auth route and Better Auth sessions — with the production policy
// (verification required for verified-only operations, trusted client-IP header) on the
// real database.
import type * as NextNavigation from "next/navigation";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  submitChangePassword,
  submitForgotPassword,
  submitResendVerification,
  submitResetPassword,
  submitSignIn,
  submitSignUp,
  submitVerifyEmail,
} from "@/app/[locale]/(auth)/actions";
import { GET, POST } from "@/app/api/auth/[...all]/route";
import { requireUser } from "@/server/auth/session";
import { getSystemDb } from "@/server/db/client";
import { getMailer } from "@/server/mail";
import type { MemoryMailer } from "@/server/mail/mailer";
import { previewInvitationForCurrentUser } from "@/server/tenancy/invitation-acceptance";
import { acceptInvitationAction, inviteMemberAction } from "@/server/workspaces/member-actions";
import { createWorkspaceAction } from "@/server/workspaces/workspace-actions";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTestDb, resetDatabase } from "./helpers";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  // Production policy in a test process: verification required, trusted IP header.
  process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = "true";
  process.env.AUTH_IP_HEADER = "x-test-client-ip";
  process.env.AUTH_SECRET = ["account", "flow", "test", "only", "secret", "0123456789abcdef"].join(
    "-",
  );
  const jar = new Map<string, string>();
  const client = { ip: "198.51.100.1" };

  function requestHeaders(): Headers {
    const cookie = [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
    return new Headers({
      origin: "http://localhost:3000",
      "next-action": "test-action",
      "x-test-client-ip": client.ip,
      ...(cookie.length === 0 ? {} : { cookie: cookie.join("; ") }),
    });
  }

  const nextHeaders = () => ({
    headers: () => Promise.resolve(requestHeaders()),
    cookies: () =>
      Promise.resolve({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name: string, value: string, options: Record<string, unknown>) => {
          if (options.maxAge === 0 || value === "") jar.delete(name);
          else jar.set(name, value);
        },
      }),
  });
  return { jar, client, requestHeaders, nextHeaders };
});
vi.mock("next/headers", () => browser.nextHeaders());
// next-intl's <Link> reads the router's pathname, which only exists inside Next.js;
// everything else in next/navigation (redirect, notFound) stays real.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/",
}));
vi.mock("next/headers.js", () => browser.nextHeaders());

const { system } = createTestDb();
const PASSWORD = "correct horse battery";
const SESSION_COOKIE = "flexibx.session_token";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
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

/** The digest of a Next control-flow error (redirect / notFound), or rethrows. */
async function controlFlow(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    (value) => {
      throw new Error(`expected a redirect or notFound, got ${typeof value}`);
    },
    (caught: unknown) => caught,
  );
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string") throw error;
  return digest;
}
const redirectTarget = async (promise: Promise<unknown>) => {
  const digest = await controlFlow(promise);
  expect(digest.startsWith("NEXT_REDIRECT")).toBe(true);
  return digest.split(";")[2];
};

const NEW = "a brand new passphrase";
let counter = 0;
const outbox = () => (getMailer() as MemoryMailer).outbox;

/** A fresh "browser": empty cookie jar and its own client IP. */
function newBrowser() {
  counter += 1;
  browser.jar.clear();
  browser.client.ip = `198.51.${String(Math.floor(counter / 200))}.${String((counter % 200) + 1)}`;
}

function linkToken(email: string, template: string): { url: URL; token: string } {
  const mail = [...outbox()]
    .reverse()
    .find((candidate) => candidate.to === email && candidate.message.template === template);
  if (mail === undefined || mail.message.template === "workspace_invitation") {
    throw new Error(`no ${template} email to ${email}`);
  }
  const url = new URL(mail.message.data.url);
  return { url, token: new URLSearchParams(url.hash.slice(1)).get("token") ?? "" };
}

async function signUp(locale: "ar" | "en", email: string) {
  return redirectTarget(
    submitSignUp(locale, null, form({ name: "Reem", email, password: PASSWORD })),
  );
}

beforeEach(() => {
  (getMailer() as MemoryMailer).clear();
  newBrowser();
});

describe("verification policy in production (C1 / C6)", () => {
  it("Arabic: an unverified account signs in and creates a workspace (C1); the link verifies once", async () => {
    const email = `ar-${Date.now().toString(36)}@example.com`;
    expect(await signUp("ar", email)).toBe("/ar/sign-in?registered=1");

    expect(
      await redirectTarget(submitSignIn("ar", null, form({ email, password: PASSWORD }))),
    ).toBe("/ar/workspaces");
    expect(browser.jar.has(SESSION_COOKIE)).toBe(true);
    expect(await requireUser()).toMatchObject({ email, emailVerified: false });

    const slug = `ar-${String(counter)}-${Date.now().toString(36)}`;
    expect(
      await createWorkspaceAction({ name: "مساحة العمل", slug, defaultLocale: "ar" }),
    ).toMatchObject({ ok: true, data: { slug } });

    const { url, token } = linkToken(email, "email_verification");
    expect(url.pathname).toBe("/ar/verify-email");
    expect(await submitVerifyEmail(null, form({ token }))).toEqual({ status: "verified" });
    // The link is single use.
    expect(await submitVerifyEmail(null, form({ token }))).toEqual({ status: "invalid" });
    expect(await requireUser()).toMatchObject({ email, emailVerified: true });
    expect(ar.invite.unverified).toMatch(/[\u0600-\u06FF]/);
  });

  it("accepting an invitation is verified-only: unverified sees nothing and cannot accept; verified can", async () => {
    const owner = `owner-${String(counter)}-${Date.now().toString(36)}@example.com`;
    await signUp("en", owner);
    await redirectTarget(submitSignIn("en", null, form({ email: owner, password: PASSWORD })));
    const slug = `inv-${String(counter)}-${Date.now().toString(36)}`;
    await createWorkspaceAction({ name: "Team", slug, defaultLocale: "en" });
    const invitee = `invitee-${String(counter)}-${Date.now().toString(36)}@example.com`;
    const invited = await inviteMemberAction({
      slug,
      email: invitee,
      role: "EDITOR",
      locale: "en",
    });
    if (!invited.ok) throw new Error(`invite failed: ${invited.error.code}`);
    const token = new URL(invited.data.acceptUrl).pathname.split("/").at(-1) ?? "";

    newBrowser();
    await signUp("en", invitee);
    await redirectTarget(submitSignIn("en", null, form({ email: invitee, password: PASSWORD })));
    expect(await requireUser()).toMatchObject({ email: invitee, emailVerified: false });

    // Nothing about the invitation is revealed, and a real and an unknown token are refused
    // identically, before any lookup.
    expect(await previewInvitationForCurrentUser(token)).toEqual({ status: "email_unverified" });
    const refused = {
      ok: false,
      error: { code: "FORBIDDEN", fields: [{ path: "email", code: "email_not_verified" }] },
    };
    expect(await acceptInvitationAction({ token })).toMatchObject(refused);
    expect(await acceptInvitationAction({ token: "y".repeat(43) })).toMatchObject(refused);
    expect(await system.workspaceMember.count({ where: { user: { email: invitee } } })).toBe(0);
    expect(
      await system.workspaceInvitation.count({ where: { email: invitee, acceptedAt: null } }),
    ).toBe(1);

    await submitVerifyEmail(null, form({ token: linkToken(invitee, "email_verification").token }));
    expect(await previewInvitationForCurrentUser(token)).toMatchObject({ status: "valid" });
    expect(await acceptInvitationAction({ token })).toMatchObject({ ok: true, data: { slug } });
    expect(await system.workspaceMember.count({ where: { user: { email: invitee } } })).toBe(1);
  });

  it("resend and forgot-password answer the same for every address", async () => {
    const email = `same-${Date.now().toString(36)}@example.com`;
    await signUp("en", email);
    (getMailer() as MemoryMailer).clear();
    for (const address of [email, "nobody@example.com"]) {
      expect(await submitResendVerification("en", null, form({ email: address }))).toEqual({
        status: "sent",
      });
      expect(await submitForgotPassword("en", null, form({ email: address }))).toEqual({
        status: "sent",
      });
    }
    expect(new Set(outbox().map((mail) => mail.to))).toEqual(new Set([email]));
  });
});

describe("password reset and change through the forms", () => {
  async function verifiedAccount(locale: "ar" | "en") {
    const email = `pw-${String(counter)}-${Date.now().toString(36)}@example.com`;
    await signUp(locale, email);
    await submitVerifyEmail(null, form({ token: linkToken(email, "email_verification").token }));
    return email;
  }

  it("English: forgot → reset → old password fails, new one works", async () => {
    const email = await verifiedAccount("en");
    expect(await submitForgotPassword("en", null, form({ email }))).toEqual({ status: "sent" });
    const { url, token } = linkToken(email, "password_reset");
    expect(url.pathname).toBe("/en/reset-password");
    expect(
      await redirectTarget(submitResetPassword("en", null, form({ token, newPassword: NEW }))),
    ).toBe("/en/sign-in?reset=1");
    expect(await submitResetPassword("en", null, form({ token, newPassword: NEW }))).toEqual({
      status: "invalid",
    });
    expect((await submitSignIn("en", null, form({ email, password: PASSWORD })))?.messageKey).toBe(
      "auth.errors.invalidCredentials",
    );
    expect(await redirectTarget(submitSignIn("en", null, form({ email, password: NEW })))).toBe(
      "/en/workspaces",
    );
  });

  it("reset signs out every browser; stale cookies do not come back", async () => {
    const email = await verifiedAccount("en");
    await redirectTarget(submitSignIn("en", null, form({ email, password: PASSWORD })));
    const stale = new Map(browser.jar);
    newBrowser();
    await submitForgotPassword("en", null, form({ email }));
    await redirectTarget(
      submitResetPassword(
        "en",
        null,
        form({ token: linkToken(email, "password_reset").token, newPassword: NEW }),
      ),
    );
    browser.jar.clear();
    for (const [name, value] of stale) browser.jar.set(name, value);
    await expect(requireUser()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("change password keeps this browser signed in and signs out the others", async () => {
    const email = await verifiedAccount("ar");
    await redirectTarget(submitSignIn("ar", null, form({ email, password: PASSWORD })));
    const other = new Map(browser.jar);
    newBrowser();
    await redirectTarget(submitSignIn("ar", null, form({ email, password: PASSWORD })));

    expect(
      await submitChangePassword(
        "ar",
        null,
        form({ currentPassword: "wrong password!", newPassword: NEW }),
      ),
    ).toEqual({ messageKey: "auth.errors.wrongPassword" });
    expect(
      await redirectTarget(
        submitChangePassword("ar", null, form({ currentPassword: PASSWORD, newPassword: NEW })),
      ),
    ).toBe("/ar/account/security?changed=1");
    expect((await requireUser()).email).toBe(email); // the rewritten cookie works
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    expect(
      await system.auditLog.count({
        where: { action: "user.password_changed", actorUserId: user.id },
      }),
    ).toBe(1);

    browser.jar.clear();
    for (const [name, value] of other) browser.jar.set(name, value);
    await expect(requireUser()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("rate limiting through the forms", () => {
  it("repeated sign-in failures from one client get the generic limit message", async () => {
    for (let i = 0; i < 10; i += 1) {
      const state = await submitSignIn(
        "en",
        null,
        form({ email: `g${String(i)}@example.com`, password: "wrong password!" }),
      );
      expect(state?.messageKey).toBe("auth.errors.invalidCredentials");
    }
    const limited = await submitSignIn(
      "en",
      null,
      form({ email: "g@example.com", password: "wrong password!" }),
    );
    expect(limited?.messageKey).toBe("auth.errors.rateLimited");
    expect(en.auth.errors.rateLimited).not.toMatch(/account|exist|email/i);
    // Another client is not affected.
    newBrowser();
    expect(
      (await submitSignIn("en", null, form({ email: "g@example.com", password: "x" })))?.messageKey,
    ).toBe("auth.errors.invalidCredentials");
  });

  it("invitation acceptance is limited per client", async () => {
    const token = "x".repeat(43);
    for (let i = 0; i < 20; i += 1) {
      expect((await acceptInvitationAction({ token })).ok).toBe(false);
    }
    expect(await acceptInvitationAction({ token })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
  });
});

describe("public auth route", () => {
  it("refuses the internal checkpoint and the reset callback, serves the session endpoint", async () => {
    const at = (path: string, method = "GET") =>
      new Request(`http://localhost:3000/api/auth${path}`, {
        method,
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    expect((await POST(at("/flexibx/rate-limit/sign-in", "POST"))).status).toBe(404);
    expect((await POST(at("/flexibx/rate-limit/sign-in-account/abc", "POST"))).status).toBe(404);
    expect((await GET(at("/reset-password/AAAAAAAAAAAAAAAAAAAAAAAA?callbackURL=/en"))).status).toBe(
      404,
    );
    expect((await POST(at("/request-password-reset", "POST"))).status).toBe(404);
    expect((await GET(at("/get-session"))).status).toBe(200);
  });
});
