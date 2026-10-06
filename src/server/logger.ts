import "server-only";

import pino, { type Logger } from "pino";

import { redactSecrets } from "./redact";

export type { Logger } from "pino";

function resolveLevel(): string {
  const level = process.env.LOG_LEVEL?.trim();
  if (level !== undefined && level !== "") return level;
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

/**
 * Structured JSON logger. Every log object passes through `redactSecrets`, so secret
 * keys (password, token, cookie, authorization, …) and credentials embedded in URLs
 * never reach log output. For readable local output: `pnpm dev:pretty`.
 */
export const logger: Logger = pino({
  level: resolveLevel(),
  base: { service: "flexibx-web" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    log: (object) => redactSecrets(object) as Record<string, unknown>,
  },
  serializers: {
    err: (error: unknown) => redactSecrets(error),
  },
});

export function createRequestLogger(context: { requestId: string; route: string; method: string }) {
  return logger.child(context);
}
