// The AI Social Manager end to end on a real database, the real Meta social adapter and a
// stand-in Graph API (no network): webhook events become an inbox per workspace (also
// when two workspaces manage the same Page), every draft is paid in credits and grounded
// in the agent's knowledge, people approve / edit / reject and the agent learns from it,
// AUTO mode sends only within its limits, a lost answer is reconciled instead of resent,
// and roles and workspaces are enforced.
import { randomBytes } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters } from "@/server/ads/adapter";
import { createMetaAdapter } from "@/server/ads/adapters/meta";
import { encryptToken } from "@/server/ads/token-vault";
import type { AiRuntime } from "@/server/ai/ai-service";
import { createFakeProvider, type FakeProviderOptions } from "@/server/ai/fake-provider";
import type { AiProvider } from "@/server/ai/provider";
import type { CreditsSettings } from "@/server/billing/config";
import { AppError } from "@/server/errors/app-error";
import { setAutomationPaused, updateAutomationPolicy } from "@/server/orchestration/policy";
import { createMetaSocial } from "@/server/social/meta-social";
import {
  applyGuidance,
  approveReply,
  assignChannel,
  decideAutomatically,
  draftInteraction,
  ingestEvents,
  pullRecentComments,
  redraftInteraction,
  rejectReply,
  resolveUncertainReply,
  retryReply,
  sendReply,
  runSelfReview,
  saveAgent,
  setAgentActive,
  socialMetrics,
  syncChannels,
  type SocialDeps,
} from "@/server/social/social-service";
import {
  cancelPost,
  publishPost,
  queuePost,
  resolveUncertainPost,
} from "@/server/social/publishing";
import { disconnect } from "@/server/ads/connections";
import { forgetMetaUser } from "@/server/ads/meta-deauthorization";
import { MAX_LOOKUP_REQUESTS } from "@/server/social/meta-social";
import { socialSweep } from "@/server/social/social-runtime";
import { parseSocialWebhook } from "@/server/social/webhook";
import { createTenantContext, type TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const KEY = randomBytes(32).toString("base64");
const TOKEN = "EAAB-social-user-token";
const PAGE = "777000";
const IG = "888000";

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── A stand-in Graph API for Pages ────────────────────────────────────────────

function fakeGraph() {
  const calls: {
    method: string;
    path: string;
    params: Record<string, string>;
    token: string | null;
  }[] = [];
  // "500": the platform stored it but answered an error; "drop": it stored it and the
  // connection broke before the answer arrived; "refuse": it stored nothing.
  const faults = new Map<string, "500" | "refuse" | "drop">();
  // Replies by other people listed before the Page's own, and the page size of a listing
  // (null = everything in one page).
  const otherReplies = new Map<string, number>();
  const paging = { size: null as number | null };
  // false = the Page is no longer in this person's grant (/me/accounts no longer lists it).
  const pageListed = { value: true };
  const ownReplies = new Map<string, { id: string; message: string }[]>();
  const pagePosts: { id: string; message: string; created_time: string }[] = [];
  let sequence = 0;
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/v\d+\.0/, "");
    const method = init?.method ?? "GET";
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (init?.body instanceof URLSearchParams) Object.assign(params, Object.fromEntries(init.body));
    const token = params.access_token ?? null;
    delete params.access_token;
    delete params.appsecret_proof;
    calls.push({ method, path, params, token });
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    const key = `${method} ${path}`;
    const fault = faults.get(key);
    if (fault !== undefined) faults.delete(key);
    if (path === "/me/accounts") {
      if (!pageListed.value) return json({ data: [] });
      return json({
        data: [
          {
            id: PAGE,
            name: "Cafe Page",
            tasks: ["MODERATE", "MESSAGING", "ADVERTISE"],
            access_token: "PAGE-TOKEN-777000",
            instagram_business_account: { id: IG, username: "cafe" },
          },
        ],
      });
    }
    if (method === "POST" && /^\/\d+\/(comments|replies)$/.test(path)) {
      const commentId = path.split("/")[1] ?? "";
      sequence += 1;
      const id = `${commentId}_${String(sequence)}`;
      const list = ownReplies.get(commentId) ?? [];
      list.push({ id, message: params.message ?? "" });
      ownReplies.set(commentId, list);
      if (fault === "500") return json({ error: { code: 2, message: "Unexpected" } }, 500);
      if (fault === "refuse") {
        list.pop();
        return json({ error: { code: 100, message: "Invalid" } }, 400);
      }
      if (fault === "drop") return Promise.reject(new TypeError("fetch failed"));
      return json({ id });
    }
    if (method === "GET" && /^\/\d+\/(comments|replies)$/.test(path)) {
      const commentId = path.split("/")[1] ?? "";
      const others = Array.from({ length: otherReplies.get(commentId) ?? 0 }, (_, i) => ({
        id: `other_${String(i)}`,
        message: "Same here!",
        text: "Same here!",
        from: { id: `9${String(i)}` },
      }));
      const all = [
        ...others,
        ...(ownReplies.get(commentId) ?? []).map((reply) => ({
          id: reply.id,
          message: reply.message,
          text: reply.message,
          from: { id: PAGE },
        })),
      ];
      if (paging.size === null) return json({ data: all });
      const offset = Number(params.after ?? "0");
      const end = offset + paging.size;
      return json({
        data: all.slice(offset, end),
        ...(end < all.length
          ? { paging: { cursors: { after: String(end) }, next: "https://graph.test/next" } }
          : {}),
      });
    }
    if (method === "POST" && path === `/${PAGE}/messages`) {
      sequence += 1;
      if (fault === "500") return json({ error: { code: 2, message: "Unexpected" } }, 500);
      if (fault === "refuse") return json({ error: { code: 100, message: "Invalid" } }, 400);
      if (fault === "drop") return Promise.reject(new TypeError("fetch failed"));
      return json({ recipient_id: "x", message_id: `m_${String(sequence)}` });
    }
    if (method === "POST" && path === `/${PAGE}/subscribed_apps`) return json({ success: true });
    if (method === "POST" && path === `/${PAGE}/feed`) {
      sequence += 1;
      const id = `${PAGE}_${String(1000 + sequence)}`;
      pagePosts.push({ id, message: params.message ?? "", created_time: new Date().toISOString() });
      if (fault === "500") return json({ error: { code: 2, message: "Unexpected" } }, 500);
      if (fault === "refuse") return json({ error: { code: 100, message: "Invalid" } }, 400);
      return json({ id });
    }
    if (
      method === "GET" &&
      path === `/${PAGE}/published_posts` &&
      !(params.fields ?? "").includes("comments")
    ) {
      return json({ data: pagePosts });
    }
    if (method === "GET" && path === `/${PAGE}/feed`) {
      return json({
        data: [
          {
            id: `${PAGE}_1`,
            comments: {
              data: [
                {
                  id: "1001",
                  message: "Do you deliver to Jeddah?",
                  from: { id: "5001", name: "Sara" },
                  created_time: new Date().toISOString(),
                },
                {
                  id: "1002",
                  message: "Thanks all!",
                  from: { id: PAGE, name: "Cafe Page" },
                  created_time: new Date().toISOString(),
                },
              ],
            },
          },
        ],
      });
    }
    return json({ error: { code: 100, message: `unexpected ${key}` } }, 400);
  };
  const posts = () => calls.filter((call) => call.method === "POST");
  return {
    calls,
    faults,
    posts,
    pagePosts,
    otherReplies,
    paging,
    pageListed,
    fetch: fetchImpl,
  };
}

const credits = (trial = 50): CreditsSettings => ({
  trialPeriodCredits: trial,
  prices: { inputPerMTok: null, outputPerMTok: null },
  creditValueMicros: null,
});

function recordingAi(options: FakeProviderOptions = {}, trial = 50) {
  const prompts: string[] = [];
  const base = createFakeProvider(options);
  const provider: AiProvider = {
    name: base.name,
    generate(request) {
      prompts.push(request.user);
      return base.generate(request);
    },
  };
  const ai: AiRuntime = { provider, timeoutMs: 2000, credits: credits(trial), payments: null };
  return { ai, prompts };
}

