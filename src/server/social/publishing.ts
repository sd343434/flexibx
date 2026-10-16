import type { PrismaClient, StorageProvider } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import { isAppError } from "../errors/app-error";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { assertKeyBelongsToWorkspace } from "../storage/storage";

import { activeMetaGrant, hasActiveMetaGrant } from "./channel-access";
import { SocialPlatformError, type ManagedPage, type PagePhoto } from "./meta-social";
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

// ── Images ───────────────────────────────────────────────────────────────────

/** Image types Facebook Page photos accept that content media can hold. */
export const PAGE_PHOTO_TYPES = ["image/jpeg", "image/png"] as const;
/** The longest stored post text (social_posts.message). */
export const MAX_POST_MESSAGE = 10_000;
/** Largest image published with a post (Meta's recommended Page photo limit). */
export const MAX_PAGE_PHOTO_BYTES = 4 * 1024 * 1024;

/** Whether the bytes start with the signature of their declared type (JPEG or PNG). */
export function hasImageSignature(bytes: Uint8Array, contentType: string): boolean {
  const starts = (signature: readonly number[]) =>
    bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
  if (contentType === "image/jpeg") return starts([0xff, 0xd8, 0xff]);
  if (contentType === "image/png") return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return false;
}

/**
 * The image a post of this content carries: its first attached image (position order).
 * null = no image (a text post). A first image Facebook cannot take (type or size) is
 * refused when queuing — never silently dropped.
 */
async function postImage(
  tx: Pick<SocialDeps["db"], "contentItemAsset">,
  workspaceId: string,
  contentId: string,
): Promise<string | null> {
  const first = await tx.contentItemAsset.findFirst({
    where: { workspaceId, contentItemId: contentId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { mediaAsset: { select: { id: true, contentType: true, sizeBytes: true } } },
  });
  if (first === null) return null;
  const image = first.mediaAsset;
  if (!(PAGE_PHOTO_TYPES as readonly string[]).includes(image.contentType)) {
    throw socialError("CONFLICT", "social_image_unsupported", { reason: "type" });
  }
  if (image.sizeBytes > MAX_PAGE_PHOTO_BYTES) {
    throw socialError("CONFLICT", "social_image_unsupported", {
      reason: "size",
      maximum: MAX_PAGE_PHOTO_BYTES,
    });
  }
  return image.id;
}

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
    const text = postOf(content);
    const mediaAssetId = await postImage(tx, ctx.workspaceId, contentId);
    const image = { withImage: mediaAssetId !== null, mediaAssetId };
    // A photo post has no link field: the link goes at the end of the caption (stored as
    // the message, so the caption lookup after a lost answer matches it exactly).
    const { message, link } =
      mediaAssetId === null || text.link === null
        ? text
        : {
            message: text.message.includes(text.link)
              ? text.message
              : `${text.message}\n\n${text.link}`,
            link: null,
          };
    if (message.length > MAX_POST_MESSAGE) {
      throw socialError("CONFLICT", "social_image_unsupported", { reason: "caption" });
    }
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
          ...image,
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
          ...image,
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
      metadata: {
        contentId,
        scheduledAt: scheduledAt.toISOString(),
        withImage: mediaAssetId !== null,
      },
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
  withImage: true,
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
      withImage: true,
      mediaAsset: {
        select: { storageKey: true, storageProvider: true, contentType: true, sizeBytes: true },
      },
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
  // The image is read here, before anything is sent: if it is gone or unreadable the post
  // fails for certain (nothing reached Meta) instead of going out without it.
  let photo: PagePhoto | null = null;
  if (post.withImage) {
    const read = await readPostImage(deps, workspaceId, post.mediaAsset);
    if (typeof read === "string") {
      await finish("FAILED", { errorCode: read });
      return "failed";
    }
    photo = read;
  }
  try {
    if (deps.meta === null) throw new SocialPlatformError("provider_error");
    const externalPostId =
      photo === null
        ? await deps.meta.publishToPage(page, post.message, post.link)
        : await deps.meta.publishPhotoToPage(page, post.message, photo);
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

/**
 * The bytes of a post's image from the workspace's storage, checked again (workspace key,
 * type, size, file signature), or why it cannot be published.
 */
async function readPostImage(
  deps: SocialDeps,
  workspaceId: string,
  asset: {
    readonly storageKey: string;
    readonly storageProvider: StorageProvider;
    readonly contentType: string;
    readonly sizeBytes: number;
  } | null,
): Promise<PagePhoto | "image_missing" | "image_unavailable" | "image_invalid"> {
  if (asset === null) return "image_missing";
  if (
    !(PAGE_PHOTO_TYPES as readonly string[]).includes(asset.contentType) ||
    asset.sizeBytes > MAX_PAGE_PHOTO_BYTES
  ) {
    return "image_invalid";
  }
  if (deps.storage === undefined) return "image_unavailable";
  try {
    assertKeyBelongsToWorkspace(asset.storageKey, workspaceId);
    const service = await deps.storage.forProvider(asset.storageProvider);
    const object = await service.getObject(asset.storageKey, { expectedBytes: asset.sizeBytes });
    if (object === null) return "image_missing";
    const bytes = object.body;
    if (bytes.byteLength > MAX_PAGE_PHOTO_BYTES || !hasImageSignature(bytes, asset.contentType)) {
      return "image_invalid";
    }
    const extension = asset.contentType === "image/png" ? "png" : "jpg";
    return { bytes, contentType: asset.contentType, filename: `image.${extension}` };
  } catch {
    return "image_unavailable";
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
