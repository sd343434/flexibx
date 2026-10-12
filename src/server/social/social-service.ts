import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import type { SocialPlatform } from "@/generated/prisma/enums";

import { withPlatformToken, type AdsDeps } from "../ads/connections";
import { generate, type AiRuntime } from "../ai/ai-service";
import {
  readStoredOutput,
  type SocialLearningOutput,
  type SocialReplyOutput,
} from "../ai/operations";
import type { AiLanguage } from "../ai/provider";
import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError, isAppError } from "../errors/app-error";
import type { ErrorCode } from "../errors/codes";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan, can, type Action } from "../tenancy/permissions";
import { isRole } from "../tenancy/roles";
import type { ValidationCode } from "../validation/field-errors";
import { parseInput } from "../validation/parse";

import { SocialPlatformError, type ManagedPage, type MetaSocial } from "./meta-social";
import type { SocialEvent } from "./webhook";

// The AI Social Manager. Agents answer a business's Facebook Page and Instagram comments
// and messages from the business's own knowledge. Every new interaction gets a draft
// (an AI_GENERATION paid in credits through the shared AI pipeline); a person approves,
// edits or rejects it — or, for an agent in AUTO mode, low-risk drafts are sent at once
// within the agent's limits (category, confidence, daily cap) and the workspace's
// emergency stop. Every decision teaches the agent: approvals and edits become worked
// examples, rejections become rules, and a self-review proposes improved guidance that a
// person applies. Sends are claimed once (NOT_SENT → SENDING); an answer lost in transit
// is UNCERTAIN and is reconciled against the platform before anything is sent again.
//
// Permissions: social.view (inbox, agents), social.reply (decide, send, redraft, pull
// recent comments), social.manage (agents, channels, AUTO mode, guidance).

export interface SocialDeps {
  readonly db: GuardedPrismaClient;
  readonly ads: AdsDeps;
  /** null = the Meta app is not configured on this server. */
  readonly meta: MetaSocial | null;
  readonly ai: AiRuntime;
  readonly now?: () => Date;
}

const nowOf = (deps: { readonly now?: () => Date }) => (deps.now ?? (() => new Date()))();

/** Messenger / Instagram Direct replies are allowed within 24 hours of the person's message. */
export const MESSAGE_WINDOW_MS = 24 * 3_600_000;
/** Drafting attempts per interaction before it waits for a person. */
export const MAX_DRAFT_ATTEMPTS = 3;
/** Worked examples and rules given to the agent with every draft. */
export const EXAMPLES_IN_PROMPT = 8;
export const RULES_IN_PROMPT = 15;
/** Feedback items (edits and rejections) that trigger an automatic self-review. */
export const SELF_REVIEW_THRESHOLD = 10;
/** How long one drafting attempt holds its claim (longer than an AI call with its retry). */
export const DRAFT_LEASE_MS = 5 * 60_000;

export function socialError(
  code: ErrorCode,
  field: ValidationCode,
  params: Record<string, string | number> = {},
): AppError {
  return new AppError(code, {
    message: `Social: ${field}`,
    fields: [{ path: "social", code: field, params }],
    metadata: { ...params },
  });
}

const notFound = (resource: string) => new AppError("NOT_FOUND", { metadata: { resource } });

/** The member an agent acts for, if still a member allowed to do `action`. */
async function resolveDelegate(
  db: Db,
  workspaceId: string,
  userId: string | null,
  action: Action,
): Promise<TenantContext | null> {
  if (userId === null) return null;
  const membership = await db.workspaceMember.findFirst({
    where: { workspaceId, userId, workspace: { deletedAt: null } },
    select: { role: true },
  });
  if (membership === null || !isRole(membership.role) || !can(membership.role, action)) return null;
  return { workspaceId, userId, role: membership.role };
}

// ── Agents ───────────────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
const AUTO_CATEGORIES = ["question", "praise", "lead", "other"] as const;

const agentSchema = z.strictObject({
  name: text(120).min(1),
  role: z.enum(["customer_service", "sales", "community"]),
  language: z.enum(["auto", "ar", "en"]),
  tone: text(500),
  businessInfo: text(6000),
  faq: z.array(z.strictObject({ q: text(500).min(1), a: text(1500).min(1) })).max(30),
  policies: text(4000),
  escalation: text(2000),
  forbidden: text(2000),
  mode: z.enum(["SUGGEST", "AUTO"]),
  autoCategories: z.array(z.enum(AUTO_CATEGORIES)).max(AUTO_CATEGORIES.length),
  minConfidence: z.coerce.number().int().min(50).max(100),
  dailyAutoCap: z.coerce.number().int().min(0).max(1000),
});

export type AgentInput = z.input<typeof agentSchema>;

/** Creates (id null) or updates an agent's knowledge, voice and limits (social.manage). */
export async function saveAgent(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  agentId: string | null,
  input: unknown,
): Promise<{ readonly id: string }> {
  assertCan(ctx, "social.manage");
  const data = parseInput(agentSchema, input, "agent");
  return db.$transaction(async (tx) => {
    let id: string;
    if (agentId === null) {
      const created = await tx.socialAgent.create({
        data: { workspaceId: ctx.workspaceId, ...data, faq: data.faq },
        select: { id: true },
      });
      id = created.id;
    } else {
      if (!isUuid(agentId)) throw notFound("social_agent");
      const updated = await tx.socialAgent.updateMany({
        where: { workspaceId: ctx.workspaceId, id: agentId },
        data: { ...data, faq: data.faq, version: { increment: 1 } },
      });
      if (updated.count === 0) throw notFound("social_agent");
      id = agentId;
    }
    await recordAudit(tx, ctx, {
      action: "social.agent_saved",
      entityType: "social_agent",
      entityId: id,
      metadata: { mode: data.mode, autoCategories: data.autoCategories, created: agentId === null },
    });
    return { id };
  });
}

/**
 * Starts or pauses an agent (social.manage). Starting it delegates the authority of the
 * member who started it: drafts and automatic replies act as that member, who must still
 * be allowed to reply (checked before every draft and send).
 */