async function setup(options: { trial?: number } = {}) {
  const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
  const graph = fakeGraph();
  const adapters: AdAdapters = {
    META: {
      platform: "META",
      available: true,
      adapter: createMetaAdapter({
        appId: "1234567890",
        appSecret: "x".repeat(32),
        version: "v26.0",
        fetch: graph.fetch,
      }),
    },
    SNAPCHAT: { platform: "SNAPCHAT", available: false, reason: "not_implemented" },
    TIKTOK: { platform: "TIKTOK", available: false, reason: "not_implemented" },
    WHATSAPP: { platform: "WHATSAPP", available: false, reason: "not_implemented" },
  };
  await system.adConnection.create({
    data: {
      workspaceId: owner.workspaceId,
      platform: "META",
      externalUserId: "42",
      status: "ACTIVE",
      scopes: ["ads_read", "pages_show_list", "pages_manage_engagement", "pages_messaging"],
      tokenCiphertext: encryptToken(KEY, TOKEN, {
        workspaceId: owner.workspaceId,
        platform: "META",
      }),
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const { ai, prompts } = recordingAi({}, options.trial ?? 50);
  const deps: SocialDeps = {
    db,
    ads: { db, adapters, tokenKey: KEY },
    meta: createMetaSocial({ appSecret: "x".repeat(32), version: "v26.0", fetch: graph.fetch }),
    ai,
    sendingEnabled: true,
  };
  await syncChannels(deps, owner);
  const { id: agentId } = await saveAgent(db, owner, null, agentInput());
  const channel = await system.socialChannel.findFirstOrThrow({
    where: { workspaceId: owner.workspaceId, platform: "FACEBOOK" },
  });
  await assignChannel(db, owner, channel.id, agentId, true);
  await setAgentActive(db, owner, agentId, true);
  return { owner, graph, deps, agentId, channel, prompts };
}

const agentInput = (overrides: Record<string, unknown> = {}) => ({
  name: "Reem",
  role: "customer_service",
  language: "auto",
  tone: "Warm and short",
  businessInfo: "Cafe in Riyadh. Open 8am-11pm. We deliver within Riyadh only.",
  faq: [{ q: "Do you deliver?", a: "Within Riyadh only." }],
  policies: "Refunds within 24 hours with the receipt.",
  escalation: "Any complaint about food safety.",
  forbidden: "Politics.",
  mode: "SUGGEST",
  autoCategories: [],
  minConfidence: 85,
  dailyAutoCap: 50,
  ...overrides,
});

let comment = 2000;
function commentEvent(text: string, at = new Date()) {
  comment += 1;
  return {
    object: "page",
    entry: [
      {
        id: PAGE,
        time: Math.floor(at.getTime() / 1000),
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: String(comment),
              post_id: `${PAGE}_9`,
              message: text,
              from: { id: "6001", name: "Omar" },
              created_time: Math.floor(at.getTime() / 1000),
            },
          },
        ],
      },
    ],
  };
}

async function receive(payload: unknown) {
  const events = parseSocialWebhook(payload, new Date());
  if (events === null) throw new Error("not a social payload");
  return ingestEvents(system, db, events);
}

async function receiveOne(setupResult: Awaited<ReturnType<typeof setup>>, text: string) {
  const rows = await receive(commentEvent(text));
  const row = rows.find((candidate) => candidate.workspaceId === setupResult.owner.workspaceId);
  if (row === undefined) throw new Error("not recorded");
  return row.id;
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw error;
  return error;
}

const latestReply = (interactionId: string) =>
  system.socialReply.findFirstOrThrow({ where: { interactionId }, orderBy: { createdAt: "desc" } });
const interactionOf = (id: string) => system.socialInteraction.findUniqueOrThrow({ where: { id } });

async function member(ctx: TenantContext, role: WorkspaceRole) {
  const user = await system.user.create({
    data: { email: `m-${crypto.randomUUID()}@test.flexibx.local`, name: role },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return createTenantContext({ userId: user.id, workspaceId: ctx.workspaceId, role });
}

// ── Inbox ───────────────────────────────────────────────────────────────────

describe("the inbox", () => {
  it("records new comments and messages once, skips echoes, the Page's own comments and old replays", async () => {
    const s = await setup();
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      object: "page",
      entry: [
        {
          id: PAGE,
          time: now,
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "3001",
                post_id: `${PAGE}_1`,
                message: "Hi!",
                from: { id: "7001", name: "Lina" },
                created_time: now,
              },
            },
            // The Page's own comment.
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "3002",
                post_id: `${PAGE}_1`,
                message: "Thanks",
                from: { id: PAGE },
                created_time: now,
              },
            },
            // An edit, not a new comment.
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "edited",
                comment_id: "3001",
                post_id: `${PAGE}_1`,
                message: "Hi!!",
                from: { id: "7001" },
                created_time: now,
              },
            },
            // A replay from last month.
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "3003",
                post_id: `${PAGE}_1`,
                message: "Old",
                from: { id: "7002" },
                created_time: now - 30 * 86_400,
              },
            },
          ],
          messaging: [
            {
              sender: { id: "8001" },
              recipient: { id: PAGE },
              timestamp: Date.now(),
              message: { mid: "m.1", text: "Are you open now?" },
            },
            {
              sender: { id: PAGE },
              recipient: { id: "8001" },
              timestamp: Date.now(),
              message: { mid: "m.2", text: "Yes", is_echo: true },
            },
          ],
        },
      ],
    };
    expect(await receive(payload)).toHaveLength(2);
    // A redelivery records nothing new.
    expect(await receive(payload)).toHaveLength(0);
    const rows = await system.socialInteraction.findMany({
      where: { workspaceId: s.owner.workspaceId },
      orderBy: { kind: "asc" },
    });
    expect(rows.map((row) => [row.kind, row.externalId, row.threadExternalId, row.status])).toEqual(
      [
        ["COMMENT", "3001", `${PAGE}_1`, "NEW"],
        ["MESSAGE", "m.1", "8001", "NEW"],
      ],
    );
  });

  it("gives each workspace that manages the Page its own copy, and none to others", async () => {
    const first = await setup();
    const second = await setup();
    const stranger = await createTenant(system, { role: WorkspaceRole.OWNER });
    await receive(commentEvent("Shared page comment"));
    for (const ws of [first.owner.workspaceId, second.owner.workspaceId]) {
      expect(await system.socialInteraction.count({ where: { workspaceId: ws } })).toBe(1);
    }
    expect(
      await system.socialInteraction.count({ where: { workspaceId: stranger.workspaceId } }),
    ).toBe(0);
    // A disabled channel collects nothing.
    await assignChannel(db, second.owner, second.channel.id, second.agentId, false);
    await receive(commentEvent("After disabling"));
    expect(
      await system.socialInteraction.count({ where: { workspaceId: second.owner.workspaceId } }),
    ).toBe(1);
  });

  it("pulls recent comments without a webhook, skipping the Page's own", async () => {
    const s = await setup();
    const created = await pullRecentComments(s.deps, s.owner, s.channel.id);
    expect(created).toHaveLength(1);
    expect(await pullRecentComments(s.deps, s.owner, s.channel.id)).toHaveLength(0);
  });
});

// ── Drafting and decisions ─────────────────────────────────────────────────

