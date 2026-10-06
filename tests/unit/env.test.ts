import { describe, expect, it } from "vitest";

import { EnvValidationError, parseServerEnv, parseStorageEnv } from "@/server/env-schema";

const valid = {
  NODE_ENV: "production",
  APP_URL: "https://app.flexibx.example",
  DATABASE_URL: "postgresql://user:pw@db.internal:5432/flexibx",
};

describe("parseServerEnv", () => {
  it("accepts a minimal valid configuration and applies defaults", () => {
    const env = parseServerEnv({ ...valid, NODE_ENV: undefined });
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  it("treats empty reserved variables as unset", () => {
    const env = parseServerEnv({ ...valid, AUTH_SECRET: "", ENCRYPTION_KEY: "  ", REDIS_URL: "" });
    expect(env.AUTH_SECRET).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("rejects missing required variables, naming them", () => {
    expect(() => parseServerEnv({})).toThrow(EnvValidationError);
    try {
      parseServerEnv({});
    } catch (error) {
      const variables = (error as EnvValidationError).issues.map((issue) => issue.variable);
      expect(variables).toEqual(expect.arrayContaining(["APP_URL", "DATABASE_URL"]));
    }
  });

  it("rejects non-postgres database URLs", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://x@y/z" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("validates reserved secrets when they are provided", () => {
    expect(() => parseServerEnv({ ...valid, AUTH_SECRET: "too-short" })).toThrow(/AUTH_SECRET/);
    expect(() =>
      parseServerEnv({ ...valid, ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(
      parseServerEnv({ ...valid, ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") })
        .ENCRYPTION_KEY,
    ).toBeDefined();
    expect(() => parseServerEnv({ ...valid, REDIS_URL: "http://localhost:6379" })).toThrow(
      /REDIS_URL/,
    );
  });

  it("never includes secret values in the error message", () => {
    const secret = "postgresql-but-not-really://admin:SuperSecretPassword@host/db";
    try {
      parseServerEnv({ ...valid, DATABASE_URL: secret, AUTH_SECRET: "tiny-secret-value" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("SuperSecretPassword");
      expect(String(error)).not.toContain("tiny-secret-value");
    }
  });
});

describe("parseStorageEnv", () => {
  const storage = {
    S3_REGION: "us-east-1",
    S3_BUCKET: "flexibx-dev",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
  };

  it("parses booleans and optional URLs", () => {
    const env = parseStorageEnv({
      ...storage,
      S3_FORCE_PATH_STYLE: "true",
      S3_ENDPOINT: "http://localhost:9000",
      S3_PUBLIC_BASE_URL: "",
    });
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_ENDPOINT).toBe("http://localhost:9000");
    expect(env.S3_PUBLIC_BASE_URL).toBeUndefined();
  });

  it("requires credentials and bucket", () => {
    expect(() => parseStorageEnv({ S3_REGION: "us-east-1" })).toThrow(/S3_BUCKET/);
  });
});
