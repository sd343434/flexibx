// Phase 2, Step 8: email verification, password reset, password change, session
// invalidation and authentication rate limiting — on the real database with the
// production Better Auth configuration (createAuth) and the real limiter checkpoint.
import { createHash } from "node:crypto";

import { createEmailVerificationToken } from "better-auth/api";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  changePassword,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  verifyEmailToken,
  type AccountSecurityDeps,
} from "@/server/auth/account-security";
import { signInWithEmail, signUpWithEmail, type SignInResult } from "@/server/auth/credentials";
import { resolveCurrentUser } from "@/server/auth/session";
import { ENUMERATION_SAFE_MIN_DURATION_MS } from "@/server/auth/timing";
import { type AppError, isAppError } from "@/server/errors/app-error";
import { UnconfiguredMailer } from "@/server/mail/mailer";

import { createTestAuth, TEST_IP_HEADER, type TestAuth } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";

// Outside a Next.js request, cookies() throws; nextCookies() treats that as "nothing to
// write", so Better Auth's own Set-Cookie headers are what tests look at.
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
  cookies: () => Promise.reject(new Error("`cookies` was called outside a request scope.")),
}));

const { system } = createTestDb();
const SECRET = ["account", "security", "test", "only", "0123456789abcdef"].join("-");
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";
const COOKIE = "flexibx.session_token";

/** The production Better Auth configuration (sign-in never depends on verification, C1). */
const lenient = createTestAuth(system, SECRET, { ipHeader: TEST_IP_HEADER });

beforeEach(async () => {
  await resetDatabase(system);
  for (const test of [lenient]) {
    test.mailer.clear();
    test.events.length = 0;
  }
});

afterAll(async () => {
  await system.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

let ipCounter = 0;
/** A distinct trusted client IP per call (the limiter keys per IP). */
function client(extra: Record<string, string> = {}): Headers {
  ipCounter += 1;
  return new Headers({
    [TEST_IP_HEADER]: `198.51.${String(Math.floor(ipCounter / 250) % 250)}.${String((ipCounter % 250) + 1)}`,
    ...extra,
  });
}

const deps = (test: TestAuth, headers: Headers = client()): AccountSecurityDeps => ({
  auth: test.auth,
  limit: test.limit,
  headers,
});

let counter = 0;
async function account(test: TestAuth = lenient, locale: "ar" | "en" = "en") {
  counter += 1;
  const email = `acct-${String(counter)}-${Date.now().toString(36)}@example.com`;
  await signUpWithEmail(test.auth, { name: "Reem", email, password: PASSWORD }, deps(test), locale);
  return email;
}

function signIn(test: TestAuth, email: string, password = PASSWORD, headers = client()) {
  return signInWithEmail(test.auth, { email, password }, { limit: test.limit, headers });
}

function sessionCookie(result: SignInResult): string {
  if (result.status !== "SIGNED_IN") throw new Error(`not signed in: ${result.status}`);
  const header = result.setCookie.find((cookie) => cookie.startsWith(`${COOKIE}=`)) ?? "";
  return header.split(";")[0] ?? "";
}

const sessionFor = (test: TestAuth, cookie: string) =>
  test.auth.api.getSession({ headers: new Headers({ cookie }) });

/** The link of an account email (verification or reset). */
function linkOf(mail: TestAuth["mailer"]["outbox"][number] | undefined): URL {
  const message = mail?.message;
  if (message === undefined || message.template === "workspace_invitation") {
    throw new Error("not an account email");
  }
  return new URL(message.data.url);
}

/** The token of the last captured email of `template` to `email` (URL fragment). */
function lastToken(test: TestAuth, email: string, template: string): string {
  const mail = [...test.mailer.outbox]
    .reverse()
    .find((candidate) => candidate.to === email && candidate.message.template === template);
  if (mail === undefined) throw new Error(`no ${template} email to ${email}`);
  return new URLSearchParams(linkOf(mail).hash.slice(1)).get("token") ?? "";
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected an AppError");
    },
    (caught: unknown) => caught,
  );
  if (!isAppError(error)) throw error;
  return error;
}

