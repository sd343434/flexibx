import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import { adTokenKey, getAdAdapters } from "../ads/registry";
import { getDb, getSystemDb } from "../db/client";
import { getAdsEnv } from "../env";
import { logger } from "../logger";
import { getStorageRouter } from "../storage/providers";
import { getAiRuntimeForAutomation } from "../orchestration/runtime";
import { verifyChallenge, verifySignature } from "../whatsapp/webhook";

import { activeMetaGrant } from "./channel-access";
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

/**
 * SOCIAL_SENDING_ENABLED: the server-wide switch for everything that reaches a customer or
 * a Page — comment replies, Page messages, Page publishing — from every path (a person
 * approving or retrying, AUTO agents, the scheduler). Off unless "true", like
 * ADS_EXECUTION_ENABLED and WHATSAPP_SENDING_ENABLED. Reading, drafting and review work
 * either way.
 */
export function socialSendingEnabled(): boolean {
  return getAdsEnv().SOCIAL_SENDING_ENABLED === "true";
}

export function getSocialDeps(): SocialDeps {
  const db = getDb();
  return {
    db,
    ads: { db, adapters: getAdAdapters(), tokenKey: adTokenKey() },
    meta: metaSocialFromEnv(),
    ai: getAiRuntimeForAutomation(),
    sendingEnabled: socialSendingEnabled(),
    storage: getStorageRouter(),
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
  const created = await ingestEvents(getSystemDb(), getDb(), events, new Date());
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
 * The scheduler's social work, phase by phase (one failing phase or item is logged and
 * the rest still runs):
 *   - publish due Page posts (sending switch on; paused workspaces and lost grants are not
 *     queued; a post held too long fails instead of going out late);
 *   - mark publications and sends stuck without an answer as UNCERTAIN;
 *   - draft interactions left NEW (a lost after(), a credits refusal that may have cleared)
 *     — only on enabled channels of workspaces with a usable Meta grant;
 *   - send decided replies that never went out (sending switch on, workspace not paused,
 *     usable grant; a reply that waited too long goes back to a person);
 *   - run an agent's self-review once enough feedback accumulated (the proposal still
 *     waits for a person).
 */
