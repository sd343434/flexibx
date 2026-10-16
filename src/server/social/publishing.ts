import type { PrismaClient } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import { isAppError } from "../errors/app-error";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { activeMetaGrant, hasActiveMetaGrant } from "./channel-access";
import { SocialPlatformError, type ManagedPage } from "./meta-social";
import { pageAccessLost, pageFor, socialError, type SocialDeps } from "./social-service";

// Publishing approved content to a Facebook Page at its time. Only APPROVED or SCHEDULED
// content can be queued (content.publish), so the content approval gate stays in front of
// every post; the content is re-checked right before publishing (moved back to a draft →
// cancelled). A post is published once: the claim (SCHEDULED → PUBLISHING) is a
// compare-and-set; a lost answer is UNCERTAIN and is looked up on the Page before anything
// is posted again. The workspace's emergency stop holds every scheduled post.

const nowOf = (deps: { readonly now?: () => Date }) => (deps.now ?? (() => new Date()))();
const notFound = (resource: string) =>
  socialError("NOT_FOUND", "social_reply_locked", { resource });

/** The text and link a content item publishes (its body, else its title; its link). */
export function postOf(content: { title: string; body: string; metadata: unknown }): {
  message: string;
  link: string | null;
} {
  const body = content.body.trim();
  const meta =
    typeof content.metadata === "object" && content.metadata !== null
      ? (content.metadata as Record<string, unknown>)
      : {};
  const link = typeof meta.link === "string" && meta.link.startsWith("https://") ? meta.link : null;
  return { message: body === "" ? content.title : body, link };
}

/**
 * Queues approved content for a Facebook Page: scheduled content at its time, approved
 * content for the next scheduler run (never instantly: the automation tick publishes).
 */
export async function queuePost(
  deps: SocialDeps,
  ctx: TenantContext,
  contentId: string,
  channelId: string,
): Promise<{ readonly postId: string }> {
  assertCan(ctx, "content.publish");
  if (!isUuid(contentId) || !isUuid(channelId)) throw notFound("content");
  const now = nowOf(deps);
  return deps.db.$transaction(async (tx) => {
    const content = await tx.contentItem.findFirst({
      where: { workspaceId: ctx.workspaceId, id: contentId },
      select: {
        id: true,
        status: true,
        title: true,
        body: true,
        metadata: true,
        scheduledAt: true,
      },
    });
    if (content === null) throw notFound("content");
    if (content.status !== "APPROVED" && content.status !== "SCHEDULED") {
      throw socialError("CONFLICT", "social_content_not_approved");
    }
    const channel = await tx.socialChannel.findFirst({
      where: { workspaceId: ctx.workspaceId, id: channelId, platform: "FACEBOOK", enabled: true },
      select: { id: true },
    });
    if (channel === null) throw notFound("social_channel");
    const { message, link } = postOf(content);
    // Only a committed schedule (SCHEDULED) holds the post back; an approved item's planned
    // date is a plan, so queuing it means the next scheduler run.
    const scheduledAt =
      content.status === "SCHEDULED" && content.scheduledAt !== null && content.scheduledAt > now
        ? content.scheduledAt
        : now;
    const existing = await tx.socialPost.findFirst({
      where: { workspaceId: ctx.workspaceId, contentItemId: contentId, channelId },
      select: { id: true, status: true },
    });
    let postId: string;
    if (existing === null) {
      const created = await tx.socialPost.create({
        data: {
          workspaceId: ctx.workspaceId,
          contentItemId: contentId,
          channelId,
          scheduledAt,
          message,
          link,
          requestedByUserId: ctx.userId,
        },
        select: { id: true },
      });
      postId = created.id;
    } else {
      // Queued again only after it was cancelled or failed; never over a live publication.
      const reset = await tx.socialPost.updateMany({
        where: {
          workspaceId: ctx.workspaceId,
          id: existing.id,
          status: { in: ["CANCELLED", "FAILED"] },
        },
        data: {
          status: "SCHEDULED",
          scheduledAt,
          message,
          link,
          errorCode: null,
          requestedByUserId: ctx.userId,
          version: { increment: 1 },
        },
      });
      if (reset.count === 0) throw socialError("CONFLICT", "social_reply_locked");
      postId = existing.id;
    }
    await recordAudit(tx, ctx, {
      action: "social.post_queued",
      entityType: "social_post",
      entityId: postId,
      metadata: { contentId, scheduledAt: scheduledAt.toISOString() },
    });
    return { postId };
  });
}

