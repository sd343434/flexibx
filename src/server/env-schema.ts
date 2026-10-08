import { z } from "zod";

// Pure schemas + parsers (no `server-only`), so they can be unit-tested and reused by
// scripts such as prisma/seed.ts. Application code should use `getEnv()` from ./env.

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema.optional());

const postgresUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: "must be a postgres:// or postgresql:// connection string",
  });

const base64Key32 = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be 32 bytes encoded as base64 (openssl rand -base64 32)" },
);

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url({ protocol: /^https?$/ }),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: postgresUrl,

  // Reserved for later phases — optional now, validated if present.
  AUTH_SECRET: optional(z.string().min(32, "must be at least 32 characters")),
  AUTH_URL: optional(z.url()),
  ENCRYPTION_KEY: optional(base64Key32),
  REDIS_URL: optional(z.url({ protocol: /^rediss?$/ })),
});

export const storageEnvSchema = z.object({
  S3_ENDPOINT: optional(z.url()),
  S3_REGION: z.string().trim().min(1),
  S3_BUCKET: z.string().trim().min(3),
  S3_ACCESS_KEY_ID: z.string().trim().min(1),
  S3_SECRET_ACCESS_KEY: z.string().trim().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  S3_PUBLIC_BASE_URL: optional(z.url()),
});

/**
 * Authentication settings, validated when the auth layer is first used.
 * AUTH_SECRET signs session cookies. It must be generated independently and kept out of
 * the database: rotating it invalidates every existing session cookie (users sign in again).
 */
export const authEnvSchema = z.object({
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -base64 32)"),
  // Email verification policy (decision C6) for verified-only operations; sign-in and
  // workspace creation never need it (C1). Unset: required in production, not in
  // development/test. "true"/"false" overrides it explicitly.
  AUTH_REQUIRE_EMAIL_VERIFICATION: optional(
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ),
  // Trusted client-IP source. Unset (default): no forwarded header is trusted, because
  // they are client-controlled unless a known proxy overwrites them; rate limits then
  // fall back to one shared bucket per entry point (documented in ARCHITECTURE.md).
  AUTH_IP_HEADER: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9-]{1,64}$/, "must be a single HTTP header name"),
  ),
  // Comma-separated IPs/CIDRs of the reverse proxies in front of the app (only with
  // AUTH_IP_HEADER). Never a broad private range that also covers clients.
  AUTH_TRUSTED_PROXIES: optional(
    z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ""),
      )
      .pipe(z.array(z.string().regex(/^[0-9a-f:.]+(\/\d{1,3})?$/i, "must be an IP or CIDR"))),
  ),
});

/**
 * Mail transport selection. Unset: the environment default (memory in test, log in
 * development, explicit failure in production). `test-outbox` writes rendered emails to
 * MAIL_OUTBOX_DIR for end-to-end tests — never for a real deployment.
 */
export const mailEnvSchema = z.object({
  MAIL_TRANSPORT: optional(z.enum(["test-outbox"])),
  MAIL_OUTBOX_DIR: optional(z.string().trim().min(1)),
});

export type MailEnv = z.infer<typeof mailEnvSchema>;

/** Whether verified-only operations require a verified email (decision C6; never sign-in). */
export function resolveEmailVerificationRequired(
  nodeEnv: string | undefined,
  configured: boolean | undefined,
): boolean {
  return configured ?? nodeEnv === "production";
}

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;
export type StorageEnv = z.infer<typeof storageEnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly { readonly variable: string; readonly message: string }[];

  constructor(scope: string, issues: readonly z.core.$ZodIssue[]) {
    const details = issues.map((issue) => ({
      variable: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    // Only variable names and rule messages — never the values themselves.
    super(
      `Invalid ${scope} environment configuration:\n` +
        details.map((d) => `  - ${d.variable}: ${d.message}`).join("\n"),
    );
    this.name = "EnvValidationError";
    this.issues = details;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

export function parseServerEnv(source: EnvSource): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("server", result.error.issues);
  return result.data;
}

export function parseAuthEnv(source: EnvSource): AuthEnv {
  const result = authEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("auth", result.error.issues);
  return result.data;
}

export function parseMailEnv(source: EnvSource): MailEnv {
  const result = mailEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("mail", result.error.issues);
  return result.data;
}

/**
 * Storage backend. `s3` (default) is the only real backend. `test-memory` keeps objects
 * in the server process for automated end-to-end runs without object storage (like
 * MAIL_TRANSPORT=test-outbox): objects vanish on restart — never for a real deployment.
 */
export const storageDriverSchema = z.object({
  STORAGE_DRIVER: optional(z.enum(["s3", "test-memory"])),
});

export function parseStorageDriver(source: EnvSource): "s3" | "test-memory" {
  const result = storageDriverSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("storage", result.error.issues);
  return result.data.STORAGE_DRIVER ?? "s3";
}

export function parseStorageEnv(source: EnvSource): StorageEnv {
  const result = storageEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("storage", result.error.issues);
  return result.data;
}
