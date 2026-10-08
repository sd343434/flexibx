import "server-only";

import { recordAudit } from "../audit/audit-log";
import { getDb, getSystemDb } from "../db/client";
import { getAuthEnv, getEnv } from "../env";
import { resolveEmailVerificationRequired } from "../env-schema";
import { logger } from "../logger";
import { getMailer } from "../mail";

import { createAuth, type Auth } from "./auth-config";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { hasSessionCookie, refreshSessionCookies } from "./session-refresh";

let instance: Auth | undefined;
let limiter: RateLimiter | undefined;

/**
 * The application's Better Auth instance, created on first use so `next build` needs no
 * secrets. Uses the system client: auth tables are global and never workspace-scoped.
 */
export function getAuth(): Auth {
  if (instance === undefined) {
    const env = getEnv();
    const authEnv = getAuthEnv();
    const authLogger = logger.child({ module: "auth" });
    instance = createAuth({
      db: getSystemDb(),
      secret: authEnv.AUTH_SECRET,
      baseURL: env.AUTH_URL ?? env.APP_URL,
      appUrl: env.APP_URL,
      isProduction: env.NODE_ENV === "production",
      mailer: getMailer(),
      // Platform-level audit entries (no workspace), on the guarded client.
      onSecurityEvent: async (action, userId) => {
        await recordAudit(
          getDb(),
          { workspaceId: null, userId },
          { action, entityType: "user", entityId: userId },
        );
      },
      ipHeader: authEnv.AUTH_IP_HEADER,
      trustedProxies: authEnv.AUTH_TRUSTED_PROXIES,
      log: (level, message) => {
        authLogger[level]({ event: "auth.library" }, message);
      },
    });
  }
  return instance;
}

/** Email verification policy for this process (decision C6). */
export function isEmailVerificationRequired(): boolean {
  return resolveEmailVerificationRequired(
    getEnv().NODE_ENV,
    getAuthEnv().AUTH_REQUIRE_EMAIL_VERIFICATION,
  );
}

/** The limiter checkpoint for Flexibx's authentication entry points (rate-limit.ts). */
export function getRateLimiter(): RateLimiter {
  if (limiter === undefined) {
    const env = getEnv();
    const authEnv = getAuthEnv();
    limiter = createRateLimiter(getAuth(), {
      secret: authEnv.AUTH_SECRET,
      baseURL: env.AUTH_URL ?? env.APP_URL,
      ipHeader: authEnv.AUTH_IP_HEADER,
    });
  }
  return limiter;
}

/**
 * For the proxy: the session `Set-Cookie` values to attach to a page response so the
 * browser cookie rolls with the database session (Server Components cannot write
 * cookies). Fails open — a refresh problem never blocks a page; access checks happen
 * later in the page itself. Only the error class name is logged.
 */
export async function refreshSessionCookiesForRequest(
  cookieHeader: string | null,
): Promise<string[]> {
  if (!hasSessionCookie(cookieHeader)) return [];
  try {
    const env = getEnv();
    return await refreshSessionCookies(getAuth(), cookieHeader, env.AUTH_URL ?? env.APP_URL);
  } catch (error) {
    logger.warn(
      {
        event: "auth.session_refresh_failed",
        error: error instanceof Error ? error.name : "unknown",
      },
      "Session cookie refresh skipped",
    );
    return [];
  }
}
