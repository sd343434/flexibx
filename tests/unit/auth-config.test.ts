import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  createAuth,
  DISABLED_HTTP_PATHS,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "@/server/auth/auth-config";
import { EnvValidationError, parseAuthEnv } from "@/server/env-schema";
import { MemoryMailer } from "@/server/mail/mailer";

const SECRET = "x".repeat(40);

function build(overrides: Partial<Parameters<typeof createAuth>[0]> = {}) {
  return createAuth({
    db: {} as PrismaClient, // never queried here
    secret: SECRET,
    baseURL: "http://localhost:3000",
    appUrl: "http://localhost:3000",
    isProduction: false,
    requireEmailVerification: false,
    mailer: new MemoryMailer(),
    onSecurityEvent: () => Promise.resolve(),
    log: () => undefined,
    ...overrides,
  });
}

describe("auth configuration invariants", () => {
  const { options } = build();

  it("uses Postgres-generated ids, DB sessions without cookie cache, and 7-day rolling sessions", () => {
    expect(options.advanced.database.generateId).toBe(false);
    expect(options.session.cookieCache.enabled).toBe(false);
    expect(options.session.expiresIn).toBe(SESSION_EXPIRES_IN_SECONDS);
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(604_800);
    expect(options.session.updateAge).toBe(SESSION_UPDATE_AGE_SECONDS);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(86_400);
  });

  it("keeps origin/CSRF checks on, telemetry off, and sign-up/sign-in off the HTTP surface", () => {
    expect(options.advanced.disableOriginCheck).toBe(false);
    expect("disableCSRFCheck" in options.advanced).toBe(false);
    expect(options.telemetry.enabled).toBe(false);
    expect(options.disabledPaths).toEqual([...DISABLED_HTTP_PATHS]);
    expect(options.trustedOrigins).toEqual(["http://localhost:3000"]);
  });

  it("never accepts isPlatformAdmin or locale from auth input", () => {
    expect(options.user.additionalFields.isPlatformAdmin.input).toBe(false);
    expect(options.user.additionalFields.locale.input).toBe(false);
  });

  it("does not auto sign-in after sign-up and revokes sessions on password reset", () => {
    expect(options.emailAndPassword.autoSignIn).toBe(false);
    expect(options.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("uses secure cookies in production and on https, not on local http", () => {
    expect(options.advanced.useSecureCookies).toBe(false);
    expect(build({ isProduction: true }).options.advanced.useSecureCookies).toBe(true);
    expect(build({ baseURL: "https://app.flexibx.test" }).options.advanced.useSecureCookies).toBe(
      true,
    );
  });

  it("trusts no client IP header by default; a configured header/proxy list is used as given", () => {
    // No header at all — not even X-Forwarded-For — is read without configuration.
    expect(options.advanced.ipAddress).toEqual({ ipAddressHeaders: [] });
    expect(build({ ipHeader: "cf-connecting-ip" }).options.advanced.ipAddress).toEqual({
      ipAddressHeaders: ["cf-connecting-ip"],
    });
    expect(
      build({ ipHeader: "x-forwarded-for", trustedProxies: ["10.0.0.5"] }).options.advanced
        .ipAddress,
    ).toEqual({ ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["10.0.0.5"] });
  });

  it("forwards only redacted message text to the log sink", () => {
    const lines: string[] = [];
    const auth = build({ log: (_level, message) => lines.push(message) });
    const log = auth.options.logger.log as (...args: unknown[]) => void;
    // Assembled at runtime so secret scanners never see a credential-shaped literal.
    const url = ["postgresql://app", ":", "not-a-real-password", "@db/x"].join("");
    log("error", `failed for ${url}`, {
      token: "abc",
      ipAddress: "203.0.113.7",
    });
    expect(lines).toEqual(["failed for postgresql://app:[REDACTED]@db/x"]);
  });
});

describe("auth API error logging", () => {
  it("sends API errors to the sink as status + fixed message, never error details", () => {
    const lines: string[] = [];
    const auth = build({ log: (level, message) => lines.push(`${level}:${message}`) });
    const { onError } = auth.options.onAPIError;
    onError(new APIError("FORBIDDEN", { message: "Invalid origin" }));
    const internal = new Error("token=abc123 at row");
    internal.name = "PrismaClientKnownRequestError";
    onError(internal);
    expect(lines).toEqual([
      "warn:api error 403: Invalid origin",
      "error:api error: PrismaClientKnownRequestError",
    ]);
  });
});

describe("auth environment", () => {
  it("requires a strong AUTH_SECRET", () => {
    expect(() => parseAuthEnv({})).toThrow(EnvValidationError);
    expect(() => parseAuthEnv({ AUTH_SECRET: "short" })).toThrow(EnvValidationError);
    expect(parseAuthEnv({ AUTH_SECRET: SECRET }).AUTH_SECRET).toBe(SECRET);
  });

  it("never echoes the secret in validation errors", () => {
    try {
      parseAuthEnv({ AUTH_SECRET: "tooshort-secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("tooshort-secret-value");
      return;
    }
    throw new Error("expected a validation error");
  });

  it("leaves IP trust unset by default and validates a configured header and proxy list", () => {
    const base = { AUTH_SECRET: SECRET };
    expect(parseAuthEnv(base)).toEqual({ AUTH_SECRET: SECRET });
    expect(parseAuthEnv({ ...base, AUTH_REQUIRE_EMAIL_VERIFICATION: "true" })).toMatchObject({
      AUTH_REQUIRE_EMAIL_VERIFICATION: true,
    });
    expect(() => parseAuthEnv({ ...base, AUTH_REQUIRE_EMAIL_VERIFICATION: "yes" })).toThrow(
      EnvValidationError,
    );
    expect(parseAuthEnv({ ...base, AUTH_IP_HEADER: "", AUTH_TRUSTED_PROXIES: "" })).toEqual(base);
    expect(
      parseAuthEnv({
        ...base,
        AUTH_IP_HEADER: "CF-Connecting-IP",
        AUTH_TRUSTED_PROXIES: "10.0.0.5, 192.0.2.0/24",
      }),
    ).toMatchObject({
      AUTH_IP_HEADER: "cf-connecting-ip",
      AUTH_TRUSTED_PROXIES: ["10.0.0.5", "192.0.2.0/24"],
    });
    expect(() => parseAuthEnv({ ...base, AUTH_IP_HEADER: "x-a, x-b" })).toThrow(EnvValidationError);
    expect(() => parseAuthEnv({ ...base, AUTH_TRUSTED_PROXIES: "everyone" })).toThrow(
      EnvValidationError,
    );
  });
});
