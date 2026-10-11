import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import { getEnv } from "../env";
import {
  createBoundedPrismaClient,
  createGuardedClient,
  createPrismaClient,
  type DbBounds,
  type GuardedPrismaClient,
} from "./prisma";

interface DbSingletons {
  base?: PrismaClient;
  guarded?: GuardedPrismaClient;
  retention?: { system: PrismaClient; db: GuardedPrismaClient };
}

// Reuse clients across hot reloads in development (one connection pool per process).
const globalForDb = globalThis as typeof globalThis & { __flexibxDb?: DbSingletons };
const singletons: DbSingletons = (globalForDb.__flexibxDb ??= {});

function base(): PrismaClient {
  singletons.base ??= createPrismaClient(getEnv().DATABASE_URL);
  return singletons.base;
}

/**
 * The application database client. Tenant-guarded: queries on workspace-owned models
 * without a workspace scope throw. Use this everywhere by default.
 */
export function getDb(): GuardedPrismaClient {
  singletons.guarded ??= createGuardedClient(base());
  return singletons.guarded;
}

/**
 * Clients for the scheduled video retention run only (reviewed call site:
 * src/server/videos/retention-runtime.ts): a separate small pool whose statements and
 * connection waits are bounded (`bounds`, fixed by the first call), so the run cannot
 * outlast its single-flight lock. `system` is UNGUARDED, like getSystemDb(); `db` is
 * the tenant-guarded client on the same pool. Application routes keep the default pool.
 */
export function getBoundedRetentionDb(bounds: DbBounds): {
  system: PrismaClient;
  db: GuardedPrismaClient;
} {
  if (singletons.retention === undefined) {
    const system = createBoundedPrismaClient(getEnv().DATABASE_URL, bounds);
    singletons.retention = { system, db: createGuardedClient(system) };
  }
  return singletons.retention;
}

/**
 * Closes the retention pool, if one was opened. For processes that end after one run
 * (the `pnpm video:retention` CLI). The server keeps the pool for its lifetime and never
 * calls this; a later getBoundedRetentionDb() call would open a new pool.
 */
export async function closeBoundedRetentionDb(): Promise<void> {
  const retention = singletons.retention;
  delete singletons.retention;
  await retention?.system.$disconnect();
}

/**
 * UNGUARDED client for explicitly reviewed system paths only (e.g. listing a user's
 * memberships across workspaces, health checks, future purge jobs). Never pass request
 * input to it without an explicit authorization check.
 */
export function getSystemDb(): PrismaClient {
  return base();
}
