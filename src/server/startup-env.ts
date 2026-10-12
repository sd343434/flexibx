import {
  EnvValidationError,
  parseAdsEnv,
  parseAiEnv,
  parseAuthEnv,
  parseAutomationEnv,
  parseBillingEnv,
  parseMailEnv,
  parseServerEnv,
  parseStorageDriver,
  parseVideoEnv,
  parseVideoRetentionEnv,
  testProvidersAllowed,
} from "./env-schema";

// Validates every environment group once, when the server starts, instead of on the first
// request that needs it (a bad AUTH_SECRET used to pass the health check and fail later).
// Pure module (no `server-only`) so it can be unit-tested; src/instrumentation.ts calls it.
// Reports carry variable names and rules only — never values.

type EnvSource = Readonly<Record<string, string | undefined>>;

export interface StartupEnvReport {
  /** Invalid configuration: the server must not start in production. */
  readonly errors: readonly string[];
  /** Valid but risky for a real deployment: logged loudly. */
  readonly warnings: readonly string[];
}

const GROUPS: readonly (readonly [string, (source: EnvSource) => unknown])[] = [
  ["server", parseServerEnv],
  ["auth", parseAuthEnv],
  ["AI", parseAiEnv],
  ["mail", parseMailEnv],
  ["storage", parseStorageDriver],
  ["video", parseVideoEnv],
  ["video retention", parseVideoRetentionEnv],
  ["ads", parseAdsEnv],
  ["billing", parseBillingEnv],
  ["automation", parseAutomationEnv],
];

export function checkStartupEnv(source: EnvSource): StartupEnvReport {
  const errors: string[] = [];
  for (const [scope, parse] of GROUPS) {
    try {
      parse(source);
    } catch (error) {
      errors.push(
        error instanceof EnvValidationError
          ? error.message
          : `Invalid ${scope} environment configuration`,
      );
    }
  }
  const warnings: string[] = [];
  if (source.NODE_ENV === "production") {
    if (source.FLEXIBX_TEST_PROVIDERS === "allow" && testProvidersAllowed(source)) {
      warnings.push(
        "FLEXIBX_TEST_PROVIDERS=allow: test-only providers are enabled (local end-to-end runs only)",
      );
    }
    if ((source.AUTOMATION_CRON_SECRET ?? "").trim() === "") {
      warnings.push(
        "AUTOMATION_CRON_SECRET is not set: scheduled publishing, stuck-state recovery and abandoned credit holds are not processed",
      );
    }
    if ((source.ENCRYPTION_KEY ?? "").trim() === "") {
      warnings.push("ENCRYPTION_KEY is not set: platform integrations are unavailable");
    }
  }
  return { errors, warnings };
}

/** Throws (production) or returns the report; the caller logs it. */
export function assertStartupEnv(source: EnvSource): StartupEnvReport {
  const report = checkStartupEnv(source);
  if (source.NODE_ENV === "production" && report.errors.length > 0) {
    throw new Error(`Refusing to start:\n${report.errors.join("\n")}`);
  }
  return report;
}
