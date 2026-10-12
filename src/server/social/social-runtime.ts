import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import { adTokenKey, getAdAdapters } from "../ads/registry";
import { getDb, getSystemDb } from "../db/client";
import { getAdsEnv } from "../env";
import { logger } from "../logger";
import { getAiRuntimeForAutomation } from "../orchestration/runtime";
import { verifyChallenge, verifySignature } from "../whatsapp/webhook";

import { createMetaSocial, type MetaSocial } from "./meta-social";
import {
  draftInteraction,
  ingestEvents,
  MAX_DRAFT_ATTEMPTS,
  runSelfReview,
  SELF_REVIEW_THRESHOLD,
  sendReply,
  type SocialDeps,
} from "./social-service";
import { duePosts, publishPost, STUCK_PUBLISH_MS } from "./publishing";
import { parseSocialWebhook } from "./webhook";

// Wiring of the AI Social Manager: this deployment's Meta app and AI provider, the signed
// Page/Instagram webhook, and the sweep the scheduler tick runs.
//
// SYSTEM PATH (reviewed): the webhook carries no workspace (channels are found by the
// Page/Instagram id), and the sweep selects due work across workspaces; every row is then
// read and written through the guarded client with its own workspace id.

export const MAX_SOCIAL_WEBHOOK_BYTES = 1024 * 1024;
/** A send claimed this long ago without an answer is treated as uncertain. */
export const STUCK_SEND_MS = 10 * 60_000;
/** A decided reply not sent after this long (lost after()) is sent by the sweep. */
export const UNSENT_GRACE_MS = 2 * 60_000;

export function metaSocialFromEnv(): MetaSocial | null {
  const env = getAdsEnv();
  if (env.META_APP_ID === undefined || env.META_APP_SECRET === undefined) return null;
  return createMetaSocial({ appSecret: env.META_APP_SECRET, version: env.META_GRAPH_VERSION });
}

export function getSocialDeps(): SocialDeps {
  const db = getDb();
  return {
    db,
    ads: { db, adapters: getAdAdapters(), tokenKey: adTokenKey() },
    meta: metaSocialFromEnv(),
    ai: getAiRuntimeForAutomation(),
  };
}

export interface SocialWebhookReply {
  readonly status: number;
  readonly body: string;
  /** New interactions to draft (after the answer is sent). */
  readonly created: readonly { readonly workspaceId: string; readonly id: string }[];
}

/** The subscription check (GET hub.challenge). */
export function answerSocialVerification(params: URLSearchParams): {
  status: number;
  body: string;
} {
  const challenge = verifyChallenge(params, getAdsEnv().META_WEBHOOK_VERIFY_TOKEN);
  return challenge === null ? { status: 403, body: "forbidden" } : { status: 200, body: challenge };
}

/** A notification (POST): nothing is parsed before the HMAC of the raw body is verified. */
export async function handleSocialNotification(
  raw: Uint8Array,
  signature: string | null,
): Promise<SocialWebhookReply> {
  const env = getAdsEnv();
  if (env.META_APP_SECRET === undefined || env.META_WEBHOOK_VERIFY_TOKEN === undefined) {
    return { status: 503, body: "not configured", created: [] };
  }
  if (raw.byteLength > MAX_SOCIAL_WEBHOOK_BYTES)
    return { status: 413, body: "too large", created: [] };
  if (!verifySignature(raw, signature, env.META_APP_SECRET)) {
    logger.warn({ route: "meta.webhook" }, "Meta webhook signature rejected");
    return { status: 401, body: "invalid signature", created: [] };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return { status: 400, body: "invalid payload", created: [] };
  }
  const events = parseSocialWebhook(payload, new Date());
  if (events === null) return { status: 200, body: "ignored", created: [] };
  const created = await ingestEvents(getSystemDb(), getDb(), events);
  // Counts only: no ids, names or text in the logs.
  logger.info(
    { route: "meta.webhook", events: events.length, created: created.length },
    "Meta webhook processed",
  );
  return { status: 200, body: "ok", created };
}

/** Drafts replies for new interactions (each in its own try: one failure stops nothing). */
export async function draftCreated(
  deps: SocialDeps,
  created: readonly { readonly workspaceId: string; readonly id: string }[],
): Promise<void> {
  for (const row of created) {
    try {
      await draftInteraction(deps, row.workspaceId, row.id);
    } catch (error) {
      logger.error({ err: error, interactionId: row.id }, "Social draft failed");
    }
  }
}

export interface SocialSweepSummary {
  readonly published: number;
  readonly drafted: number;
  readonly sent: number;
  readonly uncertain: number;
  readonly reviewed: number;
}

/**
 * The scheduler's social work: draft interactions left NEW (a lost after(), a credits
 * refusal that may have cleared), send decided replies that never went out, mark sends
 * stuck in SENDING as UNCERTAIN, and run an agent's self-review once enough feedback
 * accumulated (the proposal still waits for a person).
 */
