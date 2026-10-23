import { describe, expect, it } from "vitest";

import {
  EnvValidationError,
  parseAiEnv,
  parseMailEnv,
  parseStorageDriver,
  testProvidersAllowed,
} from "@/server/env-schema";
import { assertStartupEnv, checkStartupEnv } from "@/server/startup-env";

const SECRET = "s".repeat(48);
const prod = (extra: Record<string, string> = {}) => ({
  NODE_ENV: "production",
  APP_URL: "https://app.flexibx.example",
  DATABASE_URL: "postgresql://u:p@db.example:5432/flexibx",
  AUTH_SECRET: SECRET,
  AUTH_IP_HEADER: "x-real-ip",
  ...extra,
});

describe("test-only providers in production", () => {
  it.each([
    ["AI_PROVIDER", "fake", parseAiEnv],
    ["MAIL_TRANSPORT", "test-outbox", parseMailEnv],
    ["STORAGE_DRIVER", "test-memory", parseStorageDriver],
  ] as const)("refuses %s=%s", (variable, value, parse) => {
    const source = prod({ [variable]: value, MAIL_OUTBOX_DIR: "/tmp/outbox" });
    expect(() => parse(source)).toThrow(EnvValidationError);
    expect(() => parse(source)).toThrow(new RegExp(variable));
    // Allowed outside production (development and the test suites).
    expect(() => parse({ ...source, NODE_ENV: "test" })).not.toThrow();
    expect(() => parse({ ...source, NODE_ENV: "development" })).not.toThrow();
  });

  it("allows them for a local end-to-end run only, never on a real domain", () => {
    const local = prod({ APP_URL: "http://127.0.0.1:3100", FLEXIBX_TEST_PROVIDERS: "allow" });
    expect(testProvidersAllowed(local)).toBe(true);
    expect(parseAiEnv({ ...local, AI_PROVIDER: "fake" }).AI_PROVIDER).toBe("fake");
    expect(testProvidersAllowed({ ...local, APP_URL: "http://localhost:3000" })).toBe(true);
    // The flag alone is not enough on a real deployment.
    expect(testProvidersAllowed(prod({ FLEXIBX_TEST_PROVIDERS: "allow" }))).toBe(false);
    expect(testProvidersAllowed({ ...local, FLEXIBX_TEST_PROVIDERS: "yes" })).toBe(false);
    expect(testProvidersAllowed({ ...local, APP_URL: "http://localhost.evil.example" })).toBe(
      false,
    );
  });

  it("keeps real providers working in production", () => {
    expect(
      parseAiEnv(prod({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k".repeat(40) })).AI_PROVIDER,
    ).toBe("openai");
    expect(parseStorageDriver(prod())).toBe("s3");
  });
});

describe("start-up validation", () => {
  it("stops a production start with the names of the bad variables, never their values", () => {
    const leaked = "super-secret-value-123";
    const source = prod({ AUTH_SECRET: "short", AI_PROVIDER: "fake", OPENAI_API_KEY: leaked });
    let message = "";
    try {
      assertStartupEnv(source);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/Refusing to start/);
    expect(message).toMatch(/AUTH_SECRET/);
    expect(message).toMatch(/AI_PROVIDER/);
    expect(message).not.toContain("short");
    expect(message).not.toContain(leaked);
  });

  it("starts a valid production configuration, warning about what is missing", () => {
    const report = assertStartupEnv(prod());
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/AUTOMATION_CRON_SECRET/);
    expect(report.warnings.join("\n")).toMatch(/ENCRYPTION_KEY/);
  });

  it("refuses a public production start without a trusted client-IP header (Pass 38)", () => {
    const { AUTH_IP_HEADER: _unused, ...withoutHeader } = prod();
    expect(() => assertStartupEnv(withoutHeader)).toThrow(/AUTH_IP_HEADER is not set/);
    expect(() => assertStartupEnv({ ...withoutHeader, AUTH_IP_HEADER: " " })).toThrow(
      /AUTH_IP_HEADER is not set/,
    );
    // Local production runs (e2e, the local staging rehearsal) are not public.
    for (const appUrl of ["http://127.0.0.1:3100", "http://localhost:3000"]) {
      expect(checkStartupEnv({ ...withoutHeader, APP_URL: appUrl }).errors).toEqual([]);
    }
    expect(checkStartupEnv(prod()).errors).toEqual([]);
    // Development never needs it.
    expect(
      checkStartupEnv({ ...withoutHeader, NODE_ENV: "development" }).errors.join("\n"),
    ).not.toMatch(/AUTH_IP_HEADER/);
  });

  it("reports but never stops development", () => {
    const report = assertStartupEnv({ NODE_ENV: "development", APP_URL: "nope" });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(checkStartupEnv({ NODE_ENV: "development", APP_URL: "nope" }).warnings).toEqual([]);
  });
});
