import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthEndpoint, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";

import type { PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";

import type { Mailer, MailMessage } from "../mail/mailer";
import { redactString } from "../redact";

import { betterAuthCustomRules, RATE_LIMIT_CHECKPOINT_PREFIX } from "./rate-limit-policy";

// Pure factory (no `server-only`), so integration tests can build the exact production
// configuration. Application code uses `getAuth()` from ./auth.

/** Cookie names are `flexibx.session_token` (`__Secure-flexibx.…` when secure). */
export const AUTH_COOKIE_PREFIX = "flexibx";

/** 7-day sessions, extended ("rolled") at most once per day while in use. */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Email-verification links (stateless signed tokens) and reset tokens: one hour. */
export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60;
export const PASSWORD_RESET_EXPIRES_IN_SECONDS = 60 * 60;

/**
 * Better Auth endpoints that are NOT exposed over HTTP. Every email/password flow —
 * sign-up, sign-in, verification, reset, password change — runs only through Flexibx
 * server code (src/server/auth/credentials.ts, account-security.ts), which passes the
 * rate-limit checkpoint first and returns generic results, so the public surface never
 * reveals whether an email is registered. Server-side `auth.api.*` calls are unaffected.
 * `/verify-password` (unused by Flexibx) would otherwise let a session holder check
 * current-password guesses outside the change-password limit: its `scope: "server"`
 * metadata is not enforced by Better Auth's router.
 */
export const DISABLED_HTTP_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/request-password-reset",
  "/reset-password",
  "/verify-email",
  "/send-verification-email",
  "/change-password",
  "/verify-password",
] as const;

/**
 * Paths under Better Auth's base path that the public HTTP route must never serve
 * (src/app/api/auth/[...all]/route.ts): the internal limiter checkpoint, and the reset
 * callback `/reset-password/:token`, whose dynamic path `disabledPaths` cannot list.
 */
export function isInternalOnlyAuthPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const path = decoded
    .replace(/[\\/]+/g, "/")
    .toLowerCase()
    .replace(/^\/api\/auth/, "");
  return (
    path === RATE_LIMIT_CHECKPOINT_PREFIX ||
    path.startsWith(`${RATE_LIMIT_CHECKPOINT_PREFIX}/`) ||
    path.startsWith("/reset-password/")
  );
}

/**
 * The limiter checkpoint (see rate-limit-policy.ts): no-op endpoints whose only job is
 * to be counted by Better Auth's rate limiter. Reached only through `auth.handler` from
 * server code; the public route refuses the path.
 */
function rateLimitCheckpoint(): BetterAuthPlugin {
  const ok = () => ({ ok: true as const });
  return {
    id: "flexibx-rate-limit",
    endpoints: {
      flexibxRateLimitIp: createAuthEndpoint(
        `${RATE_LIMIT_CHECKPOINT_PREFIX}/:bucket`,
        { method: "POST", metadata: { isAction: false } },
        (ctx) => Promise.resolve(ctx.json(ok())),
      ),
      flexibxRateLimitSubject: createAuthEndpoint(
        `${RATE_LIMIT_CHECKPOINT_PREFIX}/:bucket/:subject`,
        { method: "POST", metadata: { isAction: false } },
        (ctx) => Promise.resolve(ctx.json(ok())),
      ),
    },
  };
}

/**
 * The locale of an email link. Flexibx passes `/{locale}` as Better Auth's callback URL;
 * Better Auth embeds it in the URL handed to the email callbacks.
 */
