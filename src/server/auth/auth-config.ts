import { betterAuth } from "better-auth";
import { isAPIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import type { PrismaClient } from "@/generated/prisma/client";

import { redactString } from "../redact";

// Pure factory (no `server-only`), so integration tests can build the exact production
// configuration. Application code uses `getAuth()` from ./auth.

/** Cookie names are `flexibx.session_token` (`__Secure-flexibx.…` when secure). */
export const AUTH_COOKIE_PREFIX = "flexibx";

/** 7-day sessions, extended ("rolled") at most once per day while in use. */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Better Auth endpoints that are NOT exposed over HTTP. Sign-up and sign-in run only
 * through Flexibx server code (src/server/auth/credentials.ts), which returns generic
 * results so the public surface never reveals whether an email is registered.
 * The server-side `auth.api.*` calls are unaffected.
 */
export const DISABLED_HTTP_PATHS = ["/sign-up/email", "/sign-in/email"] as const;

export type AuthLogLevel = "debug" | "info" | "warn" | "error";

export interface AuthConfigInput {
  /** The SYSTEM (unguarded) Prisma client: auth tables are global, not workspace-owned. */
  readonly db: PrismaClient;
  readonly secret: string;
  /** Public origin of the app (APP_URL); also the only trusted origin. */
  readonly baseURL: string;
  readonly isProduction: boolean;
  /** Trusted client-IP header; undefined = do not trust or record any client IP. */
  readonly ipHeader?: string | undefined;
  readonly trustedProxies?: readonly string[] | undefined;
  /** Receives Better Auth's log messages (message text only, redacted). */
  readonly log: (level: AuthLogLevel, message: string) => void;
}

export function createAuth(input: AuthConfigInput) {
  const secureCookies = input.isProduction || input.baseURL.startsWith("https://");
  return betterAuth({
    secret: input.secret,
    baseURL: input.baseURL,
    trustedOrigins: [new URL(input.baseURL).origin],
    database: prismaAdapter(input.db, { provider: "postgresql" }),
    disabledPaths: [...DISABLED_HTTP_PATHS],
    // Must stay the LAST plugin. Server actions and route handlers that call auth.api.*
    // get their session cookies written (and refreshed) through next/headers. In a
    // Server Component render, where cookies cannot be written, it skips the rolling
    // refresh so the database expiry never runs ahead of the browser cookie; page
    // requests are refreshed by the proxy instead (see session-refresh.ts).
    plugins: [nextCookies()],
    telemetry: { enabled: false },
    // Enabled with the trusted-IP rate limiting step; without a trusted client IP a
    // limiter is either ineffective or keyed on spoofable headers.
    rateLimit: { enabled: false },
    logger: {
      level: "warn",
      // Only the message text is forwarded: argument objects (requests, sessions) are
      // dropped so tokens, IPs and passwords cannot reach the logs.
      log: (level, message) => {
        input.log(level, redactString(message));
      },
    },
    // API errors are otherwise printed by Better Auth's own console logger, outside pino.
    // Only the status and Better Auth's fixed message (or an error class name) are kept.
    onAPIError: {
      onError: (error) => {
        if (isAPIError(error)) {
          const level = error.statusCode >= 500 ? "error" : "warn";
          input.log(level, redactString(`api error ${String(error.statusCode)}: ${error.message}`));
        } else {
          input.log("error", `api error: ${error instanceof Error ? error.name : "unknown"}`);
        }
      },
    },
    emailAndPassword: {
      enabled: true,
      // Not a blocker in this phase (no real mail provider yet).
      requireEmailVerification: false,
      // A new account is not signed in automatically, so sign-up responds identically
      // whether or not the email already exists.
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // Every request checks the database, so sign-out and revocation are immediate.
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        // Never settable through auth input; a request that tries is rejected.
        locale: { type: "string", required: false, input: false },
        isPlatformAdmin: { type: "boolean", required: false, input: false },
      },
    },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: secureCookies,
      // Postgres generates UUID primary keys (gen_random_uuid()).
      database: { generateId: false },
      // Explicit: Better Auth otherwise turns its origin/CSRF checks OFF when NODE_ENV=test.
      disableOriginCheck: false,
      ipAddress:
        input.ipHeader === undefined
          ? { disableIpTracking: true }
          : {
              ipAddressHeaders: [input.ipHeader],
              ...(input.trustedProxies !== undefined && input.trustedProxies.length > 0
                ? { trustedProxies: [...input.trustedProxies] }
                : {}),
            },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
