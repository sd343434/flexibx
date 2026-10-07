import "server-only";

import { getSystemDb } from "../db/client";
import { getAuthEnv, getEnv } from "../env";
import { logger } from "../logger";

import { createAuth, type Auth } from "./auth-config";

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
