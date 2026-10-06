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

export type ServerEnv = z.infer<typeof serverEnvSchema>;
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

export function parseStorageEnv(source: EnvSource): StorageEnv {
  const result = storageEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("storage", result.error.issues);
  return result.data;
}
