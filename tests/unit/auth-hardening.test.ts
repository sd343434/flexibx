import { getIP } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  RESET_TOKEN_PATTERN,
  unverifiedTokenEmail,
  VERIFICATION_TOKEN_PATTERN,
} from "@/server/auth/account-security";
import {
  accountLink,
  createAuth,
  DISABLED_HTTP_PATHS,
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  isInternalOnlyAuthPath,
  localeFromAuthUrl,
  PASSWORD_RESET_EXPIRES_IN_SECONDS,
  type Auth,
} from "@/server/auth/auth-config";
import { createRateLimiter } from "@/server/auth/rate-limit";
import { ENUMERATION_SAFE_MIN_DURATION_MS, withMinimumDuration } from "@/server/auth/timing";
import {
  betterAuthCustomRules,
  checkpointPath,
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_RULES,
  subjectKey,
} from "@/server/auth/rate-limit-policy";
import { postSignInPath, safeNextPath, signInPath } from "@/server/auth/safe-redirect";
import { isAppError } from "@/server/errors/app-error";
import { hasRequiredEmailVerification, requireVerifiedEmail } from "@/server/auth/verified-email";
import { resolveEmailVerificationRequired } from "@/server/env-schema";
import { MemoryMailer, UnconfiguredMailer, type Mailer } from "@/server/mail/mailer";
import { renderMail } from "@/server/mail/templates";

// Phase 2, Step 8: the pure parts of account security and authentication hardening.

const SECRET = "s".repeat(40);
const APP = "https://app.flexibx.test";

function build(overrides: Partial<Parameters<typeof createAuth>[0]> = {}) {
  return createAuth({
    db: {} as PrismaClient, // never queried here
    secret: SECRET,
    baseURL: APP,
    appUrl: APP,
    isProduction: true,
    mailer: new MemoryMailer(),
    onSecurityEvent: () => Promise.resolve(),
    log: () => undefined,
    ...overrides,
  });
}

