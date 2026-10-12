import "server-only";

import { after } from "next/server";
import { z } from "zod";

import { getAiEnv } from "../env";
import { FEATURE_PRICES } from "../billing/pricing";
import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { logger } from "../logger";
import { isUuid } from "../tenancy/context";
import { can } from "../tenancy/permissions";
import { requireWorkspaceAccess } from "../tenancy/access";
import { getAdsEnv } from "../env";

import {
  addRule,
  applyGuidance,
  approveReply,
  assignChannel,
  dismissLesson,
  ignoreInteraction,
  pullRecentComments,
  redraftInteraction,
  rejectReply,
  resolveUncertainReply,
  retryReply,
  runSelfReview,
  saveAgent,
  setAgentActive,
  socialError,
  socialMetrics,
  subscribeChannel,
  syncChannels,
} from "./social-service";
import { cancelPost, queuePost, resolveUncertainPost } from "./publishing";
import { draftCreated, getSocialDeps } from "./social-runtime";

// Server entry points for the AI Social Manager pages: session → membership → permission
// (inside the services). Inputs are bounded here; the services validate them.

const slug = z.string().min(1).max(100);
const id = z.string().min(1).max(100);
const METRICS_WINDOW_MS = 30 * 24 * 3_600_000;

export const INBOX_FILTERS = ["review", "escalated", "attention", "replied", "all"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

const FILTER_STATUSES = {
  review: ["AWAITING_REVIEW", "NEW"],
  escalated: ["ESCALATED"],
  attention: ["UNCERTAIN", "FAILED", "SENDING"],
  replied: ["REPLIED"],
  all: undefined,
} as const;

/** The inbox, channels, agents and the last 30 days' numbers (social.view). */
export async function getSocialPage(workspaceSlug: string, filter: InboxFilter) {
  const ctx = await requireWorkspaceAccess(workspaceSlug, "social.view");
  const db = getDb();
  const statuses = FILTER_STATUSES[filter];
  const [metrics, channels, agents, interactions, connection] = await Promise.all([
    socialMetrics(db, ctx.workspaceId, null, new Date(Date.now() - METRICS_WINDOW_MS)),
    db.socialChannel.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ platform: "asc" }, { name: "asc" }],
      select: {
        id: true,
        platform: true,
        name: true,
        enabled: true,
        subscribed: true,
        agentId: true,
      },
    }),
    db.socialAgent.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, active: true, mode: true, role: true, guidanceVersion: true },
    }),
    db.socialInteraction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(statuses === undefined ? {} : { status: { in: [...statuses] } }),
      },
      orderBy: { receivedAt: "desc" },
      take: 50,
      select: {
        id: true,
        kind: true,
        text: true,
        authorName: true,
        receivedAt: true,
        status: true,
        category: true,
        sentiment: true,
        lastError: true,
        channel: { select: { platform: true, name: true } },
        agent: { select: { name: true } },
        replies: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            draftText: true,
            finalText: true,
            confidence: true,
            needsHuman: true,
            reason: true,
            decision: true,
            sendStatus: true,
            sendError: true,
          },
        },
      },
    }),
    db.adConnection.findFirst({
      where: { workspaceId: ctx.workspaceId, platform: "META" },
      select: { status: true, scopes: true },
    }),
  ]);
  const env = getAdsEnv();
  return {
    metrics,
    channels,
    agents,
    interactions: interactions.map(({ replies, ...rest }) => ({
      ...rest,
      reply: replies[0] ?? null,
    })),
    canReply: can(ctx.role, "social.reply"),
    canManage: can(ctx.role, "social.manage"),
    metaConfigured: env.META_APP_ID !== undefined && env.META_APP_SECRET !== undefined,
    webhookConfigured: env.META_WEBHOOK_VERIFY_TOKEN !== undefined,
    metaConnected: connection?.status === "ACTIVE",
    aiConfigured: getAiEnv().AI_PROVIDER !== "disabled",
    sendingEnabled: env.SOCIAL_SENDING_ENABLED === "true",
    replyPrice: FEATURE_PRICES.social_reply,
    reviewPrice: FEATURE_PRICES.social_learning,
  };
}