describe("drafting and decisions", () => {
  it("drafts from the agent's knowledge, paid in credits, and waits for a person", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Do you deliver to Jeddah?");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, id)).toBe("awaiting_review");
    const prompt = s.prompts.at(-1) ?? "";
    expect(prompt).toContain("We deliver within Riyadh only.");
    expect(prompt).toContain("Do you deliver to Jeddah?");
    expect(await interactionOf(id)).toMatchObject({
      status: "AWAITING_REVIEW",
      category: "question",
    });
    expect(await latestReply(id)).toMatchObject({ decision: "PENDING", sendStatus: "NOT_SENT" });
    expect(
      await system.creditHold.findFirstOrThrow({ where: { workspaceId: s.owner.workspaceId } }),
    ).toMatchObject({ feature: "social_reply", status: "CAPTURED", capturedAmount: 1 });
    expect(s.graph.posts()).toHaveLength(0);
  });

  it("escalates complaints to a person and ignores spam without replying", async () => {
    const s = await setup();
    const complaint = await receiveOne(s, "I want a refund, this was terrible");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, complaint)).toBe("escalated");
    const spam = await receiveOne(s, "Click here for free money");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, spam)).toBe("ignored");
    expect(await interactionOf(spam)).toMatchObject({ status: "IGNORED", category: "spam" });
  });

  it("sends an approved reply once with the Page's token, and learns from approvals, edits and rejections", async () => {
    const s = await setup();
    const first = await receiveOne(s, "Are you open on Friday?");
    await draftInteraction(s.deps, s.owner.workspaceId, first);
    const draft = await latestReply(first);
    expect(await approveReply(s.deps, s.owner, draft.id, null)).toBe("sent");
    const [post] = s.graph.posts();
    expect(post).toMatchObject({
      path: `/${String(comment)}/comments`,
      token: "PAGE-TOKEN-777000",
      params: { message: draft.draftText },
    });
    expect(await interactionOf(first)).toMatchObject({ status: "REPLIED" });
    expect(await latestReply(first)).toMatchObject({ decision: "APPROVED", sendStatus: "SENT" });
    // Approving again is refused: no second send.
    expect(await rejection(approveReply(s.deps, s.owner, draft.id, null))).toMatchObject({
      fields: [{ code: "social_reply_locked" }],
    });
    expect(s.graph.posts()).toHaveLength(1);

    const second = await receiveOne(s, "Do you have oat milk?");
    await draftInteraction(s.deps, s.owner.workspaceId, second);
    const edited = await latestReply(second);
    await approveReply(s.deps, s.owner, edited.id, "Yes! Oat and almond milk, every day.");
    expect(s.graph.posts().at(-1)?.params.message).toBe("Yes! Oat and almond milk, every day.");

    const third = await receiveOne(s, "Can I book a table for 20?");
    await draftInteraction(s.deps, s.owner.workspaceId, third);
    await rejectReply(
      db,
      s.owner,
      (await latestReply(third)).id,
      "Never confirm group bookings; ask them to call.",
    );
    expect(await interactionOf(third)).toMatchObject({ status: "IGNORED" });

    const lessons = await system.socialLesson.findMany({
      where: { agentId: s.agentId },
      orderBy: { createdAt: "asc" },
    });
    expect(lessons.map((lesson) => [lesson.kind, lesson.source])).toEqual([
      ["EXAMPLE", "approval"],
      ["EXAMPLE", "edit"],
      ["RULE", "rejection"],
    ]);
    // The next draft is grounded in what the team taught.
    const fourth = await receiveOne(s, "Do you have soy milk?");
    await draftInteraction(s.deps, s.owner.workspaceId, fourth);
    const prompt = s.prompts.at(-1) ?? "";
    expect(prompt).toContain("Yes! Oat and almond milk, every day.");
    expect(prompt).toContain("Never confirm group bookings; ask them to call.");
  });

  it("sends once when two senders race for the same reply", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Do you have desserts?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    const reply = await latestReply(id);
    await system.socialReply.update({
      where: { id: reply.id },
      data: { decision: "APPROVED", finalText: "Yes, every day.", decidedAt: new Date() },
    });
    const results = await Promise.allSettled([
      sendReply(s.deps, s.owner.workspaceId, reply.id, s.owner),
      sendReply(s.deps, s.owner.workspaceId, reply.id, s.owner),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(s.graph.posts()).toHaveLength(1);
  });

  it("reconciles a reply whose answer was lost instead of sending it twice", async () => {
    const s = await setup();
    const id = await receiveOne(s, "What time do you close?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    s.graph.faults.set(`POST /${String(comment)}/comments`, "500");
    const reply = await latestReply(id);
    expect(await approveReply(s.deps, s.owner, reply.id, null)).toBe("uncertain");
    expect(await interactionOf(id)).toMatchObject({ status: "UNCERTAIN" });
    // The platform shows the Page's reply: it was sent; nothing is posted again.
    expect(await resolveUncertainReply(s.deps, s.owner, reply.id, "check")).toBe("sent");
    expect(await latestReply(id)).toMatchObject({ sendStatus: "SENT" });
    expect(s.graph.posts()).toHaveLength(1);
  });

  it("never answers a private message after 24 hours", async () => {
    const s = await setup();
    const old = new Date(Date.now() - 25 * 3_600_000);
    const [row] = await receive({
      object: "page",
      entry: [
        {
          id: PAGE,
          time: Math.floor(old.getTime() / 1000),
          messaging: [
            {
              sender: { id: "8101" },
              recipient: { id: PAGE },
              timestamp: old.getTime(),
              message: { mid: "m.old", text: "Hello?" },
            },
          ],
        },
      ],
    });
    if (row === undefined) throw new Error("not recorded");
    await draftInteraction(s.deps, s.owner.workspaceId, row.id);
    expect(await approveReply(s.deps, s.owner, (await latestReply(row.id)).id, null)).toBe(
      "failed",
    );
    expect(await interactionOf(row.id)).toMatchObject({
      status: "FAILED",
      lastError: "window_closed",
    });
    expect(s.graph.posts()).toHaveLength(0);
  });

  it("drafts nothing (and charges nothing) without credits, or without a member to act for", async () => {
    const s = await setup({ trial: 0 });
    const id = await receiveOne(s, "Hello?");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, id)).toBe("failed");
    expect(await interactionOf(id)).toMatchObject({
      status: "FAILED",
      lastError: "credits_insufficient",
    });
    expect(await system.socialReply.count({ where: { interactionId: id } })).toBe(0);

    const t = await setup();
    await system.workspaceMember.deleteMany({
      where: { workspaceId: t.owner.workspaceId, userId: t.owner.userId },
    });
    const other = await receiveOne(t, "Hi");
    expect(await draftInteraction(t.deps, t.owner.workspaceId, other)).toBe("failed");
    expect(await interactionOf(other)).toMatchObject({ lastError: "agent_delegate_missing" });
  });
});

// ── AUTO mode ───────────────────────────────────────────────────────────────

describe("automatic replies", () => {
  it("sends only confident replies in allowed categories, within the daily cap and the emergency stop", async () => {
    const s = await setup();
    await saveAgent(
      db,
      s.owner,
      s.agentId,
      agentInput({ mode: "AUTO", autoCategories: ["question"], dailyAutoCap: 2 }),
    );
    const question = await receiveOne(s, "Do you have parking?");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, question)).toBe("auto_sent");
    expect(await latestReply(question)).toMatchObject({ decision: "AUTO", sendStatus: "SENT" });

    // A complaint is never automatic.
    const complaint = await receiveOne(s, "I want a refund now");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, complaint)).toBe("escalated");

    // The emergency stop holds automatic replies for a person.
    await updateAutomationPolicy(db, s.owner, {
      enabled: false,
      planningCadence: "OFF",
      allowDrafts: false,
      maxDraftsPerRun: "1",
    });
    await setAutomationPaused(db, s.owner, true);
    const paused = await receiveOne(s, "Is there wifi?");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, paused)).toBe("awaiting_review");
    await setAutomationPaused(db, s.owner, false);

    // Daily cap 2: one more automatic reply, then people decide.
    expect(
      await draftInteraction(
        s.deps,
        s.owner.workspaceId,
        await receiveOne(s, "Do you sell beans?"),
      ),
    ).toBe("auto_sent");
    expect(
      await draftInteraction(s.deps, s.owner.workspaceId, await receiveOne(s, "Do you sell cups?")),
    ).toBe("awaiting_review");
    expect(s.graph.posts()).toHaveLength(2);
  });
});

