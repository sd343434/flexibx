import "server-only";

import { getSystemDb } from "../db/client";

export type DependencyStatus = "up" | "down";

const DB_TIMEOUT_MS = 2000;

/** Readiness probe for PostgreSQL (`SELECT 1`, bounded by a timeout). Never throws. */
export async function checkDatabaseHealth(timeoutMs = DB_TIMEOUT_MS): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("database health check timed out"));
      }, timeoutMs);
    });
    await Promise.race([getSystemDb().$queryRaw`SELECT 1`, timeout]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