/** One agent with what it learned (social.view). */
export async function getAgentPage(workspaceSlug: string, agentId: string) {
  const ctx = await requireWorkspaceAccess(workspaceSlug, "social.view");
  if (!isUuid(agentId)) throw socialError("NOT_FOUND", "social_reply_locked");
  const db = getDb();
  const agent = await db.socialAgent.findFirst({
    where: { workspaceId: ctx.workspaceId, id: agentId },
  });
  if (agent === null) throw socialError("NOT_FOUND", "social_reply_locked");
  const [lessons, metrics] = await Promise.all([
    db.socialLesson.findMany({
      where: { workspaceId: ctx.workspaceId, agentId, status: { in: ["ACTIVE", "PROPOSED"] } },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: {
        id: true,
        kind: true,
        status: true,
        source: true,
        customerText: true,
        draftText: true,
        content: true,
        createdAt: true,
      },
    }),
    socialMetrics(db, ctx.workspaceId, agentId, new Date(Date.now() - METRICS_WINDOW_MS)),
  ]);
  return {
    agent: {
      ...agent,
      faq: Array.isArray(agent.faq) ? (agent.faq as { q: string; a: string }[]) : [],
    },
    lessons,
    metrics,
    canManage: can(ctx.role, "social.manage"),
    reviewPrice: FEATURE_PRICES.social_learning,
  };
}

const agentFields = z.strictObject({
  slug,
  agentId: id.nullable(),
  name: z.string().max(200),
  role: z.string().max(40),
  language: z.string().max(8),
  tone: z.string().max(1000),
  businessInfo: z.string().max(8000),
  faq: z.array(z.strictObject({ q: z.string().max(1000), a: z.string().max(2000) })).max(40),
  policies: z.string().max(6000),
  escalation: z.string().max(3000),
  forbidden: z.string().max(3000),
  mode: z.string().max(10),
  autoCategories: z.array(z.string().max(20)).max(10),
  minConfidence: z.string().max(5),
  dailyAutoCap: z.string().max(6),
});