describe("automatic replies stay inside the agent's limits", () => {
  it("leaves a reply for a person when its category is not allowed or its confidence is too low", async () => {
    const s = await setup();
    // The fake agent answers questions with confidence 92.
    await saveAgent(
      db,
      s.owner,
      s.agentId,
      agentInput({ mode: "AUTO", autoCategories: ["praise"] }),
    );
    const notAllowed = await receiveOne(s, "Do you open early?");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, notAllowed)).toBe("awaiting_review");
    await saveAgent(
      db,
      s.owner,
      s.agentId,
      agentInput({ mode: "AUTO", autoCategories: ["question"], minConfidence: 95 }),
    );
    const unsure = await receiveOne(s, "Do you open late?");
    expect(await draftInteraction(s.deps, s.owner.workspaceId, unsure)).toBe("awaiting_review");
    expect(s.graph.posts()).toHaveLength(0);
  });
});

// ── Learning ────────────────────────────────────────────────────────────────

describe("self-improvement", () => {
  it("proposes improved guidance from feedback, which applies only when a person accepts it", async () => {
    const s = await setup();
    expect(await rejection(runSelfReview(s.deps, s.owner, s.agentId))).toMatchObject({
      fields: [{ code: "social_nothing_to_learn" }],
    });
    const id = await receiveOne(s, "Do you cater weddings?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    await rejectReply(
      db,
      s.owner,
      (await latestReply(id)).id,
      "We do not cater; suggest our gift cards.",
    );
    const { lessonId } = await runSelfReview(s.deps, s.owner, s.agentId);
    const proposal = await system.socialLesson.findUniqueOrThrow({ where: { id: lessonId } });
    expect(proposal).toMatchObject({ kind: "GUIDANCE", status: "PROPOSED" });
    expect(s.prompts.at(-1)).toContain("We do not cater; suggest our gift cards.");
    expect(
      (await system.socialAgent.findUniqueOrThrow({ where: { id: s.agentId } })).guidanceVersion,
    ).toBe(0);

    await applyGuidance(db, s.owner, lessonId);
    const agent = await system.socialAgent.findUniqueOrThrow({ where: { id: s.agentId } });
    expect(agent).toMatchObject({ guidance: proposal.content, guidanceVersion: 1 });
    const next = await receiveOne(s, "Hello");
    await draftInteraction(s.deps, s.owner.workspaceId, next);
    expect(s.prompts.at(-1)).toContain(proposal.content);
    expect(await latestReply(next)).toMatchObject({ guidanceVersion: 1 });
  });

  it("reports real counts only", async () => {
    const s = await setup();
    const sent = await receiveOne(s, "Open today?");
    await draftInteraction(s.deps, s.owner.workspaceId, sent);
    await approveReply(s.deps, s.owner, (await latestReply(sent)).id, "Yes, until 11pm.");
    const metrics = await socialMetrics(
      db,
      s.owner.workspaceId,
      s.agentId,
      new Date(Date.now() - 86_400_000),
    );
    expect(metrics).toMatchObject({
      received: 1,
      replied: 1,
      edited: 1,
      approvedUnchanged: 0,
      acceptanceRate: 0,
    });
  });
});

// ── Roles, workspaces, scheduler ───────────────────────────────────────────

describe("roles, workspaces and the scheduler", () => {
  it("lets managers reply but not configure agents, and keeps workspaces apart", async () => {
    const s = await setup();
    const manager = await member(s.owner, WorkspaceRole.MANAGER);
    const viewer = await member(s.owner, WorkspaceRole.VIEWER);
    const id = await receiveOne(s, "Hi there");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    const reply = await latestReply(id);
    expect(await rejection(approveReply(s.deps, viewer, reply.id, null))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      await rejection(saveAgent(db, manager, s.agentId, agentInput({ mode: "AUTO" }))),
    ).toMatchObject({ code: "FORBIDDEN" });
    const stranger = await createTenant(system, { role: WorkspaceRole.OWNER });
    expect(await rejection(approveReply(s.deps, stranger, reply.id, null))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await approveReply(s.deps, manager, reply.id, null)).toBe("sent");
  });

  it("drafts what was missed and marks sends stuck without an answer as uncertain", async () => {
    const s = await setup();
    const missed = await receiveOne(s, "Anyone there?");
    const summary = await socialSweep(s.deps, system);
    expect(summary).toMatchObject({ drafted: 1 });
    expect(await interactionOf(missed)).toMatchObject({ status: "AWAITING_REVIEW" });
    const reply = await latestReply(missed);
    await system.socialReply.update({
      where: { id: reply.id },
      data: { decision: "APPROVED", finalText: "Yes!", sendStatus: "SENDING" },
    });
    await system.$executeRaw`UPDATE social_replies SET updated_at = now() - interval '1 hour' WHERE id = ${reply.id}::uuid`;
    expect(await socialSweep(s.deps, system)).toMatchObject({ uncertain: 1 });
    expect(await latestReply(missed)).toMatchObject({ sendStatus: "UNCERTAIN" });
    expect(s.graph.posts()).toHaveLength(0);
  });
});

// ── Publishing to the Page ─────────────────────────────────────────────────

describe("publishing approved content to the Page", () => {
  async function content(
    ctx: TenantContext,
    status: "DRAFT" | "APPROVED" | "SCHEDULED",
    scheduledAt: Date | null = null,
  ) {
    return system.contentItem.create({
      data: {
        workspaceId: ctx.workspaceId,
        title: "Autumn menu",
        body: "Our autumn menu is here: pumpkin latte and fresh pastries.",
        status,
        scheduledAt,
        metadata: { link: "https://cafe.example/menu" },
      },
    });
  }

  it("publishes approved content once at its time, then marks the content published", async () => {
    const s = await setup();
    const draft = await content(s.owner, "DRAFT");
    expect(await rejection(queuePost(s.deps, s.owner, draft.id, s.channel.id))).toMatchObject({
      fields: [{ code: "social_content_not_approved" }],
    });
    const later = new Date(Date.now() + 3_600_000);
    const item = await content(s.owner, "SCHEDULED", later);
    await queuePost(s.deps, s.owner, item.id, s.channel.id);
    // Not due yet.
    expect(await socialSweep(s.deps, system)).toMatchObject({ published: 0 });
    expect(await socialSweep(s.deps, system, new Date(later.getTime() + 1000))).toMatchObject({
      published: 1,
    });
    const [post] = s.graph.posts();
    expect(post).toMatchObject({
      path: `/${PAGE}/feed`,
      token: "PAGE-TOKEN-777000",
      params: { message: item.body, link: "https://cafe.example/menu" },
    });
    expect(await system.contentItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      status: "PUBLISHED",
    });
    // Nothing is posted twice.
    await socialSweep(s.deps, system, new Date(later.getTime() + 60_000));
    expect(s.graph.posts()).toHaveLength(1);
  });

  it("cancels a post whose content went back to draft, and holds posts under the emergency stop", async () => {
    const s = await setup();
    const item = await content(s.owner, "APPROVED");
    await queuePost(s.deps, s.owner, item.id, s.channel.id);
    await system.contentItem.update({ where: { id: item.id }, data: { status: "DRAFT" } });
    await socialSweep(s.deps, system);
    expect(
      await system.socialPost.findFirstOrThrow({ where: { contentItemId: item.id } }),
    ).toMatchObject({ status: "CANCELLED", errorCode: "content_not_approved" });

    const held = await content(s.owner, "APPROVED");
    await queuePost(s.deps, s.owner, held.id, s.channel.id);
    await updateAutomationPolicy(db, s.owner, {
      enabled: false,
      planningCadence: "OFF",
      allowDrafts: false,
      maxDraftsPerRun: "1",
    });
    await setAutomationPaused(db, s.owner, true);
    await socialSweep(s.deps, system);
    expect(s.graph.posts()).toHaveLength(0);
    await setAutomationPaused(db, s.owner, false);
    expect(await socialSweep(s.deps, system)).toMatchObject({ published: 1 });
  });

  it("publishes once when two publishers race, and never before the post's time", async () => {
    const s = await setup();
    const future = await content(s.owner, "SCHEDULED", new Date(Date.now() + 3_600_000));
    const early = await queuePost(s.deps, s.owner, future.id, s.channel.id);
    expect(await publishPost(s.deps, s.owner.workspaceId, early.postId)).toBe("skipped");
    const item = await content(s.owner, "APPROVED");
    const { postId } = await queuePost(s.deps, s.owner, item.id, s.channel.id);
    const outcomes = await Promise.all([
      publishPost(s.deps, s.owner.workspaceId, postId),
      publishPost(s.deps, s.owner.workspaceId, postId),
    ]);
    expect(outcomes.filter((outcome) => outcome === "published")).toHaveLength(1);
    expect(s.graph.posts()).toHaveLength(1);
  });

  it("finds a post whose answer was lost instead of posting it again", async () => {
    const s = await setup();
    const item = await content(s.owner, "APPROVED");
    const { postId } = await queuePost(s.deps, s.owner, item.id, s.channel.id);
    s.graph.faults.set(`POST /${PAGE}/feed`, "500");
    await socialSweep(s.deps, system);
    expect(await system.socialPost.findUniqueOrThrow({ where: { id: postId } })).toMatchObject({
      status: "UNCERTAIN",
    });
    await socialSweep(s.deps, system);
    expect(s.graph.posts()).toHaveLength(1);
    expect(await resolveUncertainPost(s.deps, s.owner, postId)).toBe("published");
    expect(await system.contentItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      status: "PUBLISHED",
    });
  });

  it("lets only people who may publish queue or cancel posts", async () => {
    const s = await setup();
    const editor = await member(s.owner, WorkspaceRole.EDITOR);
    const item = await content(s.owner, "APPROVED");
    expect(await rejection(queuePost(s.deps, editor, item.id, s.channel.id))).toMatchObject({
      code: "FORBIDDEN",
    });
    const { postId } = await queuePost(s.deps, s.owner, item.id, s.channel.id);
    expect(await rejection(cancelPost(s.deps, editor, postId))).toMatchObject({
      code: "FORBIDDEN",
    });
    await cancelPost(s.deps, s.owner, postId);
    await socialSweep(s.deps, system);
    expect(s.graph.posts()).toHaveLength(0);
  });
});