export async function socialSweep(
  deps: SocialDeps,
  system: PrismaClient = getSystemDb(),
  now: Date = new Date(),
  limit = 25,
): Promise<SocialSweepSummary> {
  // Scheduled Page posts that are due (each claimed once; the emergency stop holds them).
  let published = 0;
  for (const post of await duePosts(system, now, limit)) {
    try {
      const atSweepTime = { ...deps, now: () => now };
      if ((await publishPost(atSweepTime, post.workspaceId, post.id)) === "published") {
        published += 1;
      }
    } catch (error) {
      logger.error({ err: error, postId: post.id }, "Scheduled post failed");
    }
  }

  // A publication claimed but never finished (the process stopped mid-call): it may be on
  // the Page, so it becomes UNCERTAIN and is looked up there, never published again blindly.
  const stuckPosts = await system.socialPost.findMany({
    where: {
      status: "PUBLISHING",
      updatedAt: { lt: new Date(now.getTime() - STUCK_PUBLISH_MS) },
    },
    take: limit,
    select: { id: true, workspaceId: true },
  });
  for (const row of stuckPosts) {
    try {
      await deps.db.socialPost.updateMany({
        where: { workspaceId: row.workspaceId, id: row.id, status: "PUBLISHING" },
        data: { status: "UNCERTAIN", errorCode: "no_answer", version: { increment: 1 } },
      });
    } catch (error) {
      logger.error({ err: error, postId: row.id }, "Stuck post recovery failed");
    }
  }

  const due = await system.socialInteraction.findMany({
    where: {
      status: { in: ["NEW", "FAILED"] },
      draftAttempts: { lt: MAX_DRAFT_ATTEMPTS },
      // NULL is not "not in" a list in SQL: no error yet must be listed explicitly.
      OR: [
        { lastError: null },
        { lastError: { notIn: ["window_closed", "not_sent_confirmed", "agent_delegate_missing"] } },
      ],
      receivedAt: { gte: new Date(now.getTime() - 2 * 24 * 3_600_000) },
      agent: { active: true },
      replies: { none: {} },
      workspace: { deletedAt: null },
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true, workspaceId: true },
  });
  let drafted = 0;
  for (const row of due) {
    try {
      const outcome = await draftInteraction(deps, row.workspaceId, row.id);
      if (outcome !== "skipped" && outcome !== "failed") drafted += 1;
    } catch (error) {
      logger.error({ err: error, interactionId: row.id }, "Social sweep draft failed");
    }
  }

  const unsent = await system.socialReply.findMany({
    where: {
      decision: { in: ["APPROVED", "EDITED", "AUTO"] },
      sendStatus: "NOT_SENT",
      decidedAt: { lt: new Date(now.getTime() - UNSENT_GRACE_MS) },
      workspace: { deletedAt: null },
    },
    take: limit,
    select: { id: true, workspaceId: true },
  });
  let sent = 0;
  for (const row of unsent) {
    try {
      if ((await sendReply(deps, row.workspaceId, row.id, null)) === "sent") sent += 1;
    } catch (error) {
      logger.error({ err: error, replyId: row.id }, "Social sweep send failed");
    }
  }

  const stuck = await system.socialReply.findMany({
    where: { sendStatus: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_SEND_MS) } },
    take: limit,
    select: { id: true, workspaceId: true, interactionId: true },
  });
  for (const row of stuck) {
    try {
      await deps.db.$transaction(async (tx) => {
        await tx.socialReply.updateMany({
          where: { workspaceId: row.workspaceId, id: row.id, sendStatus: "SENDING" },
          data: { sendStatus: "UNCERTAIN", sendError: "no_answer" },
        });
        await tx.socialInteraction.updateMany({
          where: { workspaceId: row.workspaceId, id: row.interactionId, status: "SENDING" },
          data: { status: "UNCERTAIN", lastError: "no_answer" },
        });
      });
    } catch (error) {
      logger.error({ err: error, replyId: row.id }, "Stuck send recovery failed");
    }
  }

  // Self-review: active agents with enough new feedback and no proposal waiting.
  const agents = await system.socialAgent.findMany({
    where: {
      active: true,
      workspace: { deletedAt: null },
      lessons: { none: { kind: "GUIDANCE", status: "PROPOSED" } },
    },
    take: limit,
    select: { id: true, workspaceId: true, delegateUserId: true },
  });
  let reviewed = 0;
  for (const agent of agents) {
    const last = await deps.db.socialLesson.findFirst({
      where: { workspaceId: agent.workspaceId, agentId: agent.id, kind: "GUIDANCE" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const feedback = await deps.db.socialLesson.count({
      where: {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        status: "ACTIVE",
        OR: [{ kind: "RULE" }, { kind: "EXAMPLE", source: "edit" }],
        ...(last === null ? {} : { createdAt: { gt: last.createdAt } }),
      },
    });
    if (feedback < SELF_REVIEW_THRESHOLD || agent.delegateUserId === null) continue;
    const membership = await deps.db.workspaceMember.findFirst({
      where: { workspaceId: agent.workspaceId, userId: agent.delegateUserId },
      select: { role: true },
    });
    if (membership === null) continue;
    try {
      await runSelfReview(
        deps,
        { workspaceId: agent.workspaceId, userId: agent.delegateUserId, role: membership.role },
        agent.id,
      );
      reviewed += 1;
    } catch (error) {
      // Not allowed any more, no credits, AI unavailable: tried again on a later tick.
      logger.warn({ err: error, agentId: agent.id }, "Social self-review skipped");
    }
  }
  return { published, drafted, sent, uncertain: stuck.length, reviewed };
}