export async function setAgentActive(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  agentId: string,
  active: boolean,
): Promise<void> {
  assertCan(ctx, "social.manage");
  if (!isUuid(agentId)) throw notFound("social_agent");
  await db.$transaction(async (tx) => {
    const updated = await tx.socialAgent.updateMany({
      where: { workspaceId: ctx.workspaceId, id: agentId },
      data: active
        ? { active: true, delegateUserId: ctx.userId, version: { increment: 1 } }
        : { active: false, version: { increment: 1 } },
    });
    if (updated.count === 0) throw notFound("social_agent");
    await recordAudit(tx, ctx, {
      action: active ? "social.agent_activated" : "social.agent_paused",
      entityType: "social_agent",
      entityId: agentId,
    });
  });
}

// ── Channels ─────────────────────────────────────────────────────────────────

function requireMeta(deps: SocialDeps): MetaSocial {
  if (deps.meta === null) throw socialError("SERVICE_UNAVAILABLE", "social_not_configured");
  return deps.meta;
}

/** The Page (with its transient token) behind a channel, from the workspace's Meta grant. */
export async function pageFor(
  deps: SocialDeps,
  workspaceId: string,
  pageId: string,
): Promise<ManagedPage> {
  const meta = requireMeta(deps);
  const pages = await withPlatformToken(deps.ads, workspaceId, "META", (token) =>
    meta.listPages(token),
  );
  const page = pages.find((candidate) => candidate.id === pageId);
  if (page === undefined) throw socialError("CONFLICT", "social_page_unavailable");
  return page;
}

/**
 * Lists the Facebook Pages (and their Instagram professional accounts) the workspace's
 * Meta connection manages and records them as channels (social.manage). Pages no longer
 * listed are disabled, never deleted (their history stays).
 */
export async function syncChannels(
  deps: SocialDeps,
  ctx: TenantContext,
): Promise<{ readonly channels: number }> {
  assertCan(ctx, "social.manage");
  const meta = requireMeta(deps);
  const pages = await withPlatformToken(deps.ads, ctx.workspaceId, "META", (token) =>
    meta.listPages(token),
  );
  const seen: { platform: SocialPlatform; externalId: string; pageId: string; name: string }[] = [];
  for (const page of pages) {
    seen.push({ platform: "FACEBOOK", externalId: page.id, pageId: page.id, name: page.name });
    if (page.instagram !== null) {
      seen.push({
        platform: "INSTAGRAM",
        externalId: page.instagram.id,
        pageId: page.id,
        name: `@${page.instagram.username}`,
      });
    }
  }
  await deps.db.$transaction(async (tx) => {
    for (const channel of seen) {
      await tx.socialChannel.upsert({
        where: {
          workspaceId_platform_externalId: {
            workspaceId: ctx.workspaceId,
            platform: channel.platform,
            externalId: channel.externalId,
          },
        },
        create: { workspaceId: ctx.workspaceId, ...channel },
        update: { name: channel.name, pageId: channel.pageId, enabled: true },
      });
    }
    const existing = await tx.socialChannel.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, platform: true, externalId: true },
    });
    const gone = existing.filter(
      (row) => !seen.some((s) => s.platform === row.platform && s.externalId === row.externalId),
    );
    if (gone.length > 0) {
      await tx.socialChannel.updateMany({
        where: { workspaceId: ctx.workspaceId, id: { in: gone.map((row) => row.id) } },
        data: { enabled: false },
      });
    }
    await recordAudit(tx, ctx, {
      action: "social.channel_saved",
      entityType: "social_channel",
      entityId: null,
      metadata: { synced: seen.length, disabled: gone.length },
    });
  });
  return { channels: seen.length };
}

/** Assigns an agent to a channel (or none) and turns the channel on or off (social.manage). */
export async function assignChannel(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  channelId: string,
  agentId: string | null,
  enabled: boolean,
): Promise<void> {
  assertCan(ctx, "social.manage");
  if (!isUuid(channelId) || (agentId !== null && !isUuid(agentId)))
    throw notFound("social_channel");
  await db.$transaction(async (tx) => {
    if (agentId !== null) {
      const agent = await tx.socialAgent.count({
        where: { workspaceId: ctx.workspaceId, id: agentId },
      });
      if (agent === 0) throw notFound("social_agent");
    }
    const updated = await tx.socialChannel.updateMany({
      where: { workspaceId: ctx.workspaceId, id: channelId },
      data: { agentId, enabled },
    });
    if (updated.count === 0) throw notFound("social_channel");
    await recordAudit(tx, ctx, {
      action: "social.channel_saved",
      entityType: "social_channel",
      entityId: channelId,
      metadata: { agentAssigned: agentId !== null, enabled },
    });
  });
}

/** Subscribes the channel's Page to Meta's webhook so new comments and messages arrive. */
export async function subscribeChannel(
  deps: SocialDeps,
  ctx: TenantContext,
  channelId: string,
): Promise<void> {
  assertCan(ctx, "social.manage");
  if (!isUuid(channelId)) throw notFound("social_channel");
  const channel = await deps.db.socialChannel.findFirst({
    where: { workspaceId: ctx.workspaceId, id: channelId },
    select: { pageId: true },
  });
  if (channel === null) throw notFound("social_channel");
  const page = await pageFor(deps, ctx.workspaceId, channel.pageId);
  try {
    await requireMeta(deps).subscribePage(page);
  } catch (error) {
    if (error instanceof SocialPlatformError)
      throw socialError("SERVICE_UNAVAILABLE", "social_platform_error", { kind: error.kind });
    throw error;
  }
  // Every channel of the Page (Facebook and its Instagram account) is now subscribed.
  await deps.db.socialChannel.updateMany({
    where: { workspaceId: ctx.workspaceId, pageId: channel.pageId },
    data: { subscribed: true },
  });
}

// ── Inbox ────────────────────────────────────────────────────────────────────

/**
 * Records verified webhook events as interactions of every workspace that manages the
 * account (an agency and its client may both). Cross-workspace lookup by account id only;
 * each row is written with that workspace's id; redeliveries are deduplicated.
 */
export async function ingestEvents(
  system: PrismaClient,
  db: GuardedPrismaClient,
  events: readonly SocialEvent[],
): Promise<readonly { readonly workspaceId: string; readonly id: string }[]> {
  const created: { workspaceId: string; id: string }[] = [];
  for (const event of events) {
    const channels = await system.socialChannel.findMany({
      where: {
        platform: event.platform,
        externalId: event.accountId,
        enabled: true,
        workspace: { deletedAt: null },
      },
      select: { id: true, workspaceId: true, agentId: true },
    });
    for (const channel of channels) {
      const row = await recordEvent(db, channel, event);
      if (row !== null) created.push(row);
    }
  }
  return created;
}