// ── Final review: claims, held system sends, stuck publications ────────────

describe("one draft per message, and system sends that wait", () => {
  it("never drafts a message whose drafting attempt is still running elsewhere", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Do you have oat milk?");
    // Another runner claimed it and is waiting for the AI (status stays NEW meanwhile).
    await system.socialInteraction.update({
      where: { id },
      data: {
        version: { increment: 1 },
        draftAttempts: 1,
        draftingUntil: new Date(Date.now() + 60_000),
      },
    });
    expect(await draftInteraction(s.deps, s.owner.workspaceId, id)).toBe("skipped");
    expect(await socialSweep(s.deps, system)).toMatchObject({ drafted: 0 });
    expect(await system.socialReply.count({ where: { interactionId: id } })).toBe(0);
    // That attempt died: once its lease is over, the message is drafted, once.
    await system.socialInteraction.update({
      where: { id },
      data: { draftingUntil: new Date(Date.now() - 1000) },
    });
    expect(await draftInteraction(s.deps, s.owner.workspaceId, id)).toBe("awaiting_review");
    expect(await system.socialReply.count({ where: { interactionId: id } })).toBe(1);
    expect(await interactionOf(id)).toMatchObject({ draftingUntil: null });
  });

  it("holds automatic sends under the emergency stop, and without a delegate allowed to send them", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Do you have parking?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    const reply = await latestReply(id);
    await system.socialReply.update({
      where: { id: reply.id },
      data: {
        decision: "AUTO",
        finalText: "Yes, behind the cafe.",
        decidedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await updateAutomationPolicy(db, s.owner, {
      enabled: false,
      planningCadence: "OFF",
      allowDrafts: false,
      maxDraftsPerRun: "1",
    });
    await setAutomationPaused(db, s.owner, true);
    expect(await socialSweep(s.deps, system)).toMatchObject({ sent: 0 });
    expect(await latestReply(id)).toMatchObject({ sendStatus: "NOT_SENT" });
    await setAutomationPaused(db, s.owner, false);

    // The delegate lost the right to send automatic replies (demoted to editor).
    await system.workspaceMember.updateMany({
      where: { workspaceId: s.owner.workspaceId, userId: s.owner.userId },
      data: { role: "EDITOR" },
    });
    expect(await socialSweep(s.deps, system)).toMatchObject({ sent: 0 });
    expect(s.graph.posts()).toHaveLength(0);

    await system.workspaceMember.updateMany({
      where: { workspaceId: s.owner.workspaceId, userId: s.owner.userId },
      data: { role: "OWNER" },
    });
    expect(await socialSweep(s.deps, system)).toMatchObject({ sent: 1 });
    expect(s.graph.posts()).toHaveLength(1);
  });

  it("marks a publication stuck without an answer as uncertain instead of leaving it publishing", async () => {
    const s = await setup();
    const item = await system.contentItem.create({
      data: {
        workspaceId: s.owner.workspaceId,
        title: "Winter hours",
        body: "We now open at 7am.",
        status: "APPROVED",
      },
    });
    const { postId } = await queuePost(s.deps, s.owner, item.id, s.channel.id);
    await system.socialPost.update({ where: { id: postId }, data: { status: "PUBLISHING" } });
    await system.$executeRaw`UPDATE social_posts SET updated_at = now() - interval '1 hour' WHERE id = ${postId}::uuid`;
    await socialSweep(s.deps, system);
    expect(await system.socialPost.findUniqueOrThrow({ where: { id: postId } })).toMatchObject({
      status: "UNCERTAIN",
      errorCode: "no_answer",
    });
    expect(s.graph.posts()).toHaveLength(0);
  });
});

// ── Automatic replies under concurrency, and Pages shared by workspaces ────

describe("automatic replies under concurrency", () => {
  const auto = (cap: number) =>
    agentInput({ mode: "AUTO", autoCategories: ["question"], dailyAutoCap: cap });

  it("answers a comment once when two workspaces manage the same Page with AUTO agents", async () => {
    const agency = await setup();
    const client = await setup();
    await saveAgent(db, agency.owner, agency.agentId, auto(50));
    await saveAgent(db, client.owner, client.agentId, auto(50));
    // One comment on the shared Page: each workspace records its own copy (isolation).
    const rows = await receive(commentEvent("Do you have gluten-free bread?"));
    const mine = (ctx: TenantContext) => {
      const row = rows.find((candidate) => candidate.workspaceId === ctx.workspaceId);
      if (row === undefined) throw new Error("not recorded");
      return row.id;
    };
    const outcomes = await Promise.all([
      draftInteraction(agency.deps, agency.owner.workspaceId, mine(agency.owner)),
      draftInteraction(client.deps, client.owner.workspaceId, mine(client.owner)),
    ]);
    expect(outcomes.filter((outcome) => outcome === "auto_sent")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "awaiting_review")).toHaveLength(1);
    // Exactly one public reply on the Page; the other workspace's draft waits for a person.
    expect(agency.graph.posts().length + client.graph.posts().length).toBe(1);
    expect(await system.socialAutoReplyClaim.count()).toBe(1);
    const loser = outcomes[0] === "auto_sent" ? client : agency;
    const loserReply = await latestReply(mine(loser.owner));
    expect(loserReply).toMatchObject({ decision: "PENDING", sendStatus: "NOT_SENT" });
  });

  it("never goes over the daily cap when several comments are drafted at once", async () => {
    const s = await setup();
    await saveAgent(db, s.owner, s.agentId, auto(2));
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push(await receiveOne(s, `Do you have size ${String(i)}?`));
    const outcomes = await Promise.all(
      ids.map((id) => draftInteraction(s.deps, s.owner.workspaceId, id)),
    );
    expect(outcomes.filter((outcome) => outcome === "auto_sent")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === "awaiting_review")).toHaveLength(4);
    expect(
      await system.socialReply.count({
        where: { workspaceId: s.owner.workspaceId, decision: "AUTO" },
      }),
    ).toBe(2);
    expect(s.graph.posts()).toHaveLength(2);
  });
});

