import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

import { withTenantGuard } from "./tenant-guard";

// Factory functions (no `server-only`), shared by the app singleton (./client.ts),
// prisma/seed.ts and integration tests. Prisma 7 requires a driver adapter.

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** Tenant-guarded client: every query on a workspace-owned model must be workspace-scoped. */
export function createGuardedClient(base: PrismaClient) {
  return withTenantGuard(base);
}

export type GuardedPrismaClient = ReturnType<typeof createGuardedClient>;