async function recordEvent(
  db: GuardedPrismaClient,
  channel: { id: string; workspaceId: string; agentId: string | null },
  event: SocialEvent,
): Promise<{ workspaceId: string; id: string } | null> {
  const existing = await db.socialInteraction.findFirst({
    where: {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      externalId: event.externalId,
    },
    select: { id: true },
  });
  if (existing !== null) return null;
  try {
    const row = await db.socialInteraction.create({
      data: {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        agentId: channel.agentId,
        kind: event.kind,
        externalId: event.externalId,
        threadExternalId: event.threadExternalId,
        authorExternalId: event.authorId,
        authorName: event.authorName,
        text: event.text,
        receivedAt: event.receivedAt,
      },
      select: { id: true },
    });
    return { workspaceId: channel.workspaceId, id: row.id };
  } catch (error) {
    // A concurrent delivery of the same event won the unique key.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
      return null;
    throw error;
  }
}

/** Reads the channel's recent comments now (no webhook needed) and records new ones. */
export async function pullRecentComments(
  deps: SocialDeps,
  ctx: TenantContext,
  channelId: string,
): Promise<readonly { readonly workspaceId: string; readonly id: string }[]> {
  assertCan(ctx, "social.reply");
  if (!isUuid(channelId)) throw notFound("social_channel");
  const channel = await deps.db.socialChannel.findFirst({
    where: { workspaceId: ctx.workspaceId, id: channelId, enabled: true },
    select: {
      id: true,
      workspaceId: true,
      agentId: true,
      platform: true,
      externalId: true,
      pageId: true,
    },
  });
  if (channel === null) throw notFound("social_channel");
  const page = await pageFor(deps, ctx.workspaceId, channel.pageId);
  let comments;
  try {
    comments = await requireMeta(deps).recentComments(page, channel.platform, channel.externalId);
  } catch (error) {
    if (error instanceof SocialPlatformError)
      throw socialError("SERVICE_UNAVAILABLE", "social_platform_error", { kind: error.kind });
    throw error;
  }
  const created: { workspaceId: string; id: string }[] = [];
  for (const comment of comments) {
    const row = await recordEvent(deps.db, channel, {
      platform: channel.platform,
      accountId: channel.externalId,
      kind: "COMMENT",
      externalId: comment.id,
      threadExternalId: comment.postId,
      authorId: comment.authorId,
      authorName: comment.authorName,
      text: comment.text,
      receivedAt: comment.createdAt,
    });
    if (row !== null) created.push(row);
  }
  return created;
}

// ── Drafting ─────────────────────────────────────────────────────────────────

/** The customer's language from their text (Arabic script → ar). */
export function customerLanguage(value: string): AiLanguage {
  return /[؀-ۿ]/u.test(value) ? "ar" : "en";
}

interface AgentKnowledge {
  readonly role: string;
  readonly tone: string;
  readonly businessInfo: string;
  readonly faq: unknown;
  readonly policies: string;
  readonly escalation: string;
  readonly forbidden: string;
  readonly guidance: string;
}

/** The agent's knowledge, rules and worked examples, as the prompt's data block. */
export function renderKnowledge(
  agent: AgentKnowledge,
  examples: readonly { customerText: string | null; content: string }[],
  rules: readonly { content: string }[],
  channel: { platform: SocialPlatform; kind: "COMMENT" | "MESSAGE" },
): string {
  const faq = Array.isArray(agent.faq)
    ? agent.faq.flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null) return [];
        const { q, a } = item as { q?: unknown; a?: unknown };
        return typeof q === "string" && typeof a === "string" ? [`- Q: ${q}\n  A: ${a}`] : [];
      })
    : [];
  const section = (title: string, body: string | readonly string[]) => {
    const content = typeof body === "string" ? body.trim() : body.join("\n");
    return content === "" ? [] : [`## ${title}`, content, ""];
  };
  return [
    `Channel: ${channel.platform === "INSTAGRAM" ? "Instagram" : "Facebook"} ${channel.kind === "MESSAGE" ? "private message" : "public comment"}`,
    `Agent role: ${agent.role}`,
    "",
    ...section("Tone", agent.tone),
    ...section("Business information", agent.businessInfo),
    ...section("Frequently asked questions", faq),
    ...section("Policies", agent.policies),
    ...section("Escalate to a person when", agent.escalation),
    ...section("Never discuss", agent.forbidden),
    ...section("Guidance learned from the team", agent.guidance),
    ...section(
      "Rules from the team's rejections",
      rules.map((rule) => `- ${rule.content}`),
    ),
    ...section(
      "Replies the team approved (follow their style)",
      examples.map(
        (example) => `- Customer: ${example.customerText ?? ""}\n  Reply: ${example.content}`,
      ),
    ),
  ].join("\n");
}

export type DraftOutcome =
  | "skipped"
  | "awaiting_review"
  | "escalated"
  | "ignored"
  | "auto_sent"
  | "auto_uncertain"
  | "failed";

/**
 * Drafts a reply to one interaction with its agent (paid in credits). Claimed once per
 * attempt (version compare-and-set), so concurrent sweeps never draft twice. In AUTO mode
 * a draft within every limit is sent at once; anything else waits for a person.
 */