describe("the automatic decision itself", () => {
  it("counts and uses the daily cap atomically when decisions run in parallel", async () => {
    const s = await setup();
    // Six drafts waiting (drafted while the agent only suggested).
    const replies = [];
    for (let i = 0; i < 6; i += 1) {
      const id = await receiveOne(s, `Is the ${String(i)}th branch open?`);
      await draftInteraction(s.deps, s.owner.workspaceId, id);
      const interaction = await interactionOf(id);
      replies.push({ reply: await latestReply(id), interaction });
    }
    // All six decided at the same moment, each in its own transaction.
    const results = await Promise.all(
      replies.map(({ reply, interaction }) =>
        decideAutomatically(db, new Date(), {
          workspaceId: s.owner.workspaceId,
          agentId: s.agentId,
          dailyAutoCap: 2,
          replyId: reply.id,
          finalText: "Yes, every day.",
          interaction: {
            id: interaction.id,
            platform: "FACEBOOK",
            channelExternalId: PAGE,
            externalId: interaction.externalId,
          },
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(
      await system.socialReply.count({
        where: { workspaceId: s.owner.workspaceId, decision: "AUTO" },
      }),
    ).toBe(2);
  });
});

// ── Phase A/B hardening: the global switch, channel access, claims and recovery ──

describe("the global sending switch, channel access and recovery", () => {
  const auto = (overrides: Record<string, unknown> = {}) =>
    agentInput({ mode: "AUTO", autoCategories: ["question"], ...overrides });
  const replies = (graph: { posts: () => { path: string }[] }) =>
    graph.posts().filter((call) => /\/(comments|replies|messages)$/.test(call.path)).length;
  const approved = async (ctx: TenantContext) =>
    system.contentItem.create({
      data: { workspaceId: ctx.workspaceId, title: "Hours", body: "Open 7am.", status: "APPROVED" },
    });
  function messageEvent(sender: string, mid: string) {
    const at = new Date();
    return {
      object: "page",
      entry: [
        {
          id: PAGE,
          time: Math.floor(at.getTime() / 1000),
          messaging: [
            {
              sender: { id: sender },
              recipient: { id: PAGE },
              timestamp: at.getTime(),
              message: { mid, text: "Do you have a table for two?" },
            },
          ],
        },
      ],
    };
  }
  const rowOf = (rows: readonly { workspaceId: string; id: string }[], ctx: TenantContext) => {
    const row = rows.find((candidate) => candidate.workspaceId === ctx.workspaceId);
    if (row === undefined) throw new Error("not recorded");
    return row.id;
  };

  it("sends and publishes nothing from any path while SOCIAL_SENDING_ENABLED is off", async () => {
    const s = await setup();
    await saveAgent(db, s.owner, s.agentId, auto());
    const off: SocialDeps = { ...s.deps, sendingEnabled: false };
    // An AUTO agent only drafts: the reply waits for a person.
    const id = await receiveOne(s, "Do you have parking?");
    expect(await draftInteraction(off, s.owner.workspaceId, id)).toBe("awaiting_review");
    const reply = await latestReply(id);
    // A person approving is refused, and nothing is decided.
    expect(await rejection(approveReply(off, s.owner, reply.id, null))).toMatchObject({
      fields: [{ code: "social_sending_disabled" }],
    });
    expect(await latestReply(id)).toMatchObject({ decision: "PENDING" });
    // A reply decided earlier is neither sent by the sweep nor by a retry.
    await system.socialReply.update({
      where: { id: reply.id },
      data: {
        decision: "APPROVED",
        finalText: "Yes.",
        decidedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    expect(await rejection(retryReply(off, s.owner, reply.id))).toMatchObject({
      fields: [{ code: "social_sending_disabled" }],
    });
    // Publishing is held as well.
    const { postId } = await queuePost(off, s.owner, (await approved(s.owner)).id, s.channel.id);
    expect(await publishPost(off, s.owner.workspaceId, postId)).toBe("skipped");
    expect(await socialSweep(off, system)).toMatchObject({ sent: 0, published: 0 });
    expect(s.graph.posts().filter((call) => call.path !== `/${PAGE}/subscribed_apps`)).toHaveLength(
      0,
    );
    // Switched on: the same reply and post go out once.
    expect(await socialSweep(s.deps, system)).toMatchObject({ sent: 1, published: 1 });
  });

  it("never lets a paused workspace's backlog block other workspaces' posts", async () => {
    const paused = await setup();
    const other = await setup();
    for (let i = 0; i < 30; i += 1) {
      const { postId } = await queuePost(
        paused.deps,
        paused.owner,
        (await approved(paused.owner)).id,
        paused.channel.id,
      );
      await system.socialPost.update({
        where: { id: postId },
        data: { scheduledAt: new Date(Date.now() - 3_600_000) },
      });
    }
    await updateAutomationPolicy(db, paused.owner, {
      enabled: false,
      planningCadence: "OFF",
      allowDrafts: false,
      maxDraftsPerRun: "1",
    });
    await setAutomationPaused(db, paused.owner, true);
    await queuePost(other.deps, other.owner, (await approved(other.owner)).id, other.channel.id);
    expect(await socialSweep(other.deps, system)).toMatchObject({ published: 1 });
    expect(paused.graph.posts()).toHaveLength(0);
  });

  it("sends a reply held too long back to a person, and frees its automatic claim", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Is there wifi?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    const interaction = await interactionOf(id);
    const decided = await decideAutomatically(db, new Date(Date.now() - 3 * 3_600_000), {
      workspaceId: s.owner.workspaceId,
      agentId: s.agentId,
      dailyAutoCap: 10,
      replyId: (await latestReply(id)).id,
      finalText: "Yes, free wifi.",
      interaction: {
        id,
        platform: "FACEBOOK",
        channelExternalId: PAGE,
        externalId: interaction.externalId,
      },
    });
    expect(decided).toBe(true);
    expect(await system.socialAutoReplyClaim.count()).toBe(1);
    expect(await socialSweep(s.deps, system)).toMatchObject({ sent: 0 });
    expect(await latestReply(id)).toMatchObject({ sendStatus: "FAILED", sendError: "stale" });
    expect(await interactionOf(id)).toMatchObject({ status: "FAILED", lastError: "stale_reply" });
    expect(await system.socialAutoReplyClaim.count()).toBe(0);
    expect(replies(s.graph)).toBe(0);
  });

  it("fails a scheduled post held past its time instead of publishing it late", async () => {
    const s = await setup();
    const { postId } = await queuePost(s.deps, s.owner, (await approved(s.owner)).id, s.channel.id);
    await system.socialPost.update({
      where: { id: postId },
      data: { scheduledAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    expect(await publishPost(s.deps, s.owner.workspaceId, postId)).toBe("failed");
    expect(await system.socialPost.findUniqueOrThrow({ where: { id: postId } })).toMatchObject({
      status: "FAILED",
      errorCode: "missed_window",
    });
    expect(s.graph.posts()).toHaveLength(0);
  });

  it("only a workspace with a usable Meta grant receives, drafts and is charged", async () => {
    const live = await setup();
    const lost = await setup();
    const first = await receive(commentEvent("Open on Friday?"));
    const pending = rowOf(first, lost.owner);
    await system.adConnection.updateMany({
      where: { workspaceId: lost.owner.workspaceId },
      data: { status: "EXPIRED" },
    });
    // Recorded before the grant expired: not drafted, nothing charged.
    expect(await draftInteraction(lost.deps, lost.owner.workspaceId, pending)).toBe("skipped");
    expect(await system.socialReply.count({ where: { interactionId: pending } })).toBe(0);
    expect(await system.creditHold.count({ where: { workspaceId: lost.owner.workspaceId } })).toBe(
      0,
    );
    // New events reach only the workspace that still has the Page.
    const second = await receive(commentEvent("And on Saturday?"));
    expect(second.map((row) => row.workspaceId)).toEqual([live.owner.workspaceId]);
  });

  it("disables the Pages and frees their claims when the person removes the Meta app", async () => {
    const agency = await setup();
    const client = await setup();
    await system.adConnection.updateMany({
      where: { workspaceId: client.owner.workspaceId },
      data: { externalUserId: "43" },
    });
    await saveAgent(db, agency.owner, agency.agentId, auto());
    await saveAgent(db, client.owner, client.agentId, auto());
    const rows = await receive(commentEvent("Do you cater events?"));
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(rows, agency.owner)),
    ).toBe("auto_sent");
    expect(await system.socialAutoReplyClaim.count()).toBe(1);

    await forgetMetaUser({ system, db }, { userId: "42", issuedAt: null }, "deauthorize");
    expect(
      await system.socialChannel.count({
        where: { workspaceId: agency.owner.workspaceId, enabled: true },
      }),
    ).toBe(0);
    expect(await system.socialAutoReplyClaim.count()).toBe(0);
    const audit = await system.auditLog.findFirstOrThrow({
      where: { workspaceId: agency.owner.workspaceId, action: "ads.platform_deauthorized" },
    });
    expect(audit.metadata).toMatchObject({ socialChannelsDisabled: 2 });
    // The client still manages the Page: it alone receives and answers from now on.
    const next = await receive(commentEvent("Do you cater weddings?"));
    expect(next.map((row) => row.workspaceId)).toEqual([client.owner.workspaceId]);
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(next, client.owner)),
    ).toBe("auto_sent");
  });

  it("disables the Pages when the workspace disconnects Meta itself", async () => {
    const s = await setup();
    await disconnect(db, s.owner, "META");
    expect(
      await system.socialChannel.count({
        where: { workspaceId: s.owner.workspaceId, enabled: true },
      }),
    ).toBe(0);
    expect(await receive(commentEvent("Still open?"))).toEqual([]);
  });

  it("disables a channel whose Page left the grant when a send finds it gone", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Do you have vegan options?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    s.graph.pageListed.value = false;
    expect(await approveReply(s.deps, s.owner, (await latestReply(id)).id, null)).toBe("failed");
    expect(
      await system.socialChannel.findUniqueOrThrow({ where: { id: s.channel.id } }),
    ).toMatchObject({
      enabled: false,
    });
    expect(
      await system.auditLog.count({
        where: { workspaceId: s.owner.workspaceId, action: "social.access_revoked" },
      }),
    ).toBe(1);
    expect(replies(s.graph)).toBe(0);
  });

  it("frees a claim when an automatic reply definitively fails, and keeps it when unsure", async () => {
    const agency = await setup();
    const client = await setup();
    await saveAgent(db, agency.owner, agency.agentId, auto());
    await saveAgent(db, client.owner, client.agentId, auto());

    const refused = await receive(commentEvent("Is the terrace open?"));
    agency.graph.faults.set(`POST /${String(comment)}/comments`, "refuse");
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(refused, agency.owner)),
    ).toBe("failed");
    expect(await system.socialAutoReplyClaim.count()).toBe(0);
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(refused, client.owner)),
    ).toBe("auto_sent");

    const unsure = await receive(commentEvent("Is the kitchen open late?"));
    agency.graph.faults.set(`POST /${String(comment)}/comments`, "500");
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(unsure, agency.owner)),
    ).toBe("auto_uncertain");
    // It may have reached the customer: the other workspace does not answer it as well.
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(unsure, client.owner)),
    ).toBe("awaiting_review");
  });

  it("lets one workspace answer a whole private conversation automatically", async () => {
    const agency = await setup();
    const client = await setup();
    await saveAgent(db, agency.owner, agency.agentId, auto());
    await saveAgent(db, client.owner, client.agentId, auto());
    const first = await receive(messageEvent("8301", "m.first"));
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(first, agency.owner)),
    ).toBe("auto_sent");
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(first, client.owner)),
    ).toBe("awaiting_review");
    // The next message in the same conversation: the same workspace keeps answering.
    const second = await receive(messageEvent("8301", "m.second"));
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(second, client.owner)),
    ).toBe("awaiting_review");
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(second, agency.owner)),
    ).toBe("auto_sent");
    expect(replies(agency.graph)).toBe(2);
    expect(replies(client.graph)).toBe(0);
  });

  it("never retries a reply that a newer draft replaced", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Can I bring my dog?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    const old = await latestReply(id);
    s.graph.faults.set(`POST /${String(comment)}/comments`, "refuse");
    expect(await approveReply(s.deps, s.owner, old.id, null)).toBe("failed");
    await redraftInteraction(s.deps, s.owner, id);
    expect((await latestReply(id)).id).not.toBe(old.id);
    expect(await rejection(retryReply(s.deps, s.owner, old.id))).toMatchObject({
      fields: [{ code: "social_reply_superseded" }],
    });
    expect(replies(s.graph)).toBe(1);
  });

  it("reads every page of replies before deciding, and stays unsure when it cannot", async () => {
    const s = await setup();
    s.graph.paging.size = 100;
    const id = await receiveOne(s, "Do you sell gift cards?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    s.graph.faults.set(`POST /${String(comment)}/comments`, "500");
    s.graph.otherReplies.set(String(comment), 150);
    const reply = await latestReply(id);
    expect(await approveReply(s.deps, s.owner, reply.id, null)).toBe("uncertain");
    // The Page's reply is on the second page: found, so it is sent — never sent again.
    expect(await resolveUncertainReply(s.deps, s.owner, reply.id, "check")).toBe("sent");

    const other = await receiveOne(s, "Do you sell beans online?");
    await draftInteraction(s.deps, s.owner.workspaceId, other);
    s.graph.faults.set(`POST /${String(comment)}/comments`, "500");
    s.graph.otherReplies.set(String(comment), 100 * MAX_LOOKUP_REQUESTS + 5);
    const unsure = await latestReply(other);
    expect(await approveReply(s.deps, s.owner, unsure.id, null)).toBe("uncertain");
    expect(
      await rejection(resolveUncertainReply(s.deps, s.owner, unsure.id, "check")),
    ).toMatchObject({
      fields: [{ code: "social_cannot_verify" }],
    });
    expect(await latestReply(other)).toMatchObject({ sendStatus: "UNCERTAIN" });
    expect(replies(s.graph)).toBe(2);
  });

  it("reconciles a reply whose connection dropped after Meta accepted it", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Do you open on holidays?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    s.graph.faults.set(`POST /${String(comment)}/comments`, "drop");
    const reply = await latestReply(id);
    expect(await approveReply(s.deps, s.owner, reply.id, null)).toBe("uncertain");
    expect(await resolveUncertainReply(s.deps, s.owner, reply.id, "check")).toBe("sent");
    expect(replies(s.graph)).toBe(1);
  });
});

