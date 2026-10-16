import type { ContentStatus } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";

// Keeps a content item's queued Facebook posts in step with the content's own schedule.
// The publisher picks posts by their own time (SocialPost.scheduledAt), so a change on the
// content — a new time, unscheduling, being marked as published by hand, moving back to a
// draft — must reach the posts still waiting (SCHEDULED) in the same transaction, or the
// post would go out at the old time or after the person withdrew it. Posts in flight
// (PUBLISHING) or unconfirmed (UNCERTAIN) are never touched here: only the publisher and
// the check on the Page settle those.

type Tx = Db;

/** Why waiting posts were cancelled (SocialPost.errorCode). */
export type QueuedPostCancelReason = "unscheduled" | "marked_published" | "content_not_approved";

/** Posts that may be published at any moment, or may already have been. */
export const IN_FLIGHT_POST_STATUSES = ["PUBLISHING", "UNCERTAIN"] as const;

/** Moves the waiting posts of a scheduled content item to its new time. */
export async function moveQueuedPosts(
  tx: Tx,
  ctx: TenantContext,
  contentId: string,
  scheduledAt: Date,
): Promise<number> {
  const { count } = await tx.socialPost.updateMany({
    where: { workspaceId: ctx.workspaceId, contentItemId: contentId, status: "SCHEDULED" },
    data: { scheduledAt, version: { increment: 1 } },
  });
  if (count > 0) {
    await recordAudit(tx, ctx, {
      action: "social.post_rescheduled",
      entityType: "content",
      entityId: contentId,
      metadata: { posts: count, scheduledAt: scheduledAt.toISOString() },
    });
  }
  return count;
}

/** Cancels the waiting posts of a content item that must no longer go out. */
export async function cancelQueuedPosts(
  tx: Tx,
  ctx: TenantContext,
  contentId: string,
  reason: QueuedPostCancelReason,
): Promise<number> {
  const { count } = await tx.socialPost.updateMany({
    where: { workspaceId: ctx.workspaceId, contentItemId: contentId, status: "SCHEDULED" },
    data: { status: "CANCELLED", errorCode: reason, version: { increment: 1 } },
  });
  if (count > 0) {
    await recordAudit(tx, ctx, {
      action: "social.post_cancelled",
      entityType: "content",
      entityId: contentId,
      metadata: { posts: count, reason },
    });
  }
  return count;
}

/**
 * After a workflow transition (already applied): SCHEDULED at a time → waiting posts move
 * to it; back to APPROVED (unscheduled) or marked PUBLISHED by hand or any status that is
 * no longer approved → waiting posts are cancelled with the matching reason.
 */
export async function followContentStatus(
  tx: Tx,
  ctx: TenantContext,
  contentId: string,
  from: ContentStatus,
  to: ContentStatus,
  scheduledAt: Date | null,
): Promise<void> {
  if (to === "SCHEDULED") {
    if (scheduledAt !== null) await moveQueuedPosts(tx, ctx, contentId, scheduledAt);
    return;
  }
  if (to === "APPROVED") {
    // Unscheduled: the person took the time back; posts queued for it must not go out.
    if (from === "SCHEDULED") await cancelQueuedPosts(tx, ctx, contentId, "unscheduled");
    return;
  }
  await cancelQueuedPosts(
    tx,
    ctx,
    contentId,
    to === "PUBLISHED" ? "marked_published" : "content_not_approved",
  );
}

/** Whether a content item has a publication that may be going out (or went out) right now. */
export async function hasPostInFlight(tx: Tx, workspaceId: string, contentId: string) {
  const post = await tx.socialPost.findFirst({
    where: { workspaceId, contentItemId: contentId, status: { in: [...IN_FLIGHT_POST_STATUSES] } },
    select: { id: true },
  });
  return post !== null;
}
