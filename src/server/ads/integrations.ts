import "server-only";

import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan, can } from "../tenancy/permissions";

import type { AdAdapters } from "./adapter";
import { ACCESS_LOST } from "./connections";
import { AD_PLATFORMS, type AdPlatform } from "./model";

// The Integrations overview: for each platform Flexibx supports, whether this deployment
// can offer it (Flexibx's own developer app is configured), and THIS workspace's own
// connection — status, who connected it, granted permissions, expiry, last error — and
// its accounts (seen, selected, no longer granted). Connections, tokens and accounts are
// per workspace: nothing here is read from, or shared with, another workspace. Tokens and
// ciphertexts are never selected.

export interface IntegrationRow {
  readonly platform: AdPlatform;
  readonly available: boolean;
  readonly reason: "not_configured" | "not_implemented" | null;
  readonly capabilities: Readonly<Record<string, boolean>> | null;
  readonly connection: {
    readonly status: "ACTIVE" | "EXPIRED" | "REVOKED" | "ERROR";
    readonly externalUserName: string | null;
    readonly scopes: readonly string[];
    readonly tokenExpiresAt: Date | null;
    readonly lastErrorCode: string | null;
    readonly updatedAt: Date;
    readonly connectedByName: string | null;
  } | null;
  readonly accounts: {
    readonly total: number;
    readonly selected: number;
    readonly accessLost: number;
  };
}

export async function getIntegrationsOverview(
  db: Db,
  ctx: TenantContext,
  adapters: AdAdapters,
): Promise<{ readonly platforms: IntegrationRow[]; readonly canManage: boolean }> {
  assertCan(ctx, "ads.view");
  const [connections, accounts] = await Promise.all([
    db.adConnection.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: {
        platform: true,
        status: true,
        externalUserName: true,
        scopes: true,
        tokenExpiresAt: true,
        lastErrorCode: true,
        updatedAt: true,
        connectedBy: { select: { name: true } },
      },
    }),
    db.adAccount.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { platform: true, selected: true, syncErrorCode: true },
    }),
  ]);
  return {
    canManage: can(ctx.role, "ads.manage"),
    platforms: AD_PLATFORMS.map((platform) => {
      const entry = adapters[platform];
      const connection = connections.find((row) => row.platform === platform) ?? null;
      const own = accounts.filter((account) => account.platform === platform);
      return {
        platform,
        available: entry.available,
        reason: entry.available ? null : entry.reason,
        capabilities: entry.available ? { ...entry.adapter.capabilities } : null,
        connection:
          connection === null
            ? null
            : {
                status: connection.status,
                externalUserName: connection.externalUserName,
                scopes: connection.scopes,
                tokenExpiresAt: connection.tokenExpiresAt,
                lastErrorCode: connection.lastErrorCode,
                updatedAt: connection.updatedAt,
                connectedByName: connection.connectedBy?.name ?? null,
              },
        accounts: {
          total: own.length,
          selected: own.filter((account) => account.selected).length,
          accessLost: own.filter((account) => account.syncErrorCode === ACCESS_LOST).length,
        },
      };
    }),
  };
}