export const saveAgentAction = withAction({
  name: "social.agent.save",
  input: agentFields,
  handler: async ({ slug: workspace, agentId, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    return saveAgent(getDb(), ctx, agentId, input);
  },
});

export const setAgentActiveAction = withAction({
  name: "social.agent.active",
  input: z.strictObject({ slug, agentId: id, active: z.boolean() }),
  handler: async ({ slug: workspace, agentId, active }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    await setAgentActive(getDb(), ctx, agentId, active);
  },
});

export const syncChannelsAction = withAction({
  name: "social.channels.sync",
  input: z.strictObject({ slug }),
  handler: async ({ slug: workspace }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    return syncChannels(getSocialDeps(), ctx);
  },
});

export const assignChannelAction = withAction({
  name: "social.channel.assign",
  input: z.strictObject({ slug, channelId: id, agentId: id.nullable(), enabled: z.boolean() }),
  handler: async ({ slug: workspace, channelId, agentId, enabled }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    await assignChannel(getDb(), ctx, channelId, agentId, enabled);
  },
});

export const subscribeChannelAction = withAction({
  name: "social.channel.subscribe",
  input: z.strictObject({ slug, channelId: id }),
  handler: async ({ slug: workspace, channelId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    await subscribeChannel(getSocialDeps(), ctx, channelId);
  },
});

export const pullRecentAction = withAction({
  name: "social.channel.pull",
  input: z.strictObject({ slug, channelId: id }),
  handler: async ({ slug: workspace, channelId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.reply");
    const deps = getSocialDeps();
    const created = await pullRecentComments(deps, ctx, channelId);
    if (created.length > 0) {
      after(() =>
        draftCreated(deps, created).catch((error: unknown) => {
          logger.error({ err: error }, "Social drafting after pull failed");
        }),
      );
    }
    return { created: created.length };
  },
});

export const approveReplyAction = withAction({
  name: "social.reply.approve",
  input: z.strictObject({ slug, replyId: id, text: z.string().max(4000).nullable() }),
  handler: async ({ slug: workspace, replyId, text }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.reply");
    return { outcome: await approveReply(getSocialDeps(), ctx, replyId, text) };
  },
});

export const rejectReplyAction = withAction({
  name: "social.reply.reject",
  input: z.strictObject({ slug, replyId: id, reason: z.string().max(1000) }),
  handler: async ({ slug: workspace, replyId, reason }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.reply");
    await rejectReply(getDb(), ctx, replyId, reason);
  },
});

export const ignoreInteractionAction = withAction({
  name: "social.interaction.ignore",
  input: z.strictObject({ slug, interactionId: id }),
  handler: async ({ slug: workspace, interactionId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.reply");
    await ignoreInteraction(getDb(), ctx, interactionId);
  },
});

export const redraftAction = withAction({
  name: "social.interaction.redraft",
  input: z.strictObject({ slug, interactionId: id }),
  handler: async ({ slug: workspace, interactionId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.reply");
    return { outcome: await redraftInteraction(getSocialDeps(), ctx, interactionId) };
  },
});

export const resolveUncertainAction = withAction({
  name: "social.reply.resolve",
  input: z.strictObject({ slug, replyId: id, statement: z.enum(["check", "sent", "not_sent"]) }),
  handler: async ({ slug: workspace, replyId, statement }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.reply");
    return { outcome: await resolveUncertainReply(getSocialDeps(), ctx, replyId, statement) };
  },
});

export const retryReplyAction = withAction({
  name: "social.reply.retry",
  input: z.strictObject({ slug, replyId: id }),
  handler: async ({ slug: workspace, replyId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.reply");
    return { outcome: await retryReply(getSocialDeps(), ctx, replyId) };
  },
});

export const selfReviewAction = withAction({
  name: "social.agent.self_review",
  input: z.strictObject({ slug, agentId: id }),
  handler: async ({ slug: workspace, agentId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    return runSelfReview(getSocialDeps(), ctx, agentId);
  },
});

export const applyGuidanceAction = withAction({
  name: "social.guidance.apply",
  input: z.strictObject({ slug, lessonId: id }),
  handler: async ({ slug: workspace, lessonId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    await applyGuidance(getDb(), ctx, lessonId);
  },
});

export const dismissLessonAction = withAction({
  name: "social.lesson.dismiss",
  input: z.strictObject({ slug, lessonId: id }),
  handler: async ({ slug: workspace, lessonId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    await dismissLesson(getDb(), ctx, lessonId);
  },
});

export const addRuleAction = withAction({
  name: "social.rule.add",
  input: z.strictObject({ slug, agentId: id, rule: z.string().max(1000) }),
  handler: async ({ slug: workspace, agentId, rule }) => {
    const ctx = await requireWorkspaceAccess(workspace, "social.manage");
    await addRule(getDb(), ctx, agentId, rule);
  },
});

// ── Publishing approved content to a Facebook Page ─────────────────────────

/** Pages this content can be published to, and its publications (content.view). */
export async function getContentPublishing(workspaceSlug: string, contentId: string) {
  const ctx = await requireWorkspaceAccess(workspaceSlug, "content.view");
  if (!isUuid(contentId)) return null;
  const db = getDb();
  const [channels, posts] = await Promise.all([
    db.socialChannel.findMany({
      where: { workspaceId: ctx.workspaceId, platform: "FACEBOOK", enabled: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.socialPost.findMany({
      where: { workspaceId: ctx.workspaceId, contentItemId: contentId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        publishedAt: true,
        errorCode: true,
        externalPostId: true,
        channel: { select: { name: true } },
      },
    }),
  ]);
  return { channels, posts, canPublish: can(ctx.role, "content.publish") };
}

export const queuePostAction = withAction({
  name: "social.post.queue",
  input: z.strictObject({ slug, contentId: id, channelId: id }),
  handler: async ({ slug: workspace, contentId, channelId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.publish");
    return queuePost(getSocialDeps(), ctx, contentId, channelId);
  },
});

export const cancelPostAction = withAction({
  name: "social.post.cancel",
  input: z.strictObject({ slug, postId: id }),
  handler: async ({ slug: workspace, postId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.publish");
    await cancelPost(getSocialDeps(), ctx, postId);
  },
});

export const resolvePostAction = withAction({
  name: "social.post.resolve",
  input: z.strictObject({ slug, postId: id }),
  handler: async ({ slug: workspace, postId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.publish");
    return { outcome: await resolveUncertainPost(getSocialDeps(), ctx, postId) };
  },
});