// ── The publications of one content item (content page) ──────────────────────

/**
 * Posts that still need a person or the scheduler: SCHEDULED and FAILED can be cancelled,
 * UNCERTAIN must be checked on the Page, PUBLISHING is in flight. Always listed in full
 * (never behind a history page). One row per content item and channel
 * (@@unique([contentItemId, channelId])), so this is bounded by the workspace's Pages;
 * OPEN_POSTS_LIMIT only guards the page size, and `openTotal` says when it applied.
 */
export const OPEN_POST_STATUSES = ["SCHEDULED", "PUBLISHING", "UNCERTAIN", "FAILED"] as const;
/** Settled outcomes: history, shown a page at a time. */
export const SETTLED_POST_STATUSES = ["PUBLISHED", "CANCELLED"] as const;
export const OPEN_POSTS_LIMIT = 200;
export const POST_HISTORY_PAGE = 20;

const publicationFields = {
  id: true,
  status: true,
  scheduledAt: true,
  publishedAt: true,
  errorCode: true,
  externalPostId: true,
  createdAt: true,
  channel: { select: { name: true } },
} as const;

/** Newest first; the id breaks ties, so the order is total and pages never overlap. */
const newestFirst = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * The content item's open posts (all of them) and one page of its settled history
 * (content.view). `historyAfter` is the id of the last history row already shown; it is
 * resolved inside this workspace, content item and history only (anything else starts at
 * the newest). Keyset pagination on (createdAt, id): no row is repeated or skipped while
 * rows stay where they are; a post that settles meanwhile appears in history at its own
 * creation time.
 */
export async function listContentPublications(
  db: SocialDeps["db"],
  ctx: TenantContext,
  contentId: string,
  options: { readonly historyAfter?: string; readonly historyLimit?: number } = {},
) {
  assertCan(ctx, "content.view");
  const empty = { open: [], openTotal: 0, history: [], nextHistoryAfter: null };
  if (!isUuid(contentId)) return empty;
  const scope = { workspaceId: ctx.workspaceId, contentItemId: contentId };
  const openWhere = { ...scope, status: { in: [...OPEN_POST_STATUSES] } };
  const settledWhere = { ...scope, status: { in: [...SETTLED_POST_STATUSES] } };
  const after =
    options.historyAfter !== undefined && isUuid(options.historyAfter)
      ? await db.socialPost.findFirst({
          where: { ...settledWhere, id: options.historyAfter },
          select: { id: true, createdAt: true },
        })
      : null;
  const take = Math.min(Math.max(options.historyLimit ?? POST_HISTORY_PAGE, 1), 100);
  const [open, openTotal, rows] = await Promise.all([
    db.socialPost.findMany({
      where: openWhere,
      orderBy: newestFirst,
      take: OPEN_POSTS_LIMIT,
      select: publicationFields,
    }),
    db.socialPost.count({ where: openWhere }),
    db.socialPost.findMany({
      where:
        after === null
          ? settledWhere
          : {
              ...settledWhere,
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            },
      orderBy: newestFirst,
      take: take + 1,
      select: publicationFields,
    }),
  ]);
  const history = rows.slice(0, take);
  return {
    open,
    openTotal,
    history,
    nextHistoryAfter: rows.length > take ? (history.at(-1)?.id ?? null) : null,
  };
}

/** Cancels a post that has not been published (content.publish). */
export async function cancelPost(
  deps: SocialDeps,
  ctx: TenantContext,
  postId: string,
): Promise<void> {
  assertCan(ctx, "content.publish");
  if (!isUuid(postId)) throw notFound("social_post");
  const updated = await deps.db.socialPost.updateMany({
    where: { workspaceId: ctx.workspaceId, id: postId, status: { in: ["SCHEDULED", "FAILED"] } },
    data: { status: "CANCELLED", version: { increment: 1 } },
  });
  if (updated.count === 0) throw socialError("CONFLICT", "social_reply_locked");
}

