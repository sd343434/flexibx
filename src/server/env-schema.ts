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

/**
 * AI provider (Phase 4). `disabled` (default): every AI operation fails with
 * SERVICE_UNAVAILABLE ("AI is not configured"). `fake`: a deterministic local adapter for
 * development and automated tests — it calls no external service and its suggestions are
 * placeholders, never for a real deployment. No commercial provider exists yet, so no
 * API key is read. AI_TIMEOUT_MS bounds one provider call (1–120 s, default 30 s).
 */
export const aiEnvSchema = z.object({
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["disabled", "fake"]).default("disabled")),
  AI_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1000).max(120_000).default(30_000),
  ),
});

export type AiEnv = z.infer<typeof aiEnvSchema>;

export function parseAiEnv(source: EnvSource): AiEnv {
  const result = aiEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("AI", result.error.issues);
  return result.data;
}

/**
 * Generative video provider (Phase 4). `disabled` (default): video requests fail with
 * SERVICE_UNAVAILABLE. `fake`: the deterministic local provider — no external call, no
 * cost, placeholder clips; refused when NODE_ENV=production so placeholder files never
 * reach real customers. No commercial video provider exists yet, so no key is read.
 */
export const videoEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    VIDEO_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["disabled", "fake"]).default("disabled"),
    ),
  })
  .refine((env) => !(env.NODE_ENV === "production" && env.VIDEO_PROVIDER === "fake"), {
    path: ["VIDEO_PROVIDER"],
    message: "the fake video provider is not allowed in production",
  });

export type VideoEnv = z.infer<typeof videoEnvSchema>;

export function parseVideoEnv(source: EnvSource): VideoEnv {
  const result = videoEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("video", result.error.issues);
  return result.data;
}

/**
 * Generated video retention job.
 * - VIDEO_RETENTION_CRON_SECRET: bearer secret for POST /api/internal/video-retention,
 *   the endpoint a scheduler calls (≥ 32 characters). Unset = the endpoint is disabled
 *   (404) and the job must be run another way.
 * - VIDEO_EXPIRY_EMAILS: `enabled` sends 48 h / 24 h reminder emails; only meaningful once
 *   a real email provider is configured. Default `disabled`: in-app notices only.
 */
export const videoRetentionEnvSchema = z.object({
  VIDEO_RETENTION_CRON_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  VIDEO_EXPIRY_EMAILS: z.preprocess(
    emptyToUndefined,
    z.enum(["disabled", "enabled"]).default("disabled"),
  ),
});

export type VideoRetentionEnv = z.infer<typeof videoRetentionEnvSchema>;

export function parseVideoRetentionEnv(source: EnvSource): VideoRetentionEnv {
  const result = videoRetentionEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("video retention", result.error.issues);
  return result.data;
}

/**
 * Advertising platforms. Meta (Facebook and Instagram ads) is available only when the
 * Meta app's id and secret are set AND ENCRYPTION_KEY exists (tokens are stored
 * encrypted). Unset = the integration shows "not configured" and makes no call.
 * - META_APP_ID / META_APP_SECRET: from the Meta app dashboard (secret never logged).
 * - META_GRAPH_VERSION: Graph / Marketing API version (default v26.0).
 * - META_REDIRECT_URI: OAuth redirect; default {APP_URL}/api/integrations/meta/callback
 *   (must be registered as a valid OAuth redirect URI in the Meta app).
 * - META_CONFIG_ID: the Facebook Login for Business configuration id (Business apps).
 *   When set, the login dialog asks for that configuration (`config_id`) instead of a
 *   permission list (`scope`), which Facebook Login for Business does not use; the
 *   permissions are then the configuration's, and the granted ones are still checked.
 * Snapchat Ads is available only when SNAPCHAT_CLIENT_ID and SNAPCHAT_CLIENT_SECRET (a
 * Snap Marketing API OAuth app from Snapchat Ads Manager → Business Details) are set AND
 * ENCRYPTION_KEY exists.
 * - SNAPCHAT_REDIRECT_URI: default {APP_URL}/api/integrations/snapchat/callback (must be
 *   the redirect URI registered on the Snap OAuth app).
 * TikTok Ads is available only when TIKTOK_APP_ID and TIKTOK_APP_SECRET (a TikTok API for
 * Business developer app with Ad Account Management and Reporting permissions) are set
 * AND ENCRYPTION_KEY exists.
 * - TIKTOK_REDIRECT_URI: default {APP_URL}/api/integrations/tiktok/callback (must be the
 *   app's registered redirect URL).
 * - TIKTOK_AUTHORIZE_URL: the app's "Advertiser authorization URL" from My Apps (https,
 *   on business-api.tiktok.com or ads.tiktok.com); default
 *   https://business-api.tiktok.com/portal/auth. state and redirect_uri are set on it.
 * WhatsApp Business uses the same Meta app (META_APP_ID / META_APP_SECRET) and is
 * available only when WHATSAPP_CONFIG_ID (the Embedded Signup configuration of Facebook
 * Login for Business) is also set, with ENCRYPTION_KEY.
 * - WHATSAPP_REDIRECT_URI: default {APP_URL}/api/integrations/whatsapp/callback.
 * - WHATSAPP_WEBHOOK_VERIFY_TOKEN: the Verify Token entered for the webhook in the App
 *   Dashboard; without it the webhook endpoint refuses verification. Payloads are always
 *   checked against META_APP_SECRET (X-Hub-Signature-256).
 */