export function localeFromAuthUrl(url: string): Locale {
  try {
    const callback = new URL(url).searchParams.get("callbackURL") ?? "";
    const segment = callback.split("/")[1];
    return isLocale(segment) ? segment : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * An email link to a Flexibx page, built from APP_URL. The token travels in the URL
 * fragment (`#token=…`), which browsers never send to the server: it stays out of
 * request logs, proxies and Referer headers. The page reads it client-side.
 */
export function accountLink(
  appUrl: string,
  locale: Locale,
  page: "verify-email" | "reset-password",
  token: string,
): string {
  const url = new URL(`/${locale}/${page}`, appUrl);
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

export type SecurityEventAction =
  "user.email_verified" | "user.password_reset_requested" | "user.password_reset";

export type AuthLogLevel = "debug" | "info" | "warn" | "error";

export interface AuthConfigInput {
  /** The SYSTEM (unguarded) Prisma client: auth tables are global, not workspace-owned. */
  readonly db: PrismaClient;
  readonly secret: string;
  /** Public origin of the app (APP_URL); also the only trusted origin. */
  readonly baseURL: string;
  /** APP_URL: the origin of every link in an email. */
  readonly appUrl: string;
  readonly isProduction: boolean;
  /**
   * Email verification policy (decision C6): when true, an account cannot sign in until
   * its email is verified. Resolved from AUTH_REQUIRE_EMAIL_VERIFICATION (default: true
   * in production, false otherwise).
   */
  readonly requireEmailVerification: boolean;
  readonly mailer: Mailer;
  /** Records a security event (audit). Must not throw; failures are logged by the caller. */
  readonly onSecurityEvent: (action: SecurityEventAction, userId: string) => Promise<void>;
  /** Trusted client-IP header; undefined = do not trust or record any client IP. */
  readonly ipHeader?: string | undefined;
  readonly trustedProxies?: readonly string[] | undefined;
  /** Receives Better Auth's log messages (message text only, redacted). */
  readonly log: (level: AuthLogLevel, message: string) => void;
}

export function createAuth(input: AuthConfigInput) {
  const secureCookies = input.isProduction || input.baseURL.startsWith("https://");

  /**
   * Sends an account email. Never throws: Better Auth calls these callbacks only for
   * existing accounts, so a failure that surfaced would reveal that the account exists
   * (decision 9). Without a provider in production the mailer fails explicitly; that is
   * logged (template only — never the link, token or address) and nothing claims the
   * email was sent.
   */
  const sendAccountEmail = async (message: MailMessage) => {
    try {
      await input.mailer.send(message);
    } catch (error) {
      input.log(
        "warn",
        `account email not sent (${message.template}): ${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  };
  const securityEvent = async (action: SecurityEventAction, userId: string) => {
    try {
      await input.onSecurityEvent(action, userId);
    } catch (error) {
      input.log(
        "error",
        `security event not recorded (${action}): ${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  };

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
    plugins: [rateLimitCheckpoint(), nextCookies()],
    telemetry: { enabled: false },
    // Better Auth's limiter (decision C8), on for every environment, counting in the
    // `rate_limits` table. Keys use the trusted client IP (`advanced.ipAddress` below).
    // Flexibx's own entry points reach it through the checkpoint endpoints; the rules
    // live in rate-limit-policy.ts. Better Auth's defaults cover its other HTTP paths.
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: betterAuthCustomRules(),
    },
    // Reset tokens are stored as SHA-256 hashes, never in plain text.
    verification: { storeIdentifier: "hashed" },
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
    emailVerification: {
      // Stateless, signed (HS256, AUTH_SECRET), expiring tokens: nothing is stored.
      expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url, token }) => {
        const locale = localeFromAuthUrl(url);
        await sendAccountEmail({
          to: user.email,
          locale,
          template: "email_verification",
          data: {
            name: user.name,
            url: accountLink(input.appUrl, locale, "verify-email", token),
            expiresInMinutes: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS / 60,
          },
        });
      },
      afterEmailVerification: async (user) => {
        await securityEvent("user.email_verified", user.id);
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: input.requireEmailVerification,
      // A new account is not signed in automatically, so sign-up responds identically
      // whether or not the email already exists.
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // A reset deletes every session of the account (decision C7).
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_EXPIRES_IN_SECONDS,
      sendResetPassword: async ({ user, url, token }) => {
        const locale = localeFromAuthUrl(url);
        await securityEvent("user.password_reset_requested", user.id);
        await sendAccountEmail({
          to: user.email,
          locale,
          template: "password_reset",
          data: {
            name: user.name,
            url: accountLink(input.appUrl, locale, "reset-password", token),
            expiresInMinutes: PASSWORD_RESET_EXPIRES_IN_SECONDS / 60,
          },
        });
      },
      onPasswordReset: async ({ user }) => {
        await securityEvent("user.password_reset", user.id);
      },
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
      // Only the configured header is read (decision 8). Without one, no header is
      // trusted at all — not even `X-Forwarded-For` — and the limiter falls back to
      // Better Auth's single shared bucket per path ("no-trusted-ip"; 127.0.0.1 in
      // development and test).
      ipAddress:
        input.ipHeader === undefined
          ? { ipAddressHeaders: [] }
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