export type PublishOutcome = "published" | "uncertain" | "failed" | "cancelled" | "skipped";

/** Publishes one due post (scheduler). Claimed once; outcome recorded on post and content. */
export async function publishPost(
  deps: SocialDeps,
  workspaceId: string,
  postId: string,
): Promise<PublishOutcome> {
  const { db } = deps;
  const now = nowOf(deps);
  // The global switch: nothing is published while sending is off on this server.
  if (!deps.sendingEnabled) return "skipped";
  const post = await db.socialPost.findFirst({
    where: { workspaceId, id: postId, status: "SCHEDULED", scheduledAt: { lte: now } },
    select: {
      id: true,
      version: true,
      message: true,
      link: true,
      contentItemId: true,
      requestedByUserId: true,
      scheduledAt: true,
      channel: { select: { pageId: true, enabled: true } },
      contentItem: { select: { status: true } },
    },
  });
  if (post === null) return "skipped";
  // No usable Meta grant: it waits (a reconnect resumes it) — the missed-window rule below
  // stops it from going out days late.
  if (!(await hasActiveMetaGrant(db, workspaceId, now))) return "skipped";
  const policy = await db.automationPolicy.findFirst({
    where: { workspaceId },
    select: { paused: true },
  });
  if (policy?.paused === true) return "skipped";
  const finish = async (
    status: "PUBLISHED" | "UNCERTAIN" | "FAILED" | "CANCELLED",
    extra: { externalPostId?: string; errorCode?: string },
  ) => {
    await db.$transaction(async (tx) => {
      // Only from the state this run saw or claimed: a late answer never overwrites a
      // recovery (stuck → UNCERTAIN) or a requeue that happened meanwhile.
      await tx.socialPost.updateMany({
        where: { workspaceId, id: post.id, status: { in: ["SCHEDULED", "PUBLISHING"] } },
        data: {
          status,
          externalPostId: extra.externalPostId ?? null,
          errorCode: extra.errorCode?.slice(0, 60) ?? null,
          ...(status === "PUBLISHED" ? { publishedAt: now } : {}),
          version: { increment: 1 },
        },
      });
      if (status === "PUBLISHED") {
        // The content went out: its workflow says so (a status change, never a new post).
        await tx.contentItem.updateMany({
          where: { workspaceId, id: post.contentItemId, status: { in: ["APPROVED", "SCHEDULED"] } },
          data: { status: "PUBLISHED", publishedAt: now },
        });
      }
      if (status === "PUBLISHED" || status === "UNCERTAIN") {
        await recordAudit(
          tx,
          { workspaceId, userId: null },
          {
            action: status === "PUBLISHED" ? "social.post_published" : "social.post_uncertain",
            entityType: "social_post",
            entityId: post.id,
            metadata: { contentId: post.contentItemId },
          },
        );
      }
    });
  };

  // The approval may have been withdrawn since the post was queued.
  if (post.contentItem.status !== "APPROVED" && post.contentItem.status !== "SCHEDULED") {
    await finish("CANCELLED", { errorCode: "content_not_approved" });
    return "cancelled";
  }
  if (!post.channel.enabled) {
    await finish("FAILED", { errorCode: "channel_disabled" });
    return "failed";
  }
  // Held too long (an emergency stop, a lost grant, an outage): a person decides again
  // instead of the post going out long after its time.
  if (now.getTime() - post.scheduledAt.getTime() > MAX_PUBLISH_DELAY_MS) {
    await finish("FAILED", { errorCode: "missed_window" });
    return "failed";
  }
  // The approval is part of the claim: withdrawn between the check above and now → no claim.
  const claimed = await db.socialPost.updateMany({
    where: {
      workspaceId,
      id: post.id,
      status: "SCHEDULED",
      version: post.version,
      contentItem: { status: { in: ["APPROVED", "SCHEDULED"] } },
    },
    data: { status: "PUBLISHING", version: { increment: 1 } },
  });
  if (claimed.count === 0) return "skipped";
  let page: ManagedPage;
  try {
    page = await pageFor(deps, workspaceId, post.channel.pageId);
  } catch (error) {
    const code = isAppError(error) ? (error.fields[0]?.code ?? error.code) : "page_unavailable";
    await finish("FAILED", { errorCode: code });
    if (code === "social_page_unavailable") {
      await pageAccessLost(deps, workspaceId, post.channel.pageId);
    }
    return "failed";
  }
  try {
    if (deps.meta === null) throw new SocialPlatformError("provider_error");
    const externalPostId = await deps.meta.publishToPage(page, post.message, post.link);
    await finish("PUBLISHED", { externalPostId });
    return "published";
  } catch (error) {
    const uncertain = !(error instanceof SocialPlatformError) || error.uncertain;
    await finish(uncertain ? "UNCERTAIN" : "FAILED", {
      errorCode: error instanceof SocialPlatformError ? error.kind : "provider_error",
    });
    return uncertain ? "uncertain" : "failed";
  }
}