export const adsEnvSchema = z
  .object({
    META_APP_ID: optional(
      z
        .string()
        .trim()
        .regex(/^\d{5,32}$/, "must be the numeric app id"),
    ),
    META_APP_SECRET: optional(z.string().trim().min(16, "must be the app secret")),
    META_GRAPH_VERSION: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^v\d{2}\.0$/, "must look like v26.0")
        .default("v26.0"),
    ),
    META_REDIRECT_URI: optional(z.url({ protocol: /^https?$/ })),
    META_CONFIG_ID: optional(
      z
        .string()
        .trim()
        .regex(/^\d{5,32}$/, "must be the numeric Facebook Login for Business configuration id"),
    ),
    SNAPCHAT_CLIENT_ID: optional(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{8,128}$/, "must be the Snap OAuth client id"),
    ),
    SNAPCHAT_CLIENT_SECRET: optional(z.string().trim().min(16, "must be the client secret")),
    SNAPCHAT_REDIRECT_URI: optional(z.url({ protocol: /^https?$/ })),
    TIKTOK_APP_ID: optional(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{6,64}$/, "must be the TikTok for Business app id"),
    ),
    TIKTOK_APP_SECRET: optional(z.string().trim().min(16, "must be the app secret")),
    TIKTOK_REDIRECT_URI: optional(z.url({ protocol: /^https?$/ })),
    WHATSAPP_CONFIG_ID: optional(
      z
        .string()
        .trim()
        .regex(/^\d{5,32}$/, "must be the numeric Embedded Signup configuration id"),
    ),
    WHATSAPP_REDIRECT_URI: optional(z.url({ protocol: /^https?$/ })),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: optional(
      z.string().trim().min(24, "must be a random string of at least 24 characters"),
    ),
    // External writes are OFF unless explicitly enabled after credentialed validation:
    // creating/activating campaigns, and sending WhatsApp messages. Each still needs a
    // person's approval of the exact action.
    ADS_EXECUTION_ENABLED: optional(z.enum(["true", "false"])),
    WHATSAPP_SENDING_ENABLED: optional(z.enum(["true", "false"])),
    TIKTOK_AUTHORIZE_URL: optional(
      z.url({ protocol: /^https$/, hostname: /^(?:business-api|ads)\.tiktok\.com$/ }),
    ),
  })
  .refine((env) => (env.META_APP_ID === undefined) === (env.META_APP_SECRET === undefined), {
    path: ["META_APP_SECRET"],
    message: "META_APP_ID and META_APP_SECRET must be set together",
  })
  .refine(
    (env) => (env.SNAPCHAT_CLIENT_ID === undefined) === (env.SNAPCHAT_CLIENT_SECRET === undefined),
    {
      path: ["SNAPCHAT_CLIENT_SECRET"],
      message: "SNAPCHAT_CLIENT_ID and SNAPCHAT_CLIENT_SECRET must be set together",
    },
  )
  .refine((env) => env.META_CONFIG_ID === undefined || env.META_APP_ID !== undefined, {
    path: ["META_CONFIG_ID"],
    message: "META_CONFIG_ID needs the Meta app (META_APP_ID and META_APP_SECRET)",
  })
  .refine((env) => env.WHATSAPP_CONFIG_ID === undefined || env.META_APP_ID !== undefined, {
    path: ["WHATSAPP_CONFIG_ID"],
    message: "WHATSAPP_CONFIG_ID needs the Meta app (META_APP_ID and META_APP_SECRET)",
  })
  .refine((env) => (env.TIKTOK_APP_ID === undefined) === (env.TIKTOK_APP_SECRET === undefined), {
    path: ["TIKTOK_APP_SECRET"],
    message: "TIKTOK_APP_ID and TIKTOK_APP_SECRET must be set together",
  });

export type AdsEnv = z.infer<typeof adsEnvSchema>;

export function parseAdsEnv(source: EnvSource): AdsEnv {
  const result = adsEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("advertising", result.error.issues);
  return result.data;
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

/**
 * Wasabi access keys: server-side secrets from the environment (or the platform's secret
 * store feeding it), never stored in the database, shown in the admin UI or logged. The
 * non-secret settings (region, endpoint, bucket) are kept in the platform admin.
 */
export const wasabiCredentialsSchema = z.object({
  WASABI_ACCESS_KEY_ID: optional(z.string().trim().min(16).max(128)),
  WASABI_SECRET_ACCESS_KEY: optional(z.string().trim().min(32).max(256)),
});

export interface WasabiCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Both keys, or null when either is missing. Malformed values throw (names only). */
export function parseWasabiCredentials(source: EnvSource): WasabiCredentials | null {
  const result = wasabiCredentialsSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("wasabi", result.error.issues);
  const { WASABI_ACCESS_KEY_ID: accessKeyId, WASABI_SECRET_ACCESS_KEY: secretAccessKey } =
    result.data;
  if (accessKeyId === undefined || secretAccessKey === undefined) return null;
  return { accessKeyId, secretAccessKey };
}

export function parseStorageEnv(source: EnvSource): StorageEnv {
  const result = storageEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError("storage", result.error.issues);
  return result.data;
}
