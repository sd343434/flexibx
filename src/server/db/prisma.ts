import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

import { withTenantGuard } from "./tenant-guard";

// Factory functions (no `server-only`), shared by the app singleton (./client.ts),
// prisma/seed.ts and integration tests. Prisma 7 requires a driver adapter.

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export interface DbBounds {
  /** PostgreSQL cancels any statement running longer than this (session statement_timeout). */
  readonly statementTimeoutMs: number;
  /** Waiting for a pooled connection (including connecting) fails after this. */
  readonly connectionTimeoutMs: number;
  /** Pool size (default 3: a lock connection plus sequential work). */
  readonly maxConnections?: number;
}

/**
 * A client on its own small pool whose statements and connection waits are bounded, for
 * scheduled work that must finish inside a time window. The application's pool
 * (createPrismaClient) is unaffected. Idle-in-transaction time is not limited, so a
 * long-held transaction (e.g. one holding an advisory lock) is not cut off.
 */
export function createBoundedPrismaClient(connectionString: string, bounds: DbBounds) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      statement_timeout: bounds.statementTimeoutMs,
      connectionTimeoutMillis: bounds.connectionTimeoutMs,
      max: bounds.maxConnections ?? 3,
    }),
  });
}

/** Tenant-guarded client: every query on a workspace-owned model must be workspace-scoped. */
export function createGuardedClient(base: PrismaClient) {
  return withTenantGuard(base);
}

export type GuardedPrismaClient = ReturnType<typeof createGuardedClient>;
