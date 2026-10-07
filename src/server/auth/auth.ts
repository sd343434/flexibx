import "server-only";

import { getSystemDb } from "../db/client";
import { getAuthEnv, getEnv } from "../env";
import { logger } from "../logger";

import { createAuth, type Auth } from "./auth-config";
import { hasSessionCookie, refreshSessionCookies } from "./session-refresh";

let instance: Auth | undefined;

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
      isProduction: env.NODE_ENV === "production",
      ipHeader: authEnv.AUTH_IP_HEADER,
      trustedProxies: authEnv.AUTH_TRUSTED_PROXIES,
      log: (level, message) => {
        authLogger[level]({ event: "auth.library" }, message);
      },
    });
  }
  return instance;
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