export async function socialSweep(
  deps: SocialDeps,
  system: PrismaClient = getSystemDb(),
  now: Date = new Date(),
  limit = 25,
): Promise<SocialSweepSummary> {
  async function phase(name: string, work: () => Promise<number>): Promise<number> {
    try {
      return await work();
    } catch (error) {
      logger.error({ err: error, phase: name }, "Social sweep phase failed");
      return 0;
    }
  }
  const atSweepTime: SocialDeps = { ...deps, now: () => now };
  const usable = { deletedAt: null, ...activeMetaGrant(now) };
  const notPaused = { automationPolicy: { isNot: { paused: true } } };

  const published = await phase("publish", async () => {
    if (!deps.sendingEnabled) return 0;
    let count = 0;
    for (const post of await duePosts(system, now, limit)) {
      try {
        if ((await publishPost(atSweepTime, post.workspaceId, post.id)) === "published") {
          count += 1;
        }
      } catch (error) {
        logger.error({ err: error, postId: post.id }, "Scheduled post failed");
      }
    }
    return count;
  });

  // A publication claimed but never finished (the process stopped mid-call): it may be on
  // the Page, so it becomes UNCERTAIN and is looked up there, never published again blindly.
  await phase("stuck_posts", async () => {
    const stuck = await system.socialPost.findMany({
      where: {
        status: "PUBLISHING",
        updatedAt: { lt: new Date(now.getTime() - STUCK_PUBLISH_MS) },
      },
      take: limit,
      select: { id: true, workspaceId: true },
    });
    for (const row of stuck) {
      try {
        await deps.db.socialPost.updateMany({
          where: { workspaceId: row.workspaceId, id: row.id, status: "PUBLISHING" },
          data: { status: "UNCERTAIN", errorCode: "no_answer", version: { increment: 1 } },
        });
      } catch (error) {
        logger.error({ err: error, postId: row.id }, "Stuck post recovery failed");
      }
    }
    return stuck.length;
  });

  const drafted = await phase("draft", async () => {
    const due = await system.socialInteraction.findMany({
      where: {
        status: { in: ["NEW", "FAILED"] },
        draftAttempts: { lt: MAX_DRAFT_ATTEMPTS },
        // NULL is not "not in" a list in SQL: no error yet must be listed explicitly.
        OR: [
          { lastError: null },
          {
            lastError: {
              notIn: [
                "window_closed",
                "not_sent_confirmed",
                "agent_delegate_missing",
                "stale_reply",
              ],
            },
          },
        ],
        receivedAt: { gte: new Date(now.getTime() - 2 * 24 * 3_600_000) },
        agent: { active: true },
        channel: { enabled: true },
        replies: { none: {} },
        workspace: usable,
      },
      orderBy: { receivedAt: "asc" },
      take: limit,
      select: { id: true, workspaceId: true },
    });
    let count = 0;
    for (const row of due) {
      try {
        const outcome = await draftInteraction(atSweepTime, row.workspaceId, row.id);
        if (outcome !== "skipped" && outcome !== "failed") count += 1;
      } catch (error) {
        logger.error({ err: error, interactionId: row.id }, "Social sweep draft failed");
      }
    }
    return count;
  });

  const sent = await phase("send", async () => {
    if (!deps.sendingEnabled) return 0;
    const unsent = await system.socialReply.findMany({
      where: {
        decision: { in: ["APPROVED", "EDITED", "AUTO"] },
        sendStatus: "NOT_SENT",
        decidedAt: { lt: new Date(now.getTime() - UNSENT_GRACE_MS) },
        interaction: { channel: { enabled: true } },
        workspace: { ...usable, ...notPaused },
      },
      orderBy: { decidedAt: "asc" },
      take: limit,
      select: { id: true, workspaceId: true },
    });
    let count = 0;
    for (const row of unsent) {
      try {
        if ((await sendReply(atSweepTime, row.workspaceId, row.id, null)) === "sent") count += 1;
      } catch (error) {
        logger.error({ err: error, replyId: row.id }, "Social sweep send failed");
      }
    }
    return count;
  });

  const uncertain = await phase("stuck_sends", async () => {
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
    return stuck.length;
  });

  // Self-review: active agents with enough new feedback and no proposal waiting.
  const reviewed = await phase("self_review", async () => {
    const agents = await system.socialAgent.findMany({
      where: {
        active: true,
        workspace: { deletedAt: null, ...notPaused },
        lessons: { none: { kind: "GUIDANCE", status: "PROPOSED" } },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true, workspaceId: true, delegateUserId: true },
    });
    let count = 0;
    for (const agent of agents) {
      try {
        if (await reviewIfDue(atSweepTime, agent)) count += 1;
      } catch (error) {
        // Not allowed any more, no credits, AI unavailable: tried again on a later tick.
        logger.warn({ err: error, agentId: agent.id }, "Social self-review skipped");
      }
    }
    return count;
  });
  return { published, drafted, sent, uncertain, reviewed };
}

async function reviewIfDue(
  deps: SocialDeps,
  agent: {
    readonly id: string;
    readonly workspaceId: string;
    readonly delegateUserId: string | null;
  },
): Promise<boolean> {
  if (agent.delegateUserId === null) return false;
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
  if (feedback < SELF_REVIEW_THRESHOLD) return false;
  const membership = await deps.db.workspaceMember.findFirst({
    where: { workspaceId: agent.workspaceId, userId: agent.delegateUserId },
    select: { role: true },
  });
  if (membership === null) return false;
  await runSelfReview(
    deps,
    { workspaceId: agent.workspaceId, userId: agent.delegateUserId, role: membership.role },
    agent.id,
  );
  return true;
}