describe("auth hardening configuration", () => {
  const { options } = build();

  it("enables Better Auth's limiter with database storage and the Flexibx rules", () => {
    expect(options.rateLimit.enabled).toBe(true);
    expect(options.rateLimit.storage).toBe("database");
    expect(options.rateLimit.customRules).toEqual(betterAuthCustomRules());
  });

  it("stores verification identifiers (reset tokens) hashed only", () => {
    expect(options.verification.storeIdentifier).toBe("hashed");
  });

  it("never gates sign-in on email verification (C1), even in production, and never signs in automatically", () => {
    expect(options.emailAndPassword.requireEmailVerification).toBe(false);
    expect(build({ isProduction: false }).options.emailAndPassword.requireEmailVerification).toBe(
      false,
    );
    expect(options.emailAndPassword.autoSignIn).toBe(false);
    expect(options.emailVerification.autoSignInAfterVerification).toBe(false);
    expect(options.emailVerification.sendOnSignUp).toBe(true);
    expect(options.emailVerification.sendOnSignIn).toBe(false);
  });

  it("uses short-lived tokens and revokes every session on reset", () => {
    expect(options.emailVerification.expiresIn).toBe(EMAIL_VERIFICATION_EXPIRES_IN_SECONDS);
    expect(EMAIL_VERIFICATION_EXPIRES_IN_SECONDS).toBe(3600);
    expect(options.emailAndPassword.resetPasswordTokenExpiresIn).toBe(
      PASSWORD_RESET_EXPIRES_IN_SECONDS,
    );
    expect(PASSWORD_RESET_EXPIRES_IN_SECONDS).toBe(3600);
    expect(options.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("keeps every email/password flow off the HTTP surface", () => {
    expect(options.disabledPaths).toEqual([...DISABLED_HTTP_PATHS]);
    for (const path of [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/reset-password",
      "/verify-email",
      "/send-verification-email",
      "/change-password",
      "/verify-password",
    ]) {
      expect(DISABLED_HTTP_PATHS).toContain(path);
    }
  });

  it("keeps secure cookies, origin checks and no telemetry in production", () => {
    expect(options.advanced.useSecureCookies).toBe(true);
    expect(options.advanced.disableOriginCheck).toBe(false);
    expect(options.telemetry.enabled).toBe(false);
    expect(options.session.cookieCache.enabled).toBe(false);
    // The checkpoint plugin sits before nextCookies, which must stay last.
    expect(options.plugins.map((plugin) => plugin.id)).toEqual([
      "flexibx-rate-limit",
      "next-cookies",
    ]);
  });
});

describe("email callbacks", () => {
  type Callback = (data: {
    user: { id: string; email: string; name: string };
    url: string;
    token: string;
  }) => Promise<void>;
  const user = { id: "u1", email: "reem@example.com", name: "Reem" };

  it("send fragment links built from APP_URL in the requested locale", async () => {
    const mailer = new MemoryMailer();
    const { options } = build({ mailer });
    const sendReset = options.emailAndPassword.sendResetPassword as unknown as Callback;
    const sendVerify = options.emailVerification.sendVerificationEmail as unknown as Callback;
    await sendReset({
      user,
      token: "A".repeat(24),
      url: "https://evil.example/x?callbackURL=%2Far",
    });
    await sendVerify({
      user,
      token: "h.p.s",
      url: "http://localhost/verify-email?token=h.p.s&callbackURL=%2Fen",
    });
    expect(mailer.outbox.map((mail) => [mail.message.template, mail.message.locale])).toEqual([
      ["password_reset", "ar"],
      ["email_verification", "en"],
    ]);
    expect(mailer.outbox[0]?.text).toContain(`${APP}/ar/reset-password#token=${"A".repeat(24)}`);
    expect(mailer.outbox[0]?.text).not.toContain("evil.example");
    expect(mailer.outbox[1]?.text).toContain(`${APP}/en/verify-email#token=h.p.s`);
  });

  it("never throw when no email can be sent, and log no link, token or address", async () => {
    const lines: string[] = [];
    const { options } = build({
      mailer: new UnconfiguredMailer(),
      log: (_level, message) => lines.push(message),
    });
    const sendReset = options.emailAndPassword.sendResetPassword as unknown as Callback;
    await expect(
      sendReset({ user, token: "B".repeat(24), url: "https://x/?callbackURL=%2Fen" }),
    ).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("account email not sent (password_reset)");
    expect(lines.join("\n")).not.toMatch(/B{24}|reem@|reset-password#/);
  });

  it("record security events without letting audit failures break the flow", async () => {
    const lines: string[] = [];
    const events: string[] = [];
    const { options } = build({
      onSecurityEvent: (action, userId) => {
        events.push(`${action}:${userId}`);
        return Promise.reject(new Error("db down"));
      },
      log: (_level, message) => lines.push(message),
    });
    const afterVerification = options.emailVerification.afterEmailVerification as unknown as (
      u: typeof user,
    ) => Promise<void>;
    await expect(afterVerification(user)).resolves.toBeUndefined();
    expect(events).toEqual(["user.email_verified:u1"]);
    expect(lines).toEqual(["security event not recorded (user.email_verified): Error"]);
  });
});

describe("email link helpers", () => {
  it("read the locale from Better Auth's callback URL, defaulting to Arabic", () => {
    expect(localeFromAuthUrl("http://x/reset-password/T?callbackURL=%2Fen")).toBe("en");
    expect(localeFromAuthUrl("http://x/verify-email?token=t&callbackURL=%2Far%2Fw")).toBe("ar");
    expect(localeFromAuthUrl("http://x/verify-email?callbackURL=%2Ffr")).toBe("ar");
    expect(localeFromAuthUrl("not a url")).toBe("ar");
  });

  it("put the token in the fragment of an APP_URL link", () => {
    const link = new URL(accountLink(APP, "en", "reset-password", "tok/en?x"));
    expect(link.origin).toBe(APP);
    expect(link.pathname).toBe("/en/reset-password");
    expect(link.search).toBe("");
    expect(new URLSearchParams(link.hash.slice(1)).get("token")).toBe("tok/en?x");
  });

  it("render verification and reset emails in both languages with escaped values", () => {
    const base = {
      url: `${APP}/ar/verify-email#token=t`,
      expiresInMinutes: 60,
      name: "<b>Reem</b>",
    };
    const ar = renderMail({
      to: "a@b.co",
      locale: "ar",
      template: "email_verification",
      data: base,
    });
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.html).not.toContain("<b>Reem</b>");
    expect(ar.text).toContain(`${APP}/ar/verify-email#token=t`);
    const en = renderMail({ to: "a@b.co", locale: "en", template: "password_reset", data: base });
    expect(en.subject).toBe("Reset your Flexibx password");
    expect(en.text).toContain("expires in 60 minutes");
  });
});

describe("token shapes", () => {
  it("accept only Better Auth's reset and verification token formats", () => {
    expect(RESET_TOKEN_PATTERN.test("aB3".repeat(8))).toBe(true);
    for (const bad of [
      "",
      "a".repeat(23),
      "a".repeat(25),
      `${"a".repeat(23)}-`,
      "../../etc/passwd",
    ]) {
      expect(RESET_TOKEN_PATTERN.test(bad)).toBe(false);
    }
    expect(VERIFICATION_TOKEN_PATTERN.test("aaa.bbb.ccc")).toBe(true);
    for (const bad of ["aaa.bbb", "a.b.c.d", "a b.c.d", "<script>.x.y"]) {
      expect(VERIFICATION_TOKEN_PATTERN.test(bad)).toBe(false);
    }
  });

  it("read the claimed email of a verification token without trusting it", () => {
    const encode = (claims: object) => Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(unverifiedTokenEmail(`h.${encode({ email: "Reem@Example.com" })}.s`)).toBe(
      "reem@example.com",
    );
    // Email-change tokens are out of scope and never accepted.
    expect(
      unverifiedTokenEmail(`h.${encode({ email: "a@b.co", updateTo: "c@d.co" })}.s`),
    ).toBeNull();
    expect(unverifiedTokenEmail("h.not-json.s")).toBeNull();
    expect(unverifiedTokenEmail(`h.${encode({ email: 42 })}.s`)).toBeNull();
    expect(unverifiedTokenEmail("nodots")).toBeNull();
  });
});

describe("rate-limit policy", () => {
  it("defines a positive window and limit for every bucket", () => {
    expect(RATE_LIMIT_BUCKETS.length).toBeGreaterThanOrEqual(12);
    for (const bucket of RATE_LIMIT_BUCKETS) {
      const rule = RATE_LIMIT_RULES[bucket];
      expect(rule.window).toBeGreaterThan(0);
      expect(rule.max).toBeGreaterThan(0);
    }
  });

  it("covers every abuse-prone entry point", () => {
    for (const bucket of [
      "sign-in",
      "sign-in-account",
      "sign-up",
      "password-reset-request",
      "password-reset-request-account",
      "password-reset",
      "verification-resend",
      "verification-resend-account",
      "verify-email",
      "change-password",
      "invitation-accept",
      "invitation-create",
    ]) {
      expect(RATE_LIMIT_BUCKETS).toContain(bucket);
    }
  });

  it("maps every bucket to a Better Auth rule and leaves session reads unlimited", () => {
    const rules = betterAuthCustomRules();
    expect(rules["/get-session"]).toBe(false);
    expect(rules["/flexibx/rate-limit/sign-in"]).toEqual({ window: 60, max: 10 });
    expect(rules["/flexibx/rate-limit/sign-in-account/*"]).toEqual({ window: 900, max: 10 });
    expect(Object.keys(rules)).toHaveLength(RATE_LIMIT_BUCKETS.length + 1);
  });

  it("keys accounts by an HMAC, never by the raw email", () => {
    const key = subjectKey(SECRET, "sign-in-account", " Reem@Example.com ");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(subjectKey(SECRET, "sign-in-account", "reem@example.com"));
    expect(key).not.toBe(subjectKey(SECRET, "password-reset-request-account", "reem@example.com"));
    expect(key).not.toBe(subjectKey(`${SECRET}x`, "sign-in-account", "reem@example.com"));
    expect(checkpointPath("sign-in-account", key)).toBe(
      `/flexibx/rate-limit/sign-in-account/${key}`,
    );
    expect(checkpointPath("sign-in")).toBe("/flexibx/rate-limit/sign-in");
    expect(() => checkpointPath("sign-in-account")).toThrow();
    expect(() => checkpointPath("sign-in-account", "reem@example.com")).toThrow();
  });

  it("keeps the checkpoint and the reset callback off the public route", () => {
    for (const path of [
      "/api/auth/flexibx/rate-limit/sign-in",
      "/api/auth/flexibx/rate-limit",
      "/api/auth/Flexibx/Rate-Limit/sign-in",
      "/api/auth//flexibx/rate-limit/x",
      "/api/auth/flexibx%2Frate-limit/x",
      "/api/auth/reset-password/abc",
      "/api/auth/%E0%A4%A",
    ]) {
      expect(isInternalOnlyAuthPath(path), path).toBe(true);
    }
    for (const path of [
      "/api/auth/get-session",
      "/api/auth/sign-out",
      "/api/auth/reset-password",
    ]) {
      expect(isInternalOnlyAuthPath(path), path).toBe(false);
    }
  });
});

describe("limiter checkpoint requests", () => {
  function fakeAuth(status: number) {
    const handler = vi.fn((_request: Request) => Promise.resolve(new Response(null, { status })));
    return { auth: { handler } as unknown as Auth, handler };
  }
  const incoming = new Headers({
    "x-real-ip": "198.51.100.7",
    "x-forwarded-for": "6.6.6.6",
    cookie: "flexibx.session_token=secret",
  });

  it("forwards only the configured client-IP header, and none for account buckets", async () => {
    const { auth, handler } = fakeAuth(200);
    const limit = createRateLimiter(auth, { secret: SECRET, baseURL: APP, ipHeader: "x-real-ip" });
    await limit({ bucket: "sign-in", requestHeaders: incoming });
    await limit({ bucket: "sign-in-account", requestHeaders: incoming, subject: "a@b.co" });
    const [ipRequest, accountRequest] = handler.mock.calls.map(([request]) => request);
    expect(ipRequest?.url).toBe(`${APP}/api/auth/flexibx/rate-limit/sign-in`);
    expect(ipRequest?.headers.get("x-real-ip")).toBe("198.51.100.7");
    expect(ipRequest?.headers.get("origin")).toBe(APP);
    for (const request of [ipRequest, accountRequest]) {
      expect(request?.headers.get("x-forwarded-for")).toBeNull();
      expect(request?.headers.get("cookie")).toBeNull();
    }
    expect(accountRequest?.headers.get("x-real-ip")).toBeNull();
    expect(accountRequest?.url).not.toContain("a@b.co");
  });

  it("forwards no client IP at all when none is configured", async () => {
    const { auth, handler } = fakeAuth(200);
    await createRateLimiter(auth, { secret: SECRET, baseURL: APP })({
      bucket: "sign-up",
      requestHeaders: incoming,
    });
    const request = handler.mock.calls[0]?.[0];
    expect([...(request?.headers.keys() ?? [])].sort()).toEqual(["content-type", "origin"]);
  });

  it("turns 429 into a generic RATE_LIMITED and fails closed on anything else", async () => {
    const limited = createRateLimiter(fakeAuth(429).auth, { secret: SECRET, baseURL: APP });
    const error: unknown = await limited({ bucket: "sign-in", requestHeaders: incoming }).catch(
      (caught: unknown) => caught,
    );
    expect(isAppError(error) && error.code).toBe("RATE_LIMITED");
    expect(isAppError(error) && error.metadata).toEqual({ bucket: "sign-in" });
    const broken = createRateLimiter(fakeAuth(500).auth, { secret: SECRET, baseURL: APP });
    await expect(broken({ bucket: "sign-in", requestHeaders: incoming })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(
      limited({ bucket: "sign-in-account", requestHeaders: incoming }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("trusted client IP (Better Auth getIP with the Flexibx configuration)", () => {
  const ipOf = (config: Parameters<typeof build>[0], headers: Record<string, string>) =>
    getIP(new Request("http://x/", { headers }), build(config).options);

  it("never trusts X-Forwarded-For or any header without configuration", () => {
    const ip = ipOf({}, { "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.7" });
    // Test runtime: Better Auth's loopback fallback; production: null (shared bucket).
    expect([null, "127.0.0.1"]).toContain(ip);
  });

  it("uses the configured header for a direct (single-value) connection", () => {
    expect(
      ipOf(
        { ipHeader: "x-real-ip" },
        { "x-real-ip": "198.51.100.7", "x-forwarded-for": "6.6.6.6" },
      ),
    ).toBe("198.51.100.7");
    // A forged chain without trusted proxies is not trusted at all.
    expect(ipOf({ ipHeader: "x-real-ip" }, { "x-real-ip": "6.6.6.6, 198.51.100.7" })).not.toBe(
      "6.6.6.6",
    );
  });

  it("strips trusted proxies from the right and ignores the spoofable left side", () => {
    expect(
      ipOf(
        { ipHeader: "x-forwarded-for", trustedProxies: ["10.0.0.0/8"] },
        { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.2" },
      ),
    ).toBe("198.51.100.7");
  });
});

describe("verification policy", () => {
  it("is required in production and optional elsewhere unless configured", () => {
    expect(resolveEmailVerificationRequired("production", undefined)).toBe(true);
    expect(resolveEmailVerificationRequired("development", undefined)).toBe(false);
    expect(resolveEmailVerificationRequired("test", undefined)).toBe(false);
    expect(resolveEmailVerificationRequired("production", false)).toBe(false);
    expect(resolveEmailVerificationRequired("test", true)).toBe(true);
  });

  it("applies only to verified-only operations: unverified is refused when required, allowed otherwise", () => {
    const required = { requireEmailVerification: true };
    const optional = { requireEmailVerification: false };
    const unverified = { emailVerified: false };
    const verified = { emailVerified: true };
    expect(hasRequiredEmailVerification(unverified, required)).toBe(false);
    expect(hasRequiredEmailVerification(verified, required)).toBe(true);
    expect(hasRequiredEmailVerification(unverified, optional)).toBe(true);
    expect(hasRequiredEmailVerification(verified, optional)).toBe(true);
    expect(() => {
      requireVerifiedEmail(verified, required);
    }).not.toThrow();
    expect(() => {
      requireVerifiedEmail(unverified, optional);
    }).not.toThrow();
    let error: unknown;
    try {
      requireVerifiedEmail(unverified, required);
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error) && error.code).toBe("FORBIDDEN");
    expect(isAppError(error) && error.fields.map((field) => field.code)).toEqual([
      "email_not_verified",
    ]);
  });
});

describe("safe return paths for the auth flows", () => {
  it.each([
    "https://evil.example/en",
    "//evil.example/en",
    "/\\evil.example",
    "javascript:alert(1)",
    "/%2F%2Fevil.example",
    "/en/../../evil",
    "/api/auth/get-session",
    "%2Fen%2Fw",
    "/en\u0000/w",
  ])("rejects %s", (target) => {
    expect(safeNextPath(target, "en").startsWith("/en")).toBe(true);
    expect(postSignInPath(target, "ar")).toMatch(/^\/ar(\/|$)/);
    expect(signInPath("ar", target)).toBe("/ar/sign-in");
  });

  it("keeps internal targets and their locale", () => {
    expect(postSignInPath("/ar/invite/abc", "en")).toBe("/ar/invite/abc");
    expect(signInPath("en", "/en/account/security")).toBe(
      "/en/sign-in?next=%2Fen%2Faccount%2Fsecurity",
    );
  });
});

describe("mail transports for account emails", () => {
  it("development/test transports never claim an email was sent", async () => {
    const memory: Mailer = new MemoryMailer();
    await expect(
      memory.send({
        to: "a@b.co",
        locale: "ar",
        template: "password_reset",
        data: { name: "A", url: `${APP}/ar/reset-password#token=t`, expiresInMinutes: 60 },
      }),
    ).resolves.toEqual({ status: "captured" });
  });
});

describe("constant-shape response times", () => {
  it("never answers before the minimum, on success or failure", async () => {
    expect(ENUMERATION_SAFE_MIN_DURATION_MS).toBeGreaterThanOrEqual(500);
    const started = Date.now();
    await expect(withMinimumDuration(120, () => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
    const failing = Date.now();
    await expect(withMinimumDuration(120, () => Promise.reject(new Error("x")))).rejects.toThrow(
      "x",
    );
    expect(Date.now() - failing).toBeGreaterThanOrEqual(115);
    // Slow work is not delayed further.
    const slow = Date.now();
    await withMinimumDuration(10, () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(Date.now() - slow).toBeLessThan(200);
  });
});
