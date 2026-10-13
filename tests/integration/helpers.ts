import type { PrismaClient } from "@/generated/prisma/client";
import { WorkspaceRole, WorkspaceType } from "@/generated/prisma/enums";
import {
  createGuardedClient,
  createPrismaClient,
  type GuardedPrismaClient,
} from "@/server/db/prisma";
import { createTenantContext, type TenantContext } from "@/server/tenancy/context";

import { resolveTestDatabaseUrl } from "./test-database";

export interface TestDb {
  readonly system: PrismaClient;
  readonly db: GuardedPrismaClient;
}

export function createTestDb(): TestDb {
  const system = createPrismaClient(resolveTestDatabaseUrl());
  return { system, db: createGuardedClient(system) };
}

/** Empties every table. Only ever runs against the guarded `_test` database. */
export async function resetDatabase(system: PrismaClient): Promise<void> {
  await system.$executeRaw`TRUNCATE TABLE sessions, accounts, verifications, rate_limits, audit_logs, workspace_invitations, workspace_members, workspaces, users, system_heartbeats, alert_throttles, ops_check_results RESTART IDENTITY CASCADE`;
}

let counter = 0;

/** Creates a user + workspace + membership and returns the matching tenant context. */
export async function createTenant(
  system: PrismaClient,
  options: { role?: WorkspaceRole; type?: WorkspaceType; parentWorkspaceId?: string } = {},
): Promise<TenantContext & { slug: string }> {
  counter += 1;
  const suffix = `${Date.now().toString(36)}-${counter.toString()}`;
  const user = await system.user.create({
    data: { email: `user-${suffix}@test.flexibx.local`, name: `User ${suffix}` },
  });
  const workspace = await system.workspace.create({
    data: {
      name: `Workspace ${suffix}`,
      slug: `ws-${suffix}`,
      type: options.type ?? WorkspaceType.BUSINESS,
      parentWorkspaceId: options.parentWorkspaceId ?? null,
    },
  });
  const role = options.role ?? WorkspaceRole.OWNER;
  await system.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role },
  });
  return {
    ...createTenantContext({ userId: user.id, workspaceId: workspace.id, role }),
    slug: workspace.slug,
  };
}

/**
 * Test shortcut for `pnpm admin:grant` without the TOTP possession check (tested on its
 * own in admin-grant.test.ts): the same database path — the transaction-local grant marker
 * the users trigger requires. The account must already have a verified email and
 * two-factor on, or the database refuses.
 */
export async function grantPlatformAdminForTest(
  system: PrismaClient,
  userId: string,
): Promise<void> {
  await system.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('flexibx.platform_admin_grant', ${userId}, true)`;
    await tx.user.update({ where: { id: userId }, data: { isPlatformAdmin: true } });
  });
}