// ── email verification ───────────────────────────────────────────────────────

describe("email verification", () => {
  it("sign-up sends a localized fragment link; nothing token-like is stored", async () => {
    const email = await account(lenient, "ar");
    const mail = lenient.mailer.outbox.find((candidate) => candidate.to === email);
    expect(mail?.message.template).toBe("email_verification");
    expect(mail?.message.locale).toBe("ar");
    const url = linkOf(mail);
    expect(url.origin + url.pathname).toBe("http://localhost:3000/ar/verify-email");
    expect(url.search).toBe("");
    const token = lastToken(lenient, email, "email_verification");
    expect(await system.verification.count()).toBe(0);
    const audit = JSON.stringify(await system.auditLog.findMany());
    expect(audit).not.toContain(token);
  });

  it("never gates sign-in (C1): an unverified account signs in, and verifying updates the session user", async () => {
    const email = await account(lenient);
    expect((await system.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(false);
    // Failures stay the single generic answer; nothing reveals the verification state.
    expect(await signIn(lenient, email, "wrong password!!")).toEqual({
      status: "INVALID_CREDENTIALS",
    });
    expect(await signIn(lenient, "nobody@example.com")).toEqual({
      status: "INVALID_CREDENTIALS",
    });
    expect(await system.session.count()).toBe(0);

    const cookie = sessionCookie(await signIn(lenient, email));
    const headers = new Headers({ cookie });
    expect(await resolveCurrentUser(lenient.auth, headers)).toMatchObject({
      email,
      emailVerified: false,
    });

    const token = lastToken(lenient, email, "email_verification");
    expect(await verifyEmailToken(deps(lenient), { token })).toEqual({ status: "VERIFIED" });
    expect(lenient.events.map((event) => event.action)).toEqual(["user.email_verified"]);
    expect(await resolveCurrentUser(lenient.auth, headers)).toMatchObject({
      email,
      emailVerified: true,
    });
  });

  it("a token works once; replayed, expired, forged, malformed and foreign tokens fail alike", async () => {
    const email = await account(lenient);
    const token = lastToken(lenient, email, "email_verification");
    expect(await verifyEmailToken(deps(lenient), { token })).toEqual({ status: "VERIFIED" });
    const invalid = { status: "INVALID_TOKEN" };
    expect(await verifyEmailToken(deps(lenient), { token })).toEqual(invalid);

    const other = await account(lenient);
    const expired = await createEmailVerificationToken(SECRET, other, undefined, -60);
    const forged = await createEmailVerificationToken(`${SECRET}-forged`, other);
    const unknown = await createEmailVerificationToken(SECRET, "nobody@example.com");
    const emailChange = await createEmailVerificationToken(SECRET, other, "x@example.com");
    for (const bad of [expired, forged, unknown, emailChange, "a.b.c", "", "<x>", 42]) {
      expect(await verifyEmailToken(deps(lenient), { token: bad })).toEqual(invalid);
    }
    expect((await system.user.findUniqueOrThrow({ where: { email: other } })).emailVerified).toBe(
      false,
    );
    // A token only ever verifies the account it was issued for.
    const otherToken = lastToken(lenient, other, "email_verification");
    expect(await verifyEmailToken(deps(lenient), { token: otherToken })).toEqual({
      status: "VERIFIED",
    });
    expect(await system.user.count({ where: { emailVerified: true } })).toBe(2);
  });

  it("resend answers the same for unknown, verified and unverified addresses", async () => {
    const unverified = await account(lenient);
    const verified = await account(lenient);
    await verifyEmailToken(deps(lenient), {
      token: lastToken(lenient, verified, "email_verification"),
    });
    lenient.mailer.clear();
    const accepted = { status: "ACCEPTED" };
    for (const email of [unverified, verified, "nobody@example.com", unverified.toUpperCase()]) {
      expect(await resendVerificationEmail(deps(lenient), { email }, "en")).toEqual(accepted);
    }
    // Only the unverified account received links.
    expect(new Set(lenient.mailer.outbox.map((mail) => mail.to))).toEqual(new Set([unverified]));
    expect(
      (await errorOf(resendVerificationEmail(deps(lenient), { email: "nope" }, "en"))).code,
    ).toBe("VALIDATION_FAILED");
  });

  it("resend is limited per address (3 per hour) whatever the client", async () => {
    const email = await account(lenient);
    for (let i = 0; i < 3; i += 1) await resendVerificationEmail(deps(lenient), { email }, "en");
    const error = await errorOf(resendVerificationEmail(deps(lenient), { email }, "en"));
    expect(error.code).toBe("RATE_LIMITED");
    // The same answer for an address nobody uses once its limit is reached.
    for (let i = 0; i < 3; i += 1) {
      await resendVerificationEmail(deps(lenient), { email: "ghost@example.com" }, "en");
    }
    expect(
      (await errorOf(resendVerificationEmail(deps(lenient), { email: "ghost@example.com" }, "en")))
        .code,
    ).toBe("RATE_LIMITED");
  });
});

// ── password reset ───────────────────────────────────────────────────────────

describe("password reset", () => {
  it("answers the same for known and unknown emails; mails only the account", async () => {
    const email = await account(lenient);
    lenient.mailer.clear();
    const accepted = { status: "ACCEPTED" };
    expect(await requestPasswordReset(deps(lenient), { email }, "ar")).toEqual(accepted);
    expect(
      await requestPasswordReset(deps(lenient), { email: "nobody@example.com" }, "ar"),
    ).toEqual(accepted);
    expect(lenient.mailer.outbox.map((mail) => [mail.to, mail.message.locale])).toEqual([
      [email, "ar"],
    ]);
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    expect(lenient.events).toContainEqual({
      action: "user.password_reset_requested",
      userId: user.id,
    });
  });

  it("takes the same minimum time for known and unknown addresses (and on sign-up)", async () => {
    const email = await account(lenient);
    const timed = async (work: () => Promise<unknown>) => {
      const started = performance.now();
      await work();
      return performance.now() - started;
    };
    const floor = ENUMERATION_SAFE_MIN_DURATION_MS - 20;
    expect(
      await timed(() => requestPasswordReset(deps(lenient), { email }, "en")),
    ).toBeGreaterThanOrEqual(floor);
    expect(
      await timed(() => requestPasswordReset(deps(lenient), { email: "nobody@example.com" }, "en")),
    ).toBeGreaterThanOrEqual(floor);
    const signUp = (address: string) =>
      signUpWithEmail(
        lenient.auth,
        { name: "T", email: address, password: PASSWORD },
        deps(lenient),
        "en",
      );
    expect(await timed(() => signUp(email))).toBeGreaterThanOrEqual(floor);
    expect(await timed(() => signUp("brand-new@example.com"))).toBeGreaterThanOrEqual(floor);
  });

  it("stores only a hash of the reset token", async () => {
    const email = await account(lenient);
    await requestPasswordReset(deps(lenient), { email }, "en");
    const token = lastToken(lenient, email, "password_reset");
    const rows = await system.verification.findMany();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    const hashed = createHash("sha256").update(`reset-password:${token}`).digest("base64url");
    expect(rows[0]?.identifier).toBe(hashed);
  });

  it("an unconfigured mailer changes nothing visible (no enumeration through errors)", async () => {
    const quiet = createTestAuth(system, SECRET, {
      ipHeader: TEST_IP_HEADER,
      mailer: new UnconfiguredMailer(),
    });
    const email = await account(quiet);
    expect(await requestPasswordReset(deps(quiet), { email }, "en")).toEqual({
      status: "ACCEPTED",
    });
    expect(await resendVerificationEmail(deps(quiet), { email }, "en")).toEqual({
      status: "ACCEPTED",
    });
  });

  it("sets a hashed new password, ends every session and works once", async () => {
    const email = await account(lenient);
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    const first = sessionCookie(await signIn(lenient, email));
    const second = sessionCookie(await signIn(lenient, email));
    expect(await system.session.count({ where: { userId: user.id } })).toBe(2);
    const hashBefore = (await system.account.findFirstOrThrow({ where: { userId: user.id } }))
      .password;

    await requestPasswordReset(deps(lenient), { email }, "en");
    const token = lastToken(lenient, email, "password_reset");
    expect(
      await resetPasswordWithToken(deps(lenient), { token, newPassword: NEW_PASSWORD }),
    ).toEqual({ status: "RESET" });

    const stored = await system.account.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.password).not.toBe(hashBefore);
    expect(stored.password).not.toContain(NEW_PASSWORD);
    expect(stored.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // scrypt salt:hash
    expect(await system.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await sessionFor(lenient, first)).toBeNull();
    expect(await sessionFor(lenient, second)).toBeNull();
    expect(await signIn(lenient, email)).toEqual({ status: "INVALID_CREDENTIALS" });
    expect((await signIn(lenient, email, NEW_PASSWORD)).status).toBe("SIGNED_IN");
    expect(lenient.events.map((event) => event.action)).toContain("user.password_reset");

    // Replay: the token is gone.
    expect(
      await resetPasswordWithToken(deps(lenient), { token, newPassword: "yet another password" }),
    ).toEqual({ status: "INVALID_TOKEN" });
    expect((await signIn(lenient, email, NEW_PASSWORD)).status).toBe("SIGNED_IN");
  });

  it("rejects expired, unknown and malformed tokens identically, and validates the password", async () => {
    const email = await account(lenient);
    await requestPasswordReset(deps(lenient), { email }, "en");
    const token = lastToken(lenient, email, "password_reset");
    await system.verification.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const invalid = { status: "INVALID_TOKEN" };
    for (const bad of [token, "A".repeat(24), "short", "../../etc/passwd-0123456"]) {
      expect(
        await resetPasswordWithToken(deps(lenient), { token: bad, newPassword: NEW_PASSWORD }),
      ).toEqual(invalid);
    }
    expect((await signIn(lenient, email)).status).toBe("SIGNED_IN");

    await requestPasswordReset(deps(lenient), { email }, "en");
    const fresh = lastToken(lenient, email, "password_reset");
    const tooShort = await errorOf(
      resetPasswordWithToken(deps(lenient), { token: fresh, newPassword: "short" }),
    );
    expect(tooShort.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(tooShort.fields)).not.toContain('short"');
    // The token survives a validation error and still works once.
    expect(
      await resetPasswordWithToken(deps(lenient), { token: fresh, newPassword: NEW_PASSWORD }),
    ).toEqual({ status: "RESET" });
  });

  it("a reset token only ever changes its own account", async () => {
    const victim = await account(lenient);
    const attacker = await account(lenient);
    await requestPasswordReset(deps(lenient), { email: attacker }, "en");
    const token = lastToken(lenient, attacker, "password_reset");
    await resetPasswordWithToken(deps(lenient), { token, newPassword: NEW_PASSWORD });
    expect((await signIn(lenient, victim)).status).toBe("SIGNED_IN");
    expect((await signIn(lenient, attacker, NEW_PASSWORD)).status).toBe("SIGNED_IN");
  });

  it("is limited per address (3 per hour) so nobody can flood a mailbox", async () => {
    const email = await account(lenient);
    for (let i = 0; i < 3; i += 1) await requestPasswordReset(deps(lenient), { email }, "en");
    expect((await errorOf(requestPasswordReset(deps(lenient), { email }, "en"))).code).toBe(
      "RATE_LIMITED",
    );
  });
});

// ── password change ──────────────────────────────────────────────────────────

describe("password change", () => {
  it("needs the current password and ends the account's other sessions", async () => {
    const email = await account(lenient);
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    const here = sessionCookie(await signIn(lenient, email));
    const elsewhere = sessionCookie(await signIn(lenient, email));
    const signedIn = (headers = client()) => {
      headers.set("cookie", here);
      return deps(lenient, headers);
    };

    expect(
      await changePassword(signedIn(), user.id, {
        currentPassword: "wrong password!!",
        newPassword: NEW_PASSWORD,
      }),
    ).toEqual({ status: "INVALID_PASSWORD" });
    expect(
      await changePassword(signedIn(), user.id, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).toEqual({ status: "CHANGED" });

    expect(await sessionFor(lenient, elsewhere)).toBeNull();
    expect(await sessionFor(lenient, here)).toBeNull(); // replaced by a new session
    expect(await system.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await signIn(lenient, email)).toEqual({ status: "INVALID_CREDENTIALS" });
    expect((await signIn(lenient, email, NEW_PASSWORD)).status).toBe("SIGNED_IN");
  });

  it("is limited per user and refuses requests without a session", async () => {
    const email = await account(lenient);
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    expect(
      (
        await errorOf(
          changePassword(deps(lenient), user.id, {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
          }),
        )
      ).code,
    ).toBe("UNAUTHENTICATED");
    for (let i = 0; i < 4; i += 1) {
      await changePassword(deps(lenient), user.id, {
        currentPassword: "wrong",
        newPassword: NEW_PASSWORD,
      }).catch(() => undefined);
    }
    expect(
      (
        await errorOf(
          changePassword(deps(lenient), user.id, {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
          }),
        )
      ).code,
    ).toBe("RATE_LIMITED");
  });
});

// ── rate limiting ────────────────────────────────────────────────────────────

describe("authentication rate limiting", () => {
  it("Better Auth's limiter does not see direct auth.api calls — the checkpoint does", async () => {
    // The gap this step closes: 15 direct calls are never limited...
    for (let i = 0; i < 15; i += 1) {
      await lenient.auth.api
        .signInEmail({ body: { email: "nobody@example.com", password: "wrong password!" } })
        .catch(() => undefined);
    }
    expect(await system.rateLimit.count()).toBe(0);
    // ...while the Flexibx entry point counts every attempt.
    const headers = client();
    for (let i = 0; i < 10; i += 1) {
      expect(
        await signIn(lenient, `x${String(i)}@example.com`, "wrong password!", headers),
      ).toEqual({
        status: "INVALID_CREDENTIALS",
      });
    }
    expect((await errorOf(signIn(lenient, "y@example.com", "x", headers))).code).toBe(
      "RATE_LIMITED",
    );
  });

  it("sign-in: 10 per minute per client; other clients are unaffected", async () => {
    const email = await account(lenient);
    const attacker = client();
    for (let i = 0; i < 10; i += 1) {
      await signIn(lenient, `guess${String(i)}@example.com`, "wrong password!", attacker);
    }
    // Even the right password is refused from that client during the window.
    const blocked = await errorOf(signIn(lenient, email, PASSWORD, attacker));
    expect(blocked.code).toBe("RATE_LIMITED");
    expect(JSON.stringify(blocked.metadata)).not.toMatch(/198\.51|example\.com/);
    expect((await signIn(lenient, email, PASSWORD, client())).status).toBe("SIGNED_IN");
  });

  it("sign-in: 10 per 15 minutes per account across clients", async () => {
    const email = await account(lenient);
    for (let i = 0; i < 10; i += 1) await signIn(lenient, email, "wrong password!", client());
    expect((await errorOf(signIn(lenient, email, PASSWORD, client()))).code).toBe("RATE_LIMITED");
    // Same answer shape for an address with no account.
    for (let i = 0; i < 10; i += 1) {
      await signIn(lenient, "ghost@example.com", "wrong password!", client());
    }
    expect((await errorOf(signIn(lenient, "ghost@example.com", PASSWORD, client()))).code).toBe(
      "RATE_LIMITED",
    );
  });

  it("limits reset again after the window", async () => {
    const headers = client();
    for (let i = 0; i < 10; i += 1)
      await signIn(lenient, `w${String(i)}@example.com`, "x", headers);
    await expect(signIn(lenient, "w@example.com", "x", headers)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await system.rateLimit.updateMany({ data: { lastRequest: BigInt(Date.now() - 61_000) } });
    expect(await signIn(lenient, "w@example.com", "x", headers)).toEqual({
      status: "INVALID_CREDENTIALS",
    });
  });

  it("sign-up: 10 per 10 minutes per client, with a generic answer until then", async () => {
    const headers = client();
    for (let i = 0; i < 10; i += 1) {
      expect(
        await signUpWithEmail(
          lenient.auth,
          { name: "S", email: `spam${String(i)}@example.com`, password: PASSWORD },
          { limit: lenient.limit, headers },
          "en",
        ),
      ).toEqual({ status: "ACCEPTED" });
    }
    const error = await errorOf(
      signUpWithEmail(
        lenient.auth,
        { name: "S", email: "spam-more@example.com", password: PASSWORD },
        { limit: lenient.limit, headers },
        "en",
      ),
    );
    expect(error.code).toBe("RATE_LIMITED");
    expect(await system.user.count()).toBe(10);
  });

  it("reset request, reset submission and verification are limited per client", async () => {
    const reset = client();
    for (let i = 0; i < 5; i += 1) {
      await requestPasswordReset(
        deps(lenient, reset),
        { email: `r${String(i)}@example.com` },
        "en",
      );
    }
    expect(
      (await errorOf(requestPasswordReset(deps(lenient, reset), { email: "r@example.com" }, "en")))
        .code,
    ).toBe("RATE_LIMITED");

    const submit = client();
    for (let i = 0; i < 10; i += 1) {
      await resetPasswordWithToken(deps(lenient, submit), {
        token: "A".repeat(24),
        newPassword: NEW_PASSWORD,
      });
    }
    expect(
      (
        await errorOf(
          resetPasswordWithToken(deps(lenient, submit), {
            token: "A".repeat(24),
            newPassword: NEW_PASSWORD,
          }),
        )
      ).code,
    ).toBe("RATE_LIMITED");

    const verify = client();
    for (let i = 0; i < 20; i += 1)
      await verifyEmailToken(deps(lenient, verify), { token: "a.b.c" });
    expect((await errorOf(verifyEmailToken(deps(lenient, verify), { token: "a.b.c" }))).code).toBe(
      "RATE_LIMITED",
    );
  });

  it("a spoofed X-Forwarded-For never creates a fresh bucket", async () => {
    const headers = client();
    for (let i = 0; i < 10; i += 1) {
      headers.set("x-forwarded-for", `203.0.113.${String(i)}`);
      await signIn(lenient, `s${String(i)}@example.com`, "x", headers);
    }
    headers.set("x-forwarded-for", "203.0.113.99");
    expect((await errorOf(signIn(lenient, "s@example.com", "x", headers))).code).toBe(
      "RATE_LIMITED",
    );
  });

  it("without a configured IP header, client-supplied headers are ignored (one shared bucket)", async () => {
    const noTrust = createTestAuth(system, SECRET);
    for (let i = 0; i < 10; i += 1) {
      await signIn(
        noTrust,
        `n${String(i)}@example.com`,
        "x",
        client({ "x-forwarded-for": `203.0.113.${String(i)}` }),
      );
    }
    expect(
      (
        await errorOf(
          signIn(noTrust, "n@example.com", "x", client({ "x-forwarded-for": "9.9.9.9" })),
        )
      ).code,
    ).toBe("RATE_LIMITED");
  });

  it("stores no raw email or IP in subject keys", async () => {
    const email = await account(lenient);
    await signIn(lenient, email, "wrong password!", client());
    const keys = (await system.rateLimit.findMany()).map((row) => row.key).join("\n");
    expect(keys).not.toContain(email);
    expect(keys).not.toContain("example.com");
    expect(keys).toMatch(/\|\/flexibx\/rate-limit\/sign-in-account\/[0-9a-f]{32}/);
  });

  it("the public HTTP surface serves none of the email/password flows", async () => {
    for (const path of [
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/change-password",
      "/verify-password",
    ]) {
      const response = await lenient.auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: "{}",
        }),
      );
      expect(response.status, path).toBe(404);
    }
    const verify = await lenient.auth.handler(
      new Request("http://localhost:3000/api/auth/verify-email?token=a.b.c"),
    );
    expect(verify.status).toBe(404);
  });
});
