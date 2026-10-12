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

/** Revokes (and for data deletion, de-identifies) every connection this Meta user granted. */
export async function forgetMetaUser(
  deps: MetaUserDeps,
  request: MetaSignedRequest,
  kind: MetaUserRequestKind,
): Promise<{ readonly connections: number }> {
  // Cross-workspace lookup by the platform's user id only; each change below is scoped
  // to the connection's own workspace on the guarded client.
  const connections = await deps.system.adConnection.findMany({
    where: { platform: { in: [...META_APP_PLATFORMS] }, externalUserId: request.userId },
    select: { id: true, workspaceId: true, platform: true },
  });
  for (const connection of connections) {
    const { workspaceId } = connection;
    await deps.db.$transaction(async (tx) => {
      await tx.adConnection.updateMany({
        where: { workspaceId, id: connection.id },
        data: {
          status: "REVOKED",
          tokenCiphertext: null,
          tokenExpiresAt: null,
          lastErrorCode: kind === "deauthorize" ? "platform_deauthorized" : "platform_data_deleted",
          version: { increment: 1 },
          ...(kind === "data_deletion"
            ? { externalUserId: "deleted", externalUserName: null }
            : {}),
        },
      });
      await tx.adAccount.updateMany({
        where: { workspaceId, connectionId: connection.id },
        data: { selected: false },
      });
      await recordAudit(
        tx,
        { workspaceId, userId: null },
        {
          action:
            kind === "deauthorize" ? "ads.platform_deauthorized" : "ads.platform_data_deleted",
          entityType: "ad_connection",
          entityId: connection.id,
          metadata: { platform: connection.platform },
        },
      );
    });
  }
  return { connections: connections.length };
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
