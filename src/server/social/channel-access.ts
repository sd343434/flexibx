import type { Prisma } from "@/generated/prisma/client";

import type { Db } from "../db/types";

// Whether a workspace may still act on its Meta Pages, and what happens when it may not.
//
// A channel is only as good as the workspace's own Meta grant: events are accepted,
// drafted (paid in credits) and answered only while that workspace has an ACTIVE,
// unexpired Meta connection. An expired token pauses the channel (nothing is deleted; a
// reconnect resumes it). An explicit loss of authority — the workspace disconnected Meta,
// the person removed the app (deauthorize / data deletion), or the Page is no longer in
// the grant — disables the channel and gives up its automatic-reply claims, so another
// workspace that still manages the Page can answer automatically.

/** Prisma filter on a workspace: it holds a usable Meta grant at `now`. */
export function activeMetaGrant(now: Date): Prisma.WorkspaceWhereInput {
  return {
    adConnections: {
      some: {
        platform: "META",
        status: "ACTIVE",
        tokenCiphertext: { not: null },
        OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: now } }],
      },
    },
  };
}

/** True when the workspace's Meta grant is usable now (guarded client, own workspace). */
export async function hasActiveMetaGrant(db: Db, workspaceId: string, now: Date) {
  const grant = await db.adConnection.findFirst({
    where: {
      workspaceId,
      platform: "META",
      status: "ACTIVE",
      tokenCiphertext: { not: null },
      OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  return grant !== null;
}

/**
 * Disables the workspace's Facebook and Instagram channels (all of them, or the one whose
 * Page is `pageId`) and releases their automatic-reply claims. Run inside the transaction
 * that records the loss of authority. Returns the number of channels disabled.
 */
export async function revokeSocialAccess(
  tx: Db,
  workspaceId: string,
  pageId?: string,
): Promise<number> {
  const scope = { workspaceId, ...(pageId === undefined ? {} : { pageId }) };
  const channels = await tx.socialChannel.findMany({
    where: scope,
    select: { platform: true, externalId: true },
  });
  if (channels.length === 0) return 0;
  const disabled = await tx.socialChannel.updateMany({
    where: { ...scope, enabled: true },
    data: { enabled: false },
  });
  await tx.socialAutoReplyClaim.deleteMany({
    where: {
      workspaceId,
      OR: channels.map((channel) => ({
        platform: channel.platform,
        channelExternalId: channel.externalId,
      })),
    },
  });
  return disabled.count;
}
