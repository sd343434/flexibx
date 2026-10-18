import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import { DEFAULT_LOCALE } from "@/i18n/config";

import { recordAudit } from "../audit/audit-log";
import { getDb, getSystemDb } from "../db/client";
import type { GuardedPrismaClient } from "../db/prisma";
import { getAdsEnv, getEnv } from "../env";
import { logger } from "../logger";

import {
  deletionConfirmationCode,
  parseMetaSignedRequest,
  type MetaSignedRequest,
} from "./meta-signed-request";
import { revokeInsightsSources } from "../intelligence/insights-access";
import { revokeSocialAccess } from "../social/channel-access";

// Meta's two account-lifecycle callbacks (both required for App Review), for the Meta app
// shared by Meta ads and WhatsApp:
// - deauthorize: the person removed the app in their Facebook settings. Every connection
//   they granted, in every workspace, is revoked and its token erased at once, so no run
//   or sync keeps using a grant that no longer exists (runs re-check before each write).
// - data deletion: the person asked Meta to delete their data. The same revocation, and
//   the Facebook identity Flexibx stored for them (app-scoped id and display name) is
//   erased too. Workspace business data (plans, synced campaign results) belongs to the
//   workspace and is kept; see docs/ADVERTISING.md.

/** Meta platforms whose connections come from the shared Meta app. */
const META_APP_PLATFORMS = ["META", "WHATSAPP"] as const;

export type MetaUserRequestKind = "deauthorize" | "data_deletion";

export interface MetaUserDeps {
  readonly system: PrismaClient;
  readonly db: GuardedPrismaClient;
}

/**
 * Revokes (and for data deletion, de-identifies) every connection this Meta user granted
 * before the request was issued. Each change is conditional on the row still belonging to
 * that user and not having been granted again since, so a reconnect — by another person
 * in the same workspace, or by the same person after removing the app — that lands
 * between the lookup and the update (or a late redelivery of an old callback) is left
 * alone. Connections the workspace had already disconnected keep their own status.
 */
export async function forgetMetaUser(
  deps: MetaUserDeps,
  request: MetaSignedRequest,
  kind: MetaUserRequestKind,
): Promise<{ readonly connections: number }> {
  // A grant newer than the request (lastCheckedAt is set when a grant is stored, and
  // otherwise only when the connection fails) is a fresh consent, not the one removed.
  const grantedBefore =
    request.issuedAt === null
      ? {}
      : {
          OR: [
            { lastCheckedAt: null },
            { lastCheckedAt: { lte: new Date(request.issuedAt * 1000) } },
          ],
        };
  // Cross-workspace lookup by the platform's user id only; each change below is scoped
  // to the connection's own workspace on the guarded client.
  const connections = await deps.system.adConnection.findMany({
    where: { platform: { in: [...META_APP_PLATFORMS] }, externalUserId: request.userId },
    select: { id: true, workspaceId: true, platform: true },
  });
  let changed = 0;
  for (const connection of connections) {
    const { workspaceId } = connection;
    const owned = { workspaceId, id: connection.id, externalUserId: request.userId };
    const done = await deps.db.$transaction(async (tx) => {
      const revoked = await tx.adConnection.updateMany({
        where: { ...owned, ...grantedBefore, status: { not: "REVOKED" } },
        data: {
          status: "REVOKED",
          tokenCiphertext: null,
          tokenExpiresAt: null,
          lastErrorCode: kind === "deauthorize" ? "platform_deauthorized" : "platform_data_deleted",
          version: { increment: 1 },
        },
      });
      // Data deletion also erases the stored identity, whatever the status (a connection
      // disconnected earlier still holds the Facebook id and name).
      const erased =
        kind === "data_deletion"
          ? await tx.adConnection.updateMany({
              where: { ...owned, ...grantedBefore, status: "REVOKED" },
              data: {
                externalUserId: "deleted",
                externalUserName: null,
                tokenCiphertext: null,
                tokenExpiresAt: null,
                version: { increment: 1 },
              },
            })
          : { count: 0 };
      if (revoked.count === 0 && erased.count === 0) return false;
      let channelsDisabled = 0;
      let sourcesDisabled = 0;
      if (revoked.count > 0) {
        await tx.adAccount.updateMany({
          where: { workspaceId, connectionId: connection.id },
          data: { selected: false },
        });
        // The same grant serves the AI Social Manager: its Pages stop receiving, drafting,
        // replying and publishing, and give up their automatic-reply claims.
        if (connection.platform === "META") {
          channelsDisabled = await revokeSocialAccess(tx, workspaceId);
          sourcesDisabled = await revokeInsightsSources(
            tx,
            workspaceId,
            kind === "deauthorize" ? "deauthorized" : "data_deleted",
          );
        }
      }
      await recordAudit(
        tx,
        { workspaceId, userId: null },
        {
          action:
            kind === "deauthorize" ? "ads.platform_deauthorized" : "ads.platform_data_deleted",
          entityType: "ad_connection",
          entityId: connection.id,
          metadata: {
            platform: connection.platform,
            revoked: revoked.count > 0,
            socialChannelsDisabled: channelsDisabled,
            insightsSourcesDisabled: sourcesDisabled,
          },
        },
      );
      return true;
    });
    if (done) changed += 1;
  }
  return { connections: changed };
}

export type MetaCallbackReply =
  | { readonly status: 200; readonly body: Record<string, string> | null }
  | { readonly status: 400 | 503; readonly body: null };

/** POST handler body for both callbacks (form field `signed_request`). */
export async function handleMetaUserCallback(
  kind: MetaUserRequestKind,
  signedRequest: string | null,
): Promise<MetaCallbackReply> {
  const appSecret = getAdsEnv().META_APP_SECRET;
  if (appSecret === undefined) return { status: 503, body: null };
  const request = parseMetaSignedRequest(signedRequest, appSecret);
  if (request === null) {
    logger.warn({ route: `meta.${kind}` }, "Meta signed_request rejected");
    return { status: 400, body: null };
  }
  const { connections } = await forgetMetaUser(
    { system: getSystemDb(), db: getDb() },
    request,
    kind,
  );
  // Counts only: the user id is personal data and is never logged.
  logger.info({ route: `meta.${kind}`, connections }, "Meta user callback processed");
  if (kind === "deauthorize") return { status: 200, body: null };
  const code = deletionConfirmationCode(request, appSecret);
  const url = new URL(`/${DEFAULT_LOCALE}/meta-data-deletion`, getEnv().APP_URL);
  url.searchParams.set("code", code);
  return { status: 200, body: { url: url.toString(), confirmation_code: code } };
}