export async function draftInteraction(
  deps: SocialDeps,
  workspaceId: string,
  interactionId: string,
): Promise<DraftOutcome> {
  const { db } = deps;
  const interaction = await db.socialInteraction.findFirst({
    where: { workspaceId, id: interactionId, status: { in: ["NEW", "FAILED"] } },
    select: {
      id: true,
      externalId: true,
      kind: true,
      text: true,
      receivedAt: true,
      version: true,
      draftAttempts: true,
      channel: { select: { platform: true, enabled: true, externalId: true } },
      agent: {
        select: {
          id: true,
          active: true,
          role: true,
          language: true,
          tone: true,
          businessInfo: true,
          faq: true,
          policies: true,
          escalation: true,
          forbidden: true,
          guidance: true,
          guidanceVersion: true,
          mode: true,
          autoCategories: true,
          minConfidence: true,
          dailyAutoCap: true,
          delegateUserId: true,
        },
      },
    },
  });
  if (interaction?.agent?.active !== true) return "skipped";
  if (!interaction.channel.enabled || interaction.draftAttempts >= MAX_DRAFT_ATTEMPTS)
    return "skipped";
  const agent = interaction.agent;
  const fail = async (code: string) => {
    await db.socialInteraction.updateMany({
      where: { workspaceId, id: interaction.id },
      data: { status: "FAILED", lastError: code.slice(0, 60), draftingUntil: null },
    });
    return "failed" as const;
  };

  const actor = await resolveDelegate(db, workspaceId, agent.delegateUserId, "social.reply");
  if (actor === null) return fail("agent_delegate_missing");

  // Claim this attempt: a lease, so the webhook's drafting and the scheduler's sweep never
  // draft the same message at once (the status stays NEW while the AI call runs).
  const leaseNow = nowOf(deps);
  const claimed = await db.socialInteraction.updateMany({
    where: {
      workspaceId,
      id: interaction.id,
      version: interaction.version,
      status: { in: ["NEW", "FAILED"] },
      OR: [{ draftingUntil: null }, { draftingUntil: { lt: leaseNow } }],
    },
    data: {
      draftAttempts: { increment: 1 },
      version: { increment: 1 },
      lastError: null,
      draftingUntil: new Date(leaseNow.getTime() + DRAFT_LEASE_MS),
    },
  });
  if (claimed.count === 0) return "skipped";
  const claimedVersion = interaction.version + 1;

  const [examples, rules] = await Promise.all([
    db.socialLesson.findMany({
      where: { workspaceId, agentId: agent.id, kind: "EXAMPLE", status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: EXAMPLES_IN_PROMPT,
      select: { customerText: true, content: true },
    }),
    db.socialLesson.findMany({
      where: { workspaceId, agentId: agent.id, kind: "RULE", status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: RULES_IN_PROMPT,
      select: { content: true },
    }),
  ]);
  const language =
    agent.language === "auto" ? customerLanguage(interaction.text) : (agent.language as AiLanguage);
  let generationId: string;
  try {
    ({ generationId } = await generate(db, actor, deps.ai, {
      operation: "SOCIAL_REPLY",
      permission: "social.reply",
      requestedLanguage: language,
      uiLocale: language,
      focus: {},
      contentItemId: null,
      params: {
        request: interaction.text,
        extra: renderKnowledge(agent, examples, rules, {
          platform: interaction.channel.platform,
          kind: interaction.kind,
        }),
      },
    }));
  } catch (error) {
    if (isAppError(error)) return fail(error.fields[0]?.code ?? error.code.toLowerCase());
    throw error;
  }
  const stored = await db.aiGeneration.findFirst({
    where: { workspaceId, id: generationId },
    select: { output: true },
  });
  const output: SocialReplyOutput | null =
    stored === null ? null : readStoredOutput("SOCIAL_REPLY", stored.output);
  if (output === null) return fail("ai_invalid_output");

  const status =
    output.reply === null ? "IGNORED" : output.needsHuman ? "ESCALATED" : "AWAITING_REVIEW";
  const reply = await db.$transaction(async (tx) => {
    // Only the holder of this attempt's claim records a draft (a lease that expired and was
    // claimed again by another runner loses here, and nothing is written).
    const owned = await tx.socialInteraction.updateMany({
      where: { workspaceId, id: interaction.id, version: claimedVersion },
      data: {
        status,
        category: output.category,
        sentiment: output.sentiment,
        draftingUntil: null,
      },
    });
    if (owned.count === 0) return null;
    const row = await tx.socialReply.create({
      data: {
        workspaceId,
        interactionId: interaction.id,
        agentId: agent.id,
        generationId,
        draftText: output.reply,
        confidence: output.confidence,
        needsHuman: output.needsHuman,
        reason: output.reason,
        guidanceVersion: agent.guidanceVersion,
      },
      select: { id: true },
    });
    return row;
  });
  if (reply === null) return "skipped";
  if (status === "IGNORED") return "ignored";
  if (status === "ESCALATED") return "escalated";

  // AUTO mode: send only what is inside every limit the workspace set.
  const finalText = output.reply;
  const autoAllowed =
    agent.mode === "AUTO" &&
    finalText !== null &&
    output.confidence >= agent.minConfidence &&
    agent.autoCategories.includes(output.category) &&
    (interaction.kind === "COMMENT" ||
      nowOf(deps).getTime() - interaction.receivedAt.getTime() < MESSAGE_WINDOW_MS) &&
    (await resolveDelegate(db, workspaceId, agent.delegateUserId, "social.manage")) !== null &&
    !(await automationPaused(db, workspaceId));
  if (!autoAllowed) return "awaiting_review";
  const decided = await decideAutomatically(db, nowOf(deps), {
    workspaceId,
    agentId: agent.id,
    dailyAutoCap: agent.dailyAutoCap,
    replyId: reply.id,
    finalText,
    interaction: {
      id: interaction.id,
      platform: interaction.channel.platform,
      channelExternalId: interaction.channel.externalId,
      externalId: interaction.externalId,
    },
  });
  if (!decided) return "awaiting_review";
  const sent = await sendReply(deps, workspaceId, reply.id, null);
  if (sent === "held") return "awaiting_review";
  return sent === "sent" ? "auto_sent" : sent === "uncertain" ? "auto_uncertain" : "failed";
}

/** Another workspace managing the same Page answers this message automatically. */
class AutoClaimLost extends Error {}

/**
 * Turns a pending draft into an automatic reply, atomically: under a lock on the agent,
 * its daily cap is counted and used (parallel drafts cannot both see room for one more),
 * and the platform message is claimed across every workspace that manages the Page (only
 * one AUTO agent answers it). False: the cap is reached, the draft was decided already, or
 * another workspace answers it — the draft then waits for a person.
 */
export async function decideAutomatically(
  db: GuardedPrismaClient,
  now: Date,
  decision: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly dailyAutoCap: number;
    readonly replyId: string;
    readonly finalText: string;
    readonly interaction: {
      readonly id: string;
      readonly platform: SocialPlatform;
      readonly channelExternalId: string;
      readonly externalId: string;
    };
  },
): Promise<boolean> {
  const { workspaceId, agentId, interaction } = decision;
  return db
    .$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM social_agents WHERE id = ${agentId}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
      if ((await autoRepliesToday(tx, workspaceId, agentId, now)) >= decision.dailyAutoCap) {
        return false;
      }
      const updated = await tx.socialReply.updateMany({
        where: { workspaceId, id: decision.replyId, decision: "PENDING" },
        data: { decision: "AUTO", finalText: decision.finalText, decidedAt: now },
      });
      if (updated.count === 0) return false;
      // Unique on the platform's ids, not per workspace. Losing it rolls the decision back.
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO social_auto_reply_claims
          (workspace_id, interaction_id, platform, channel_external_id, external_id)
        VALUES (${workspaceId}::uuid, ${interaction.id}::uuid,
          ${interaction.platform}::social_platform, ${interaction.channelExternalId},
          ${interaction.externalId})
        ON CONFLICT (platform, channel_external_id, external_id) DO NOTHING
        RETURNING id`;
      if (claimed.length === 0) throw new AutoClaimLost();
      return true;
    })
    .catch((error: unknown) => {
      if (error instanceof AutoClaimLost) return false;
      throw error;
    });
}

async function automationPaused(db: Db, workspaceId: string): Promise<boolean> {
  const policy = await db.automationPolicy.findFirst({
    where: { workspaceId },
    select: { paused: true },
  });
  return policy?.paused === true;
}

async function autoRepliesToday(
  db: Db,
  workspaceId: string,
  agentId: string,
  now: Date,
): Promise<number> {
  return db.socialReply.count({
    where: {
      workspaceId,
      agentId,
      decision: "AUTO",
      decidedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
    },
  });
}

// ── Decisions ────────────────────────────────────────────────────────────────

/** A person's send: never held (only system sends wait for the emergency stop). */
async function sendByPerson(
  deps: SocialDeps,
  ctx: TenantContext,
  replyId: string,
): Promise<"sent" | "uncertain" | "failed"> {
  const outcome = await sendReply(deps, ctx.workspaceId, replyId, ctx);
  return outcome === "held" ? "failed" : outcome;
}

async function pendingReply(db: Db, workspaceId: string, replyId: string) {
  if (!isUuid(replyId)) throw notFound("social_reply");
  const reply = await db.socialReply.findFirst({
    where: { workspaceId, id: replyId },
    select: {
      id: true,
      agentId: true,
      decision: true,
      draftText: true,
      interaction: { select: { id: true, text: true, status: true } },
    },
  });
  if (reply === null) throw notFound("social_reply");
  if (reply.decision !== "PENDING") throw socialError("CONFLICT", "social_reply_locked");
  return reply;
}

/**
 * Approves a draft as written, or with a person's edit, and sends it (social.reply). An
 * approval teaches the agent a worked example; an edit teaches it the corrected one.
 */
export async function approveReply(
  deps: SocialDeps,
  ctx: TenantContext,
  replyId: string,
  editedText: string | null,
): Promise<"sent" | "uncertain" | "failed"> {
  assertCan(ctx, "social.reply");
  const reply = await pendingReply(deps.db, ctx.workspaceId, replyId);
  const edited = editedText?.trim() ?? "";
  const finalText = edited !== "" ? edited : (reply.draftText ?? "");
  if (finalText === "" || finalText.length > 2000)
    throw socialError("VALIDATION_FAILED", "social_reply_empty");
  const changed = finalText !== reply.draftText?.trim();
  const now = nowOf(deps);
  await deps.db.$transaction(async (tx) => {
    const decided = await tx.socialReply.updateMany({
      where: { workspaceId: ctx.workspaceId, id: reply.id, decision: "PENDING" },
      data: {
        decision: changed ? "EDITED" : "APPROVED",
        finalText,
        decidedByUserId: ctx.userId,
        decidedAt: now,
      },
    });
    if (decided.count === 0) throw socialError("CONFLICT", "social_reply_locked");
    await tx.socialLesson.create({
      data: {
        workspaceId: ctx.workspaceId,
        agentId: reply.agentId,
        kind: "EXAMPLE",
        status: "ACTIVE",
        source: changed ? "edit" : "approval",
        customerText: reply.interaction.text.slice(0, 2000),
        draftText: reply.draftText,
        content: finalText,
        replyId: reply.id,
        createdByUserId: ctx.userId,
      },
    });
  });
  return sendByPerson(deps, ctx, reply.id);
}

/** Rejects a draft (social.reply); a reason becomes a rule the agent follows from now on. */
export async function rejectReply(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  replyId: string,
  reason: string,
): Promise<void> {
  assertCan(ctx, "social.reply");
  const reply = await pendingReply(db, ctx.workspaceId, replyId);
  const rule = reason.trim().slice(0, 500);
  await db.$transaction(async (tx) => {
    const decided = await tx.socialReply.updateMany({
      where: { workspaceId: ctx.workspaceId, id: reply.id, decision: "PENDING" },
      data: {
        decision: "REJECTED",
        rejectReason: rule === "" ? null : rule,
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
      },
    });
    if (decided.count === 0) throw socialError("CONFLICT", "social_reply_locked");
    await tx.socialInteraction.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        id: reply.interaction.id,
        status: { in: ["AWAITING_REVIEW", "ESCALATED"] },
      },
      data: { status: "IGNORED" },
    });
    if (rule !== "") {
      await tx.socialLesson.create({
        data: {
          workspaceId: ctx.workspaceId,
          agentId: reply.agentId,
          kind: "RULE",
          status: "ACTIVE",
          source: "rejection",
          customerText: reply.interaction.text.slice(0, 2000),
          draftText: reply.draftText,
          content: rule,
          replyId: reply.id,
          createdByUserId: ctx.userId,
        },
      });
    }
    await recordAudit(tx, ctx, {
      action: "social.reply_rejected",
      entityType: "social_reply",
      entityId: reply.id,
      metadata: { rule: rule !== "" },
    });
  });
}

/** Marks an interaction as not needing a reply (social.reply). */
export async function ignoreInteraction(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  interactionId: string,
): Promise<void> {
  assertCan(ctx, "social.reply");
  if (!isUuid(interactionId)) throw notFound("social_interaction");
  await db.$transaction(async (tx) => {
    const updated = await tx.socialInteraction.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        id: interactionId,
        status: { in: ["NEW", "AWAITING_REVIEW", "ESCALATED", "FAILED"] },
      },
      data: { status: "IGNORED" },
    });
    if (updated.count === 0) throw socialError("CONFLICT", "social_reply_locked");
    await tx.socialReply.updateMany({
      where: { workspaceId: ctx.workspaceId, interactionId, decision: "PENDING" },
      data: { decision: "REJECTED", decidedByUserId: ctx.userId, decidedAt: new Date() },
    });
    await recordAudit(tx, ctx, {
      action: "social.interaction_ignored",
      entityType: "social_interaction",
      entityId: interactionId,
    });
  });
}

/** Asks the agent for a new draft (social.reply): a pending draft is set aside. */
export async function redraftInteraction(
  deps: SocialDeps,
  ctx: TenantContext,
  interactionId: string,
): Promise<DraftOutcome> {
  assertCan(ctx, "social.reply");
  if (!isUuid(interactionId)) throw notFound("social_interaction");
  const reopened = await deps.db.$transaction(async (tx) => {
    const updated = await tx.socialInteraction.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        id: interactionId,
        status: { in: ["AWAITING_REVIEW", "ESCALATED", "FAILED"] },
      },
      data: { status: "NEW", draftAttempts: 0, lastError: null },
    });
    if (updated.count === 0) return false;
    await tx.socialReply.updateMany({
      where: { workspaceId: ctx.workspaceId, interactionId, decision: "PENDING" },
      data: { decision: "REJECTED", decidedByUserId: ctx.userId, decidedAt: new Date() },
    });
    return true;
  });
  if (!reopened) throw socialError("CONFLICT", "social_reply_locked");
  return draftInteraction(deps, ctx.workspaceId, interactionId);
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Sends a decided reply once. The claim (NOT_SENT/FAILED → SENDING) makes it single
 * flight; a definite refusal is FAILED (a person may retry), an unknown outcome is
 * UNCERTAIN and is never resent before it is reconciled. `actor` null = an AUTO agent.
 */
export async function sendReply(
  deps: SocialDeps,
  workspaceId: string,
  replyId: string,
  actor: TenantContext | null,
): Promise<"sent" | "uncertain" | "failed" | "held"> {
  const { db } = deps;
  const reply = await db.socialReply.findFirst({
    where: {
      workspaceId,
      id: replyId,
      decision: { in: ["APPROVED", "EDITED", "AUTO"] },
      sendStatus: { in: ["NOT_SENT", "FAILED"] },
    },
    select: {
      id: true,
      finalText: true,
      decision: true,
      agent: { select: { delegateUserId: true } },
      interaction: {
        select: {
          id: true,
          kind: true,
          externalId: true,
          threadExternalId: true,
          receivedAt: true,
          channel: { select: { platform: true, pageId: true, externalId: true } },
        },
      },
    },
  });
  if (typeof reply?.finalText !== "string") throw socialError("CONFLICT", "social_reply_locked");
  const { interaction } = reply;
  const now = nowOf(deps);
  // Sent by the system (the sweep, or right after an automatic decision): the emergency
  // stop holds it, and an automatic reply still needs a delegate allowed to send them.
  if (actor === null) {
    if (await automationPaused(db, workspaceId)) return "held";
    if (
      reply.decision === "AUTO" &&
      (await resolveDelegate(db, workspaceId, reply.agent.delegateUserId, "social.manage")) === null
    ) {
      return "held";
    }
  }
  const finish = async (
    sendStatus: "SENT" | "FAILED" | "UNCERTAIN",
    extra: { externalReplyId?: string; sendError?: string },
  ) => {
    await db.$transaction(async (tx) => {
      await tx.socialReply.updateMany({
        where: { workspaceId, id: reply.id, sendStatus: "SENDING" },
        data: {
          sendStatus,
          externalReplyId: extra.externalReplyId ?? null,
          sendError: extra.sendError?.slice(0, 60) ?? null,
          ...(sendStatus === "SENT" ? { sentAt: now } : {}),
        },
      });
      await tx.socialInteraction.updateMany({
        where: { workspaceId, id: interaction.id },
        data: {
          status: sendStatus === "SENT" ? "REPLIED" : sendStatus,
          lastError: extra.sendError?.slice(0, 60) ?? null,
        },
      });
      if (sendStatus !== "FAILED") {
        await recordAudit(tx, actor ?? { workspaceId, userId: null }, {
          action: sendStatus === "SENT" ? "social.reply_sent" : "social.reply_uncertain",
          entityType: "social_reply",
          entityId: reply.id,
          metadata: {
            platform: interaction.channel.platform,
            kind: interaction.kind,
            automatic: actor === null,
          },
        });
      }
    });
  };

  if (
    interaction.kind === "MESSAGE" &&
    now.getTime() - interaction.receivedAt.getTime() >= MESSAGE_WINDOW_MS
  ) {
    const closed = await db.socialReply.updateMany({
      where: { workspaceId, id: reply.id, sendStatus: { in: ["NOT_SENT", "FAILED"] } },
      data: { sendStatus: "FAILED", sendError: "window_closed" },
    });
    if (closed.count === 0) throw socialError("CONFLICT", "social_reply_locked");
    await db.socialInteraction.updateMany({
      where: { workspaceId, id: interaction.id },
      data: { status: "FAILED", lastError: "window_closed" },
    });
    return "failed";
  }
  const claimed = await db.$transaction(async (tx) => {
    const updated = await tx.socialReply.updateMany({
      where: { workspaceId, id: reply.id, sendStatus: { in: ["NOT_SENT", "FAILED"] } },
      data: { sendStatus: "SENDING", sendError: null },
    });
    if (updated.count === 0) return false;
    await tx.socialInteraction.updateMany({
      where: { workspaceId, id: interaction.id },
      data: { status: "SENDING", lastError: null },
    });
    return true;
  });
  if (!claimed) throw socialError("CONFLICT", "social_reply_locked");

  let page: ManagedPage;
  try {
    page = await pageFor(deps, workspaceId, interaction.channel.pageId);
  } catch (error) {
    // Nothing was sent: the Page or the grant is not usable right now.
    await finish("FAILED", {
      sendError: isAppError(error) ? (error.fields[0]?.code ?? error.code) : "page_unavailable",
    });
    return "failed";
  }
  try {
    const meta = requireMeta(deps);
    const externalReplyId =
      interaction.kind === "COMMENT"
        ? await meta.replyToComment(
            page,
            interaction.channel.platform,
            interaction.externalId,
            reply.finalText,
          )
        : await meta.sendMessage(page, interaction.threadExternalId, reply.finalText);
    await finish("SENT", { externalReplyId });
    return "sent";
  } catch (error) {
    if (error instanceof SocialPlatformError) {
      await finish(error.uncertain ? "UNCERTAIN" : "FAILED", { sendError: error.kind });
      return error.uncertain ? "uncertain" : "failed";
    }
    await finish("UNCERTAIN", { sendError: "provider_error" });
    return "uncertain";
  }
}

/**
 * Settles an UNCERTAIN reply (social.reply). Comments are checked on the platform: the
 * account's own reply with the same text means it was sent. Messages cannot be looked up,
 * so the person states what they see (`sent`) after checking the conversation.
 */
export async function resolveUncertainReply(
  deps: SocialDeps,
  ctx: TenantContext,
  replyId: string,
  statement: "check" | "sent" | "not_sent",
): Promise<"sent" | "not_sent"> {
  assertCan(ctx, "social.reply");
  if (!isUuid(replyId)) throw notFound("social_reply");
  const reply = await deps.db.socialReply.findFirst({
    where: { workspaceId: ctx.workspaceId, id: replyId, sendStatus: "UNCERTAIN" },
    select: {
      id: true,
      finalText: true,
      interaction: {
        select: {
          id: true,
          kind: true,
          externalId: true,
          channel: { select: { platform: true, pageId: true, externalId: true } },
        },
      },
    },
  });
  if (typeof reply?.finalText !== "string") throw socialError("CONFLICT", "social_reply_locked");
  let sent: boolean;
  let externalReplyId: string | null = null;
  if (statement === "check") {
    if (reply.interaction.kind !== "COMMENT") throw socialError("CONFLICT", "social_cannot_verify");
    const page = await pageFor(deps, ctx.workspaceId, reply.interaction.channel.pageId);
    externalReplyId = await requireMeta(deps).findCommentReply(
      page,
      reply.interaction.channel.platform,
      reply.interaction.externalId,
      reply.interaction.channel.externalId,
      reply.finalText,
    );
    sent = externalReplyId !== null;
  } else {
    sent = statement === "sent";
  }
  await deps.db.$transaction(async (tx) => {
    await tx.socialReply.updateMany({
      where: { workspaceId: ctx.workspaceId, id: reply.id, sendStatus: "UNCERTAIN" },
      data: sent
        ? { sendStatus: "SENT", sentAt: nowOf(deps), externalReplyId, sendError: null }
        : { sendStatus: "FAILED", sendError: "not_sent_confirmed" },
    });
    await tx.socialInteraction.updateMany({
      where: { workspaceId: ctx.workspaceId, id: reply.interaction.id },
      data: sent
        ? { status: "REPLIED", lastError: null }
        : { status: "FAILED", lastError: "not_sent_confirmed" },
    });
  });
  return sent ? "sent" : "not_sent";
}

/** Sends a FAILED reply again (social.reply). */
export async function retryReply(deps: SocialDeps, ctx: TenantContext, replyId: string) {
  assertCan(ctx, "social.reply");
  if (!isUuid(replyId)) throw notFound("social_reply");
  return sendByPerson(deps, ctx, replyId);
}

// ── Learning ─────────────────────────────────────────────────────────────────

/**
 * The agent reviews its own feedback since its last applied guidance and proposes a
 * complete improved guidance (paid in credits). The proposal waits for a person
 * (`applyGuidance`); nothing changes the agent's behaviour on its own.
 */
export async function runSelfReview(
  deps: SocialDeps,
  actor: TenantContext,
  agentId: string,
): Promise<{ readonly lessonId: string }> {
  assertCan(actor, "social.manage");
  if (!isUuid(agentId)) throw notFound("social_agent");
  const { db } = deps;
  const workspaceId = actor.workspaceId;
  const agent = await db.socialAgent.findFirst({
    where: { workspaceId, id: agentId },
    select: { id: true, guidance: true, role: true, language: true },
  });
  if (agent === null) throw notFound("social_agent");
  const since = await db.socialLesson.findFirst({
    where: { workspaceId, agentId, kind: "GUIDANCE", status: "APPLIED" },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  const feedback = await db.socialLesson.findMany({
    where: {
      workspaceId,
      agentId,
      status: "ACTIVE",
      OR: [{ kind: "RULE" }, { kind: "EXAMPLE", source: "edit" }],
      ...(since === null ? {} : { createdAt: { gt: since.updatedAt } }),
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { kind: true, customerText: true, draftText: true, content: true },
  });
  if (feedback.length === 0) throw socialError("CONFLICT", "social_nothing_to_learn");
  const extra = [
    "## Current guidance",
    agent.guidance.trim() === "" ? "(none yet)" : agent.guidance,
    "",
    "## Replies the team edited (draft → what they sent)",
    ...feedback
      .filter((item) => item.kind === "EXAMPLE")
      .map(
        (item) =>
          `- Customer: ${item.customerText ?? ""}\n  Draft: ${item.draftText ?? ""}\n  Sent: ${item.content}`,
      ),
    "",
    "## Drafts the team rejected (reason)",
    ...feedback
      .filter((item) => item.kind === "RULE")
      .map(
        (item) =>
          `- Customer: ${item.customerText ?? ""}\n  Draft: ${item.draftText ?? ""}\n  Reason: ${item.content}`,
      ),
  ].join("\n");
  const language: AiLanguage =
    agent.language === "en"
      ? "en"
      : agent.language === "ar"
        ? "ar"
        : customerLanguage(agent.guidance + feedback.map((f) => f.content).join(" "));
  const { generationId } = await generate(db, actor, deps.ai, {
    operation: "SOCIAL_LEARNING",
    permission: "social.manage",
    requestedLanguage: language,
    uiLocale: language,
    focus: {},
    contentItemId: null,
    params: { request: null, extra },
  });
  const stored = await db.aiGeneration.findFirst({
    where: { workspaceId, id: generationId },
    select: { output: true },
  });
  const output: SocialLearningOutput | null =
    stored === null ? null : readStoredOutput("SOCIAL_LEARNING", stored.output);
  if (output === null) throw socialError("SERVICE_UNAVAILABLE", "ai_invalid_output");
  const lesson = await db.socialLesson.create({
    data: {
      workspaceId,
      agentId,
      kind: "GUIDANCE",
      status: "PROPOSED",
      source: "self_review",
      customerText: output.rationale,
      draftText: output.changes.join("\n"),
      content: output.guidance,
      createdByUserId: actor.userId,
    },
    select: { id: true },
  });
  return { lessonId: lesson.id };
}

/** Applies a proposed guidance to its agent (social.manage); other proposals are dismissed. */
export async function applyGuidance(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  lessonId: string,
): Promise<void> {
  assertCan(ctx, "social.manage");
  if (!isUuid(lessonId)) throw notFound("social_lesson");
  await db.$transaction(async (tx) => {
    const lesson = await tx.socialLesson.findFirst({
      where: { workspaceId: ctx.workspaceId, id: lessonId, kind: "GUIDANCE", status: "PROPOSED" },
      select: { id: true, agentId: true, content: true },
    });
    if (lesson === null) throw socialError("CONFLICT", "social_reply_locked");
    await tx.socialLesson.updateMany({
      where: { workspaceId: ctx.workspaceId, id: lesson.id, status: "PROPOSED" },
      data: { status: "APPLIED", decidedByUserId: ctx.userId },
    });
    await tx.socialLesson.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        agentId: lesson.agentId,
        kind: "GUIDANCE",
        status: "PROPOSED",
      },
      data: { status: "DISMISSED", decidedByUserId: ctx.userId },
    });
    await tx.socialAgent.updateMany({
      where: { workspaceId: ctx.workspaceId, id: lesson.agentId },
      data: {
        guidance: lesson.content,
        guidanceVersion: { increment: 1 },
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, ctx, {
      action: "social.guidance_applied",
      entityType: "social_agent",
      entityId: lesson.agentId,
      metadata: { lessonId: lesson.id },
    });
  });
}

/** Retires an example or rule, or dismisses a guidance proposal (social.manage). */
export async function dismissLesson(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  lessonId: string,
): Promise<void> {
  assertCan(ctx, "social.manage");
  if (!isUuid(lessonId)) throw notFound("social_lesson");
  const updated = await db.socialLesson.updateMany({
    where: { workspaceId: ctx.workspaceId, id: lessonId, status: { in: ["ACTIVE", "PROPOSED"] } },
    data: { status: "DISMISSED", decidedByUserId: ctx.userId },
  });
  if (updated.count === 0) throw notFound("social_lesson");
  await recordAudit(db, ctx, {
    action: "social.lesson_dismissed",
    entityType: "social_lesson",
    entityId: lessonId,
  });
}

/** Adds a rule the agent must follow (social.manage). */
export async function addRule(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  agentId: string,
  rule: string,
): Promise<void> {
  assertCan(ctx, "social.manage");
  if (!isUuid(agentId)) throw notFound("social_agent");
  const content = rule.trim();
  if (content === "" || content.length > 500)
    throw socialError("VALIDATION_FAILED", "social_reply_empty");
  const agent = await db.socialAgent.count({
    where: { workspaceId: ctx.workspaceId, id: agentId },
  });
  if (agent === 0) throw notFound("social_agent");
  await db.socialLesson.create({
    data: {
      workspaceId: ctx.workspaceId,
      agentId,
      kind: "RULE",
      status: "ACTIVE",
      source: "manual",
      content,
      createdByUserId: ctx.userId,
    },
  });
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface AgentMetrics {
  readonly received: number;
  readonly replied: number;
  readonly automatic: number;
  readonly approvedUnchanged: number;
  readonly edited: number;
  readonly rejected: number;
  readonly escalated: number;
  readonly waiting: number;
  /** Share of decided drafts sent without any change (0–100), null with no decisions. */
  readonly acceptanceRate: number | null;
  /** Median minutes from receipt to a sent reply, null with none. */
  readonly medianResponseMinutes: number | null;
}

/** What an agent (or every agent) did since `since`: real counts only, nothing estimated. */
export async function socialMetrics(
  db: Db,
  workspaceId: string,
  agentId: string | null,
  since: Date,
): Promise<AgentMetrics> {
  const scope = { workspaceId, ...(agentId === null ? {} : { agentId }) };
  const [received, waiting, escalated, decisions, sent] = await Promise.all([
    db.socialInteraction.count({ where: { ...scope, receivedAt: { gte: since } } }),
    db.socialInteraction.count({ where: { ...scope, status: "AWAITING_REVIEW" } }),
    db.socialInteraction.count({ where: { ...scope, status: "ESCALATED" } }),
    db.socialReply.groupBy({
      by: ["decision"],
      where: { ...scope, decidedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.socialReply.findMany({
      where: { ...scope, sendStatus: "SENT", sentAt: { gte: since } },
      select: { sentAt: true, interaction: { select: { receivedAt: true } } },
      take: 500,
    }),
  ]);
  const count = (decision: string) =>
    decisions.find((row) => row.decision === decision)?._count._all ?? 0;
  const approved = count("APPROVED");
  const automatic = count("AUTO");
  const edited = count("EDITED");
  const rejected = count("REJECTED");
  const decided = approved + automatic + edited + rejected;
  const minutes = sent
    .flatMap((row) =>
      row.sentAt === null
        ? []
        : [(row.sentAt.getTime() - row.interaction.receivedAt.getTime()) / 60_000],
    )
    .sort((a, b) => a - b);
  const middle =
    minutes.length === 0 ? null : (minutes[Math.floor((minutes.length - 1) / 2)] ?? null);
  return {
    received,
    replied: sent.length,
    automatic,
    approvedUnchanged: approved,
    edited,
    rejected,
    escalated,
    waiting,
    acceptanceRate: decided === 0 ? null : Math.round(((approved + automatic) / decided) * 100),
    medianResponseMinutes: middle === null ? null : Math.max(0, Math.round(middle)),
  };
}