/** Settles an UNCERTAIN post by looking for it on the Page (content.publish). */
export async function resolveUncertainPost(
  deps: SocialDeps,
  ctx: TenantContext,
  postId: string,
): Promise<"published" | "not_published"> {
  assertCan(ctx, "content.publish");
  if (!isUuid(postId)) throw notFound("social_post");
  const post = await deps.db.socialPost.findFirst({
    where: { workspaceId: ctx.workspaceId, id: postId, status: "UNCERTAIN" },
    select: {
      id: true,
      message: true,
      scheduledAt: true,
      updatedAt: true,
      contentItemId: true,
      channel: { select: { pageId: true } },
    },
  });
  if (post === null) throw socialError("CONFLICT", "social_reply_locked");
  if (deps.meta === null) throw socialError("SERVICE_UNAVAILABLE", "social_not_configured");
  const page = await pageFor(deps, ctx.workspaceId, post.channel.pageId);
  const since = post.scheduledAt < post.updatedAt ? post.scheduledAt : post.updatedAt;
  const lookup = await deps.meta.findPagePost(page, post.message, since);
  // More posts than one lookup reads: still unknown, so it stays UNCERTAIN (never "not
  // published" on a partial look, which would allow publishing it twice).
  if (lookup === "unknown") throw socialError("CONFLICT", "social_cannot_verify");
  const found = lookup === "not_found" ? null : lookup.id;
  const now = nowOf(deps);
  await deps.db.$transaction(async (tx) => {
    await tx.socialPost.updateMany({
      where: { workspaceId: ctx.workspaceId, id: post.id, status: "UNCERTAIN" },
      data:
        found === null
          ? { status: "FAILED", errorCode: "not_published_confirmed", version: { increment: 1 } }
          : {
              status: "PUBLISHED",
              externalPostId: found,
              publishedAt: now,
              errorCode: null,
              version: { increment: 1 },
            },
    });
    if (found !== null) {
      await tx.contentItem.updateMany({
        where: {
          workspaceId: ctx.workspaceId,
          id: post.contentItemId,
          status: { in: ["APPROVED", "SCHEDULED"] },
        },
        data: { status: "PUBLISHED", publishedAt: now },
      });
    }
  });
  return found === null ? "not_published" : "published";
}

/** A scheduled post not published within this long after its time is not published. */
export const MAX_PUBLISH_DELAY_MS = 24 * 3_600_000;

/** Posts claimed this long ago without an outcome are treated as uncertain. */
export const STUCK_PUBLISH_MS = 10 * 60_000;

/** Due posts across workspaces (scheduler; reviewed system path in social-runtime). */
export async function duePosts(system: PrismaClient, now: Date, limit: number) {
  // Only posts that can go out now: a paused workspace or a lost grant would be skipped
  // without changing state, and must not hold the head of the queue. (A disabled channel
  // stays listed: publishPost fails the post visibly instead of leaving it scheduled.)
  return system.socialPost.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: now },
      workspace: {
        deletedAt: null,
        automationPolicy: { isNot: { paused: true } },
        ...activeMetaGrant(now),
      },
    },
    orderBy: { scheduledAt: "asc" },
    take: limit,
    select: { id: true, workspaceId: true },
  });
}