// ── Message ownership across workspaces, and the Meta grant's life cycle ────

describe("message ownership across workspaces", () => {
  const auto = () => agentInput({ mode: "AUTO", autoCategories: ["question"] });
  const rowOf = (rows: readonly { workspaceId: string; id: string }[], ctx: TenantContext) => {
    const row = rows.find((candidate) => candidate.workspaceId === ctx.workspaceId);
    if (row === undefined) throw new Error("not recorded");
    return row.id;
  };
  const sent = (graph: { posts: () => { path: string }[] }) =>
    graph.posts().filter((call) => /\/(comments|replies|messages)$/.test(call.path)).length;
  function message(sender: string, mid: string) {
    const at = new Date();
    return {
      object: "page",
      entry: [
        {
          id: PAGE,
          time: Math.floor(at.getTime() / 1000),
          messaging: [
            {
              sender: { id: sender },
              recipient: { id: PAGE },
              timestamp: at.getTime(),
              message: { mid, text: "Is there a table for four tonight?" },
            },
          ],
        },
      ],
    };
  }
  async function pair() {
    const agency = await setup();
    const client = await setup();
    await saveAgent(db, agency.owner, agency.agentId, auto());
    await saveAgent(db, client.owner, client.agentId, auto());
    return { agency, client };
  }
  const lapse = () =>
    system.$executeRaw`UPDATE social_auto_reply_claims SET created_at = now() - interval '25 hours'`;

  it("lets another workspace take over a conversation once its claim lapsed", async () => {
    const { agency, client } = await pair();
    const first = await receive(message("8401", "m.1"));
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(first, agency.owner)),
    ).toBe("auto_sent");
    // A day of silence from the owner: the next message may be answered by the other team.
    await lapse();
    const next = await receive(message("8401", "m.2"));
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(next, client.owner)),
    ).toBe("auto_sent");
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(next, agency.owner)),
    ).toBe("awaiting_review");
    expect(sent(agency.graph) + sent(client.graph)).toBe(2);
  });

  it("keeps the conversation with its owner when one of its messages definitively fails", async () => {
    const { agency, client } = await pair();
    const first = await receive(message("8403", "m.1"));
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(first, agency.owner)),
    ).toBe("auto_sent");
    const second = await receive(message("8403", "m.2"));
    agency.graph.faults.set(`POST /${PAGE}/messages`, "refuse");
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(second, agency.owner)),
    ).toBe("failed");
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(second, client.owner)),
    ).toBe("awaiting_review");
    expect(sent(client.graph)).toBe(0);
  });

  it("never takes over while the owner's reply may still reach the customer", async () => {
    const { agency, client } = await pair();
    const first = await receive(message("8402", "m.1"));
    agency.graph.faults.set(`POST /${PAGE}/messages`, "500");
    // The send's outcome is unknown (UNCERTAIN): it may have reached the customer.
    const outcome = await draftInteraction(
      agency.deps,
      agency.owner.workspaceId,
      rowOf(first, agency.owner),
    );
    expect(["auto_uncertain", "auto_sent"]).toContain(outcome);
    await system.socialReply.updateMany({
      where: { workspaceId: agency.owner.workspaceId },
      data: { sendStatus: "UNCERTAIN" },
    });
    await lapse();
    const next = await receive(message("8402", "m.2"));
    expect(
      await draftInteraction(client.deps, client.owner.workspaceId, rowOf(next, client.owner)),
    ).toBe("awaiting_review");
    // A conversation's failed message does not hand the conversation over either.
    expect(
      await system.socialAutoReplyClaim.count({ where: { workspaceId: agency.owner.workspaceId } }),
    ).toBe(1);
  });

  it("refuses a person's reply to a message another workspace answers, without saying who", async () => {
    const { agency, client } = await pair();
    const rows = await receive(commentEvent("Do you deliver on Fridays?"));
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(rows, agency.owner)),
    ).toBe("auto_sent");
    const mine = rowOf(rows, client.owner);
    expect(await draftInteraction(client.deps, client.owner.workspaceId, mine)).toBe(
      "awaiting_review",
    );
    const error = await rejection(
      approveReply(client.deps, client.owner, (await latestReply(mine)).id, null),
    );
    expect(error).toMatchObject({ fields: [{ code: "social_reply_claimed" }] });
    // Only a code: no workspace id, name or reply text from the other workspace.
    const exposed = JSON.stringify({ message: error.message, fields: error.fields });
    expect(exposed).not.toContain(agency.owner.workspaceId);
    expect(exposed).not.toContain("Agency");
    expect(sent(client.graph)).toBe(0);
    // Refused before anything was decided: no approved reply is left to go out later.
    expect(await latestReply(mine)).toMatchObject({ decision: "PENDING", sendStatus: "NOT_SENT" });
  });

  it("the scheduler never sends an older approved reply for a message another team now owns", async () => {
    const { agency, client } = await pair();
    await saveAgent(db, agency.owner, agency.agentId, agentInput());
    await saveAgent(db, client.owner, client.agentId, agentInput());
    const rows = await receive(commentEvent("Is parking free?"));
    const older = rowOf(rows, agency.owner);
    await draftInteraction(agency.deps, agency.owner.workspaceId, older);
    // Approved before message claims existed (no claim held), never sent.
    await system.socialReply.updateMany({
      where: { interactionId: older },
      data: {
        decision: "APPROVED",
        finalText: "Yes.",
        decidedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    // Meanwhile a person in the other workspace answers the same comment.
    const theirs = rowOf(rows, client.owner);
    await draftInteraction(client.deps, client.owner.workspaceId, theirs);
    expect(
      await approveReply(client.deps, client.owner, (await latestReply(theirs)).id, null),
    ).toBe("sent");
    await socialSweep(agency.deps, system);
    expect(await latestReply(older)).toMatchObject({
      sendStatus: "FAILED",
      sendError: "claimed_elsewhere",
    });
    expect(sent(agency.graph)).toBe(0);
  });

  it("a person who answers first owns the message: the other team's agent stays quiet", async () => {
    const { agency, client } = await pair();
    await saveAgent(db, client.owner, client.agentId, agentInput());
    const rows = await receive(commentEvent("Can I book the terrace?"));
    const mine = rowOf(rows, client.owner);
    await draftInteraction(client.deps, client.owner.workspaceId, mine);
    expect(await approveReply(client.deps, client.owner, (await latestReply(mine)).id, null)).toBe(
      "sent",
    );
    expect(
      await draftInteraction(agency.deps, agency.owner.workspaceId, rowOf(rows, agency.owner)),
    ).toBe("awaiting_review");
    expect(sent(agency.graph)).toBe(0);
  });
});

describe("the Meta grant's life cycle", () => {
  const expire = (ctx: TenantContext) =>
    system.adConnection.updateMany({
      where: { workspaceId: ctx.workspaceId },
      data: { status: "EXPIRED" },
    });
  const renew = (ctx: TenantContext) =>
    system.adConnection.updateMany({
      where: { workspaceId: ctx.workspaceId },
      data: {
        status: "ACTIVE",
        tokenCiphertext: encryptToken(KEY, TOKEN, {
          workspaceId: ctx.workspaceId,
          platform: "META",
        }),
        tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });

  it("holds every send while the grant is expired, and resumes after it is renewed", async () => {
    const s = await setup();
    const id = await receiveOne(s, "Do you have a kids menu?");
    await draftInteraction(s.deps, s.owner.workspaceId, id);
    const reply = await latestReply(id);
    const item = await system.contentItem.create({
      data: {
        workspaceId: s.owner.workspaceId,
        title: "News",
        body: "New hours.",
        status: "APPROVED",
      },
    });
    const { postId } = await queuePost(s.deps, s.owner, item.id, s.channel.id);

    await expire(s.owner);
    expect(await rejection(approveReply(s.deps, s.owner, reply.id, null))).toMatchObject({
      fields: [{ code: "social_connection_inactive" }],
    });
    expect(await publishPost(s.deps, s.owner.workspaceId, postId)).toBe("skipped");
    expect(await socialSweep(s.deps, system)).toMatchObject({ sent: 0, published: 0 });
    expect(await receive(commentEvent("Anyone there?"))).toEqual([]);
    expect(s.graph.posts().filter((call) => call.path !== `/${PAGE}/subscribed_apps`)).toHaveLength(
      0,
    );
    // The draft is untouched, and the channel was not disabled: an expiry is not a loss.
    expect(await latestReply(id)).toMatchObject({ decision: "PENDING", sendStatus: "NOT_SENT" });
    expect(
      await system.socialChannel.findUniqueOrThrow({ where: { id: s.channel.id } }),
    ).toMatchObject({
      enabled: true,
    });

    await renew(s.owner);
    expect(await approveReply(s.deps, s.owner, reply.id, null)).toBe("sent");
    expect(await publishPost(s.deps, s.owner.workspaceId, postId)).toBe("published");
    expect(await receive(commentEvent("Open now?"))).toHaveLength(1);
  });

  it("after a disconnect, a reconnect alone does not resume: the Pages are synced again first", async () => {
    const s = await setup();
    await disconnect(db, s.owner, "META");
    await renew(s.owner);
    // Connected again, but the channels stay off until a person syncs the Pages.
    expect(await receive(commentEvent("Hello?"))).toEqual([]);
    await syncChannels(s.deps, s.owner);
    expect(
      await system.socialChannel.findUniqueOrThrow({ where: { id: s.channel.id } }),
    ).toMatchObject({
      enabled: true,
    });
    expect(await receive(commentEvent("Hello again?"))).toHaveLength(1);
  });
});
