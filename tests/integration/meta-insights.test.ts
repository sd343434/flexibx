// Meta Insights (Pass 6) on a real database with the real Meta clients and a stand-in
// Graph API (no network): connecting sources, reading a Page's and an Instagram account's
// daily numbers and the lifetime numbers of posts Flexibx published, storing them as
// VERIFIED observations with revisions instead of overwrites, bounded and resumable runs,
// every failure Meta can answer with, one run per source at a time, revocation, roles,
// tenant isolation, no token anywhere it should not be, and the link to the existing
// recommendations.
import { randomBytes } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters } from "@/server/ads/adapter";
import { createMetaAdapter } from "@/server/ads/adapters/meta";
import { completeConnection, disconnect, startConnection } from "@/server/ads/connections";
import { forgetMetaUser } from "@/server/ads/meta-deauthorization";
import { encryptToken } from "@/server/ads/token-vault";
import { AppError } from "@/server/errors/app-error";
import {
  disableSource,
  enableSource,
  getSourceOverview,
  insightsConnection,
  LEASE_MS,
  MAX_DAYS_PER_RUN,
  MANUAL_MIN_INTERVAL_MS,
  runDueInsightsSyncs,
  runSync,
  syncSourceNow,
  type InsightsDeps,
} from "@/server/intelligence/insights-sync";
import { getInsights } from "@/server/intelligence/intelligence-service";
import {
  ALL_META_INSIGHTS_SCOPES,
  createMetaInsightsClient,
} from "@/server/intelligence/meta-insights";
import { createCampaign } from "@/server/marketing/campaign-service";
import { createContent } from "@/server/marketing/content-service";
import { campaignFieldsSchema, contentFieldsSchema } from "@/server/marketing/inputs";
import { createMetaSocial } from "@/server/social/meta-social";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const KEY = randomBytes(32).toString("base64");
const USER_TOKEN = "EAAB-insights-user-token-secret";
const PAGE_TOKEN = "EAAB-insights-page-token-secret";
const PAGE = "555000111";
const IG = "1784000111";
const SECRET = "s".repeat(32);
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
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
async function expectCode(promise: Promise<unknown>, code: string, field?: string) {
  const error = await rejection(promise);
  expect(error.code).toBe(code);
  if (field !== undefined) expect(error.fields.map((f) => f.code)).toContain(field);
}

// ── A stand-in Graph API ─────────────────────────────────────────────────────

type Fault = { status: number; body: unknown } | "hang" | "network";

function fakeGraph() {
  const calls: { path: string; params: Record<string, string>; token: string | null }[] = [];
  const state = {
    pageListed: true,
    igLinked: true,
    userTokenValid: true,
    pageTokenValid: true,
    /** Graph metric names Meta rejects as invalid (deprecated / not offered). */
    unsupported: new Set<string>(),
    /** Days (YYYY-MM-DD) Meta has no value for. */
    missingDays: new Set<string>(),
    /** Multiplier for every value (a later read can differ: a revision). */
    scale: 1,
    deletedPosts: new Set<string>(),
    /** Faults by path prefix, used once each, in order. */
    faults: [] as { prefix: string; fault: Fault }[],
    malformed: false,
  };
  const valueFor = (key: string) => {
    let hash = 0;
    for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 997;
    return Math.round((hash + 3) * state.scale);
  };
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/v\d+\.0/, "");
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    const token = params.access_token ?? null;
    delete params.access_token;
    delete params.appsecret_proof;
    calls.push({ path, params, token });
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    const index = state.faults.findIndex((entry) => path.startsWith(entry.prefix));
    if (index >= 0) {
      const { fault } = must(state.faults[index]);
      state.faults.splice(index, 1);
      if (fault === "network") return Promise.reject(new TypeError("fetch failed"));
      if (fault === "hang") {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        });
      }
      return json(fault.body, fault.status);
    }
    if (path === "/me/accounts") {
      if (!state.userTokenValid || token !== USER_TOKEN) {
        return json({ error: { code: 190, message: `bad ${String(token)}` } }, 400);
      }
      if (!state.pageListed) return json({ data: [] });
      return json({
        data: [
          {
            id: PAGE,
            name: "Cafe Page",
            tasks: ["ANALYZE"],
            access_token: PAGE_TOKEN,
            ...(state.igLinked ? { instagram_business_account: { id: IG, username: "cafe" } } : {}),
          },
        ],
      });
    }
    if (!state.pageTokenValid || token !== PAGE_TOKEN) {
      return json({ error: { code: 190, message: "expired" } }, 400);
    }
    if (state.malformed) return json({ data: "nope" });
    const metric = params.metric ?? "";
    if (path.endsWith("/insights") && state.unsupported.has(metric)) {
      return json(
        { error: { code: 100, message: `(#100) The value ${metric} is not valid` } },
        400,
      );
    }
    if (path === `/${PAGE}/insights`) {
      const since = Date.parse(`${must(params.since)}T00:00:00Z`);
      const until = Date.parse(`${must(params.until)}T00:00:00Z`);
      const values = [];
      for (let at = since; at < until; at += DAY) {
        const day = new Date(at).toISOString().slice(0, 10);
        values.push({
          value: state.missingDays.has(day) ? null : valueFor(`${metric}${day}`),
          // End of the reporting day (Pacific time) in UTC.
          end_time: new Date(at + DAY + 7 * 3_600_000).toISOString().replace(".000Z", "+0000"),
        });
      }
      return json({ data: [{ name: metric, period: "day", values }] });
    }
    if (path === `/${IG}/insights`) {
      const day = new Date(Number(params.since) * 1000).toISOString().slice(0, 10);
      if (state.missingDays.has(day)) return json({ data: [] });
      return json({
        data: [
          { name: metric, period: "day", total_value: { value: valueFor(`${metric}${day}`) } },
        ],
      });
    }
    const post = /^\/(\d+_\d+)(\/insights)?$/.exec(path);
    if (post !== null) {
      const postId = must(post[1]);
      if (state.deletedPosts.has(postId)) {
        return json({ error: { code: 100, error_subcode: 33, message: "does not exist" } }, 400);
      }
      if (post[2] === "/insights") {
        return json({
          data: [
            {
              name: metric,
              period: "lifetime",
              values: [{ value: 1000 + valueFor(`${postId}${metric}`) }],
            },
          ],
        });
      }
      return json({
        id: postId,
        reactions: { data: [], summary: { total_count: valueFor(`${postId}r`) % 50 } },
        comments: { data: [], summary: { total_count: 3 } },
        shares: { count: 2 },
      });
    }
    return json({ error: { code: 803, message: "unknown path" } }, 404);
  };
  return { calls, state, fetch: fetchImpl };
}

// ── A workspace with a Meta grant, a Page, its Instagram account and posts ───────────

const clock = { now: new Date("2030-05-20T10:00:00Z") };

async function setup(options: { scopes?: readonly string[] } = {}) {
  const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
  const graph = fakeGraph();
  const adapters: AdAdapters = {
    META: {
      platform: "META",
      available: true,
      adapter: createMetaAdapter({
        appId: "1234567890",
        appSecret: SECRET,
        version: "v26.0",
        fetch: graph.fetch,
        requestInsightsAccess: true,
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
      scopes: [...(options.scopes ?? ["ads_read", ...ALL_META_INSIGHTS_SCOPES])],
      tokenCiphertext: encryptToken(KEY, USER_TOKEN, {
        workspaceId: owner.workspaceId,
        platform: "META",
      }),
      tokenExpiresAt: new Date(clock.now.getTime() + 50 * DAY),
    },
  });
  const delays: number[] = [];
  const deps: InsightsDeps = {
    db,
    ads: { db, adapters, tokenKey: KEY, now: () => clock.now },
    meta: createMetaSocial({ appSecret: SECRET, version: "v26.0", fetch: graph.fetch }),
    client: createMetaInsightsClient({
      appSecret: SECRET,
      version: "v26.0",
      fetch: graph.fetch,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    }),
    now: () => clock.now,
  };
  const page = await system.socialChannel.create({
    data: {
      workspaceId: owner.workspaceId,
      platform: "FACEBOOK",
      externalId: PAGE,
      pageId: PAGE,
      name: "Cafe Page",
    },
  });
  const ig = await system.socialChannel.create({
    data: {
      workspaceId: owner.workspaceId,
      platform: "INSTAGRAM",
      externalId: IG,
      pageId: PAGE,
      name: "@cafe",
    },
  });
  return { owner, graph, deps, delays, page, ig };
}

/** A campaign with content items, each published by Flexibx on the Page. */
async function publishedPosts(ctx: TenantContext, channelId: string, count: number, daysAgo = 5) {
  const { campaignId } = await createCampaign(
    db,
    ctx,
    campaignFieldsSchema.parse({ name: "Summer", startDate: "2030-05-01", endDate: "2030-06-30" }),
  );
  const posts: { contentId: string; postId: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const { contentId } = await createContent(
      db,
      ctx,
      contentFieldsSchema.parse({ title: `Post ${String(index + 1)}`, type: "POST", campaignId }),
    );
    const postId = `${PAGE}_${String(9000 + index)}`;
    const publishedAt = new Date(clock.now.getTime() - daysAgo * DAY);
    await system.socialPost.create({
      data: {
        workspaceId: ctx.workspaceId,
        contentItemId: contentId,
        channelId,
        status: "PUBLISHED",
        scheduledAt: publishedAt,
        publishedAt,
        message: `Post ${String(index + 1)}`,
        externalPostId: postId,
      },
    });
    posts.push({ contentId, postId });
  }
  return { campaignId, posts };
}

async function memberOf(ctx: TenantContext, role: WorkspaceRole): Promise<TenantContext> {
  const user = await system.user.create({
    data: { email: `${role.toLowerCase()}-${crypto.randomUUID()}@test.flexibx.local`, name: role },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return { userId: user.id, workspaceId: ctx.workspaceId, role };
}

const later = (ms: number) => {
  clock.now = new Date(clock.now.getTime() + ms);
};

beforeEach(() => {
  clock.now = new Date("2030-05-20T10:00:00Z");
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("connection and sources", () => {
  it("asks for the insights permissions at Meta sign-in and binds the state to the person", async () => {
    const s = await setup();
    const { url } = await startConnection(s.deps.ads, s.owner, {
      platform: "META",
      locale: "en",
      redirectUri: "https://app.test/api/integrations/meta/callback",
    });
    const scope = must(new URL(url).searchParams.get("scope")).split(",");
    for (const permission of ALL_META_INSIGHTS_SCOPES) expect(scope).toContain(permission);
    const state = must(new URL(url).searchParams.get("state"));
    // Another person (even a member) presenting this state is refused before any exchange.
    const other = await memberOf(s.owner, WorkspaceRole.ADMIN);
    const result = await completeConnection(
      { ...s.deps.ads, system },
      {
        platform: "META",
        sessionUserId: other.userId,
        state,
        code: "code-1",
        error: null,
        redirectUri: "https://app.test/api/integrations/meta/callback",
      },
    );
    expect(result.outcome).toBe("oauth_invalid");
    // A forged state is refused too.
    const forged = await completeConnection(
      { ...s.deps.ads, system },
      {
        platform: "META",
        sessionUserId: s.owner.userId,
        state: "x".repeat(43),
        code: "code-1",
        error: null,
        redirectUri: "https://app.test/api/integrations/meta/callback",
      },
    );
    expect(forged.outcome).toBe("oauth_invalid");
    expect(s.graph.calls.filter((call) => call.path === "/oauth/access_token")).toHaveLength(0);
  });

  it("tells what is missing: not configured, not connected, permissions per kind", async () => {
    const s = await setup({
      scopes: ["ads_read", "pages_show_list", "pages_read_engagement", "read_insights"],
    });
    const state = await insightsConnection(s.deps, s.owner.workspaceId);
    expect(state.state).toBe("ready");
    expect(state.missing.FACEBOOK_PAGE).toEqual([]);
    expect(state.missing.INSTAGRAM_ACCOUNT).toEqual([
      "instagram_basic",
      "instagram_manage_insights",
    ]);
    await expectCode(
      enableSource(s.deps, s.owner, s.ig.id),
      "CONFLICT",
      "insights_permission_missing",
    );
    expect((await insightsConnection({ ...s.deps, client: null }, s.owner.workspaceId)).state).toBe(
      "not_configured",
    );
    const other = await createTenant(system);
    expect((await insightsConnection(s.deps, other.workspaceId)).state).toBe("not_connected");
  });

  it("enables only the workspace's own channels, with social.manage", async () => {
    const s = await setup();
    const other = await setup();
    // Another workspace's channel id reads as unknown.
    await expectCode(enableSource(s.deps, s.owner, other.page.id), "NOT_FOUND");
    const manager = await memberOf(s.owner, WorkspaceRole.MANAGER);
    await expectCode(enableSource(s.deps, manager, s.page.id), "FORBIDDEN");
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    // The database refuses a source pointing at another workspace's channel.
    await expect(
      system.insightsSource.create({
        data: {
          workspaceId: s.owner.workspaceId,
          socialChannelId: other.ig.id,
          kind: "INSTAGRAM_ACCOUNT",
          externalId: IG,
          pageId: PAGE,
          name: "x",
        },
      }),
    ).rejects.toThrow();
    // A source keeps its account.
    await expect(
      system.insightsSource.update({ where: { id: sourceId }, data: { externalId: "999" } }),
    ).rejects.toThrow(/identity cannot change/);
    await disableSource(db, s.owner, sourceId);
    await expectCode(
      syncSourceNow(s.deps, s.owner, sourceId),
      "CONFLICT",
      "insights_source_disabled",
    );
  });
});

describe("reading Meta", () => {
  it("stores a Page's daily numbers and its posts' lifetime numbers as VERIFIED, linked where reliable", async () => {
    const s = await setup();
    const { campaignId, posts } = await publishedPosts(s.owner, s.page.id, 2);
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    const outcome = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(outcome).toMatchObject({
      status: "SUCCEEDED",
      errorCode: null,
      revised: 0,
      duplicates: 0,
    });
    // First run: MAX_DAYS_PER_RUN days of 3 metrics, 2 posts × (interactions + 3 metrics).
    expect(outcome.accepted).toBe(MAX_DAYS_PER_RUN * 3 + 2 * 4);
    const rows = await system.metricObservation.findMany({
      where: { workspaceId: s.owner.workspaceId },
    });
    expect(rows.every((row) => row.source === "VERIFIED" && row.provider === "meta")).toBe(true);
    const account = rows.filter((row) => row.campaignId === null);
    expect(account).toHaveLength(MAX_DAYS_PER_RUN * 3);
    expect(
      account.every((row) => row.insightsSourceId === sourceId && row.contentItemId === null),
    ).toBe(true);
    const postRows = rows.filter((row) => row.campaignId !== null);
    expect(new Set(postRows.map((row) => row.contentItemId))).toEqual(
      new Set(posts.map((post) => post.contentId)),
    );
    expect(postRows.every((row) => row.campaignId === campaignId)).toBe(true);
    expect(new Set(postRows.map((row) => row.metric))).toEqual(
      new Set(["ENGAGEMENTS", "VIEWS", "REACH", "CLICKS"]),
    );
    // The day reported is the one before Meta's end_time.
    const first = must(
      account.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime())[0],
    );
    expect(first.periodStart.toISOString().slice(0, 10)).toBe("2030-04-22");
    const source = await system.insightsSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source).toMatchObject({ lastErrorCode: null, leaseRunId: null, failureCount: 0 });
    expect(source.coveredTo?.toISOString().slice(0, 10)).toBe("2030-05-05");
    const run = await system.insightsSyncRun.findFirstOrThrow({ where: { sourceId } });
    expect(run).toMatchObject({
      status: "SUCCEEDED",
      trigger: "MANUAL",
      rowsStored: outcome.accepted,
    });
    expect(run.finishedAt).not.toBeNull();
  });

  it("reads an Instagram account day by day; a missing day stays missing, a metric Meta lacks is listed", async () => {
    const s = await setup();
    s.graph.state.unsupported.add("total_interactions");
    s.graph.state.missingDays.add("2030-04-25");
    const { sourceId } = await enableSource(s.deps, s.owner, s.ig.id);
    const outcome = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.unsupported).toEqual(["total_interactions"]);
    const rows = await system.metricObservation.findMany({ where: { insightsSourceId: sourceId } });
    // Two metrics, one day missing for each (never stored as zero).
    expect(rows).toHaveLength(2 * (MAX_DAYS_PER_RUN - 1));
    expect(rows.some((row) => row.periodStart.toISOString().startsWith("2030-04-25"))).toBe(false);
    expect(rows.every((row) => row.channel === "INSTAGRAM" && row.metric !== "ENGAGEMENTS")).toBe(
      true,
    );
    const overview = await getSourceOverview(s.deps, s.owner);
    const card = must(overview.channels.find((channel) => channel.channelId === s.ig.id)?.source);
    expect(card.unsupportedMetrics).toEqual(["total_interactions"]);
    expect(card.status).toBe("ready");
    expect(card.totals.map((total) => [total.metric, total.days])).toEqual([
      ["REACH", MAX_DAYS_PER_RUN - 1],
      ["VIEWS", MAX_DAYS_PER_RUN - 1],
    ]);
  });

  it("resumes where coverage stopped, re-reads recent days, and stores revisions without overwriting", async () => {
    const s = await setup();
    const { posts } = await publishedPosts(s.owner, s.page.id, 1);
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    await syncSourceNow(s.deps, s.owner, sourceId);
    // Same numbers again (a retry): nothing new.
    later(MANUAL_MIN_INTERVAL_MS + 1000);
    const again = await syncSourceNow(s.deps, s.owner, sourceId);
    // Days 3 before the coverage end were read again (same numbers), 11 new days after.
    expect(again.accepted).toBe(11 * 3);
    expect(again.duplicates).toBe(3 * 3 + 4);
    let source = await system.insightsSource.findUniqueOrThrow({ where: { id: sourceId } });
    // Resumed from coverage minus the revision days, MAX_DAYS_PER_RUN further.
    expect(source.coveredFrom?.toISOString().slice(0, 10)).toBe("2030-04-22");
    expect(source.coveredTo?.toISOString().slice(0, 10)).toBe("2030-05-16");
    // Meta revises its numbers: the new values are stored beside the old ones.
    s.graph.state.scale = 2;
    later(MANUAL_MIN_INTERVAL_MS + 1000);
    const revised = await syncSourceNow(s.deps, s.owner, sourceId);
    // Three re-read days changed (3 metrics) and the post's four numbers: revisions; three
    // new days are plain additions.
    expect(revised).toMatchObject({ revised: 3 * 3 + 4, accepted: 6 * 3 + 4, duplicates: 0 });
    const views = await system.metricObservation.findMany({
      where: { sourceRef: `meta:post:${must(posts[0]).postId}:post_media_view` },
      orderBy: { observedAt: "asc" },
    });
    expect(views).toHaveLength(2);
    // Post values are 1000 + v in the stand-in; v doubled.
    expect(must(views[1]).value - 1000n).toBe((must(views[0]).value - 1000n) * 2n);
    // Campaign totals count the latest value once.
    const insights = await getInsights(
      db,
      s.owner,
      { campaignId: null, channel: null, metric: "VIEWS", from: null, to: null },
      clock.now,
    );
    const total = must(insights.campaigns[0]).recorded.find((entry) => entry.metric === "VIEWS");
    expect(total?.value).toBe(must(views[1]).value);
    source = await system.insightsSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.coveredTo?.toISOString().slice(0, 10)).toBe("2030-05-19");
  });

  it("retries a rate limit and a server error with backoff, then succeeds", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    // A dropped connection, then a rate limit (Meta code 4): the third attempt succeeds.
    s.graph.state.faults.push(
      { prefix: `/${PAGE}/insights`, fault: "network" },
      { prefix: `/${PAGE}/insights`, fault: { status: 400, body: { error: { code: 4 } } } },
    );
    const outcome = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(outcome).toMatchObject({ status: "SUCCEEDED", errorCode: null });
    // Equal jitter: half of 500 ms, then of 1 s, fixed, plus half random (0.5 here).
    expect(s.delays).toEqual([375, 750]);
    // A server error (Meta code 2) is retried too; three in a row fail the run.
    later(MANUAL_MIN_INTERVAL_MS + 1000);
    for (let i = 0; i < 3; i += 1) {
      s.graph.state.faults.push({
        prefix: `/${PAGE}/insights`,
        fault: { status: 500, body: { error: { code: 2 } } },
      });
    }
    expect(await syncSourceNow(s.deps, s.owner, sourceId)).toMatchObject({
      status: "FAILED",
      errorCode: "provider_unavailable",
    });
  });

  it("records a lasting rate limit, a malformed answer and an expired token as failed runs", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    for (let i = 0; i < 3; i += 1) {
      s.graph.state.faults.push({
        prefix: `/${PAGE}/insights`,
        fault: { status: 400, body: { error: { code: 32 } } },
      });
    }
    const limited = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(limited).toMatchObject({ status: "FAILED", errorCode: "rate_limited", accepted: 0 });
    let source = await system.insightsSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source).toMatchObject({
      failureCount: 1,
      lastErrorCode: "rate_limited",
      leaseRunId: null,
    });
    // Retried by the scheduler in an hour, not at once.
    expect(must(source.nextSyncAt).getTime() - clock.now.getTime()).toBe(3_600_000);

    later(MANUAL_MIN_INTERVAL_MS + 1000);
    s.graph.state.malformed = true;
    const malformed = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(malformed).toMatchObject({ status: "FAILED", errorCode: "provider_malformed" });
    s.graph.state.malformed = false;

    later(MANUAL_MIN_INTERVAL_MS + 1000);
    s.graph.state.pageTokenValid = false;
    const expired = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(expired).toMatchObject({ status: "FAILED", errorCode: "token_expired" });
    source = await system.insightsSource.findUniqueOrThrow({ where: { id: sourceId } });
    // Waits for a person: no scheduled retry; the connection asks to reconnect.
    expect(source.nextSyncAt).toBeNull();
    const connection = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: s.owner.workspaceId },
    });
    expect(connection.status).toBe("EXPIRED");
    const overview = await getSourceOverview(s.deps, s.owner);
    expect(overview.connection.state).toBe("needs_reauth");
    expect(must(overview.channels.find((c) => c.channelId === s.page.id)?.source).status).toBe(
      "needs_reauth",
    );
  });

  it("disables a source whose Page left the grant, and stops on missing permissions", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    s.graph.state.pageListed = false;
    const lost = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(lost).toMatchObject({ status: "FAILED", errorCode: "access_lost" });
    const source = await system.insightsSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source).toMatchObject({ enabled: false, disabledReason: "access_lost" });
    expect(s.graph.calls.some((call) => call.path.endsWith("/insights"))).toBe(false);

    // An Instagram account no longer linked to its Page is not read through that Page.
    const u = await setup();
    const { sourceId: igSource } = await enableSource(u.deps, u.owner, u.ig.id);
    u.graph.state.igLinked = false;
    expect(await syncSourceNow(u.deps, u.owner, igSource)).toMatchObject({
      status: "FAILED",
      errorCode: "access_lost",
    });
    expect(u.graph.calls.some((call) => call.path.endsWith("/insights"))).toBe(false);

    const t = await setup();
    const { sourceId: other } = await enableSource(t.deps, t.owner, t.page.id);
    t.graph.state.faults.push({
      prefix: `/${PAGE}/insights`,
      fault: { status: 403, body: { error: { code: 200 } } },
    });
    const missing = await syncSourceNow(t.deps, t.owner, other);
    expect(missing).toMatchObject({ status: "FAILED", errorCode: "permission_missing" });
  });

  it("keeps what was read when a post is gone or the run hits its call budget", async () => {
    const s = await setup();
    const { posts } = await publishedPosts(s.owner, s.page.id, 3);
    s.graph.state.deletedPosts.add(must(posts[1]).postId);
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    const partial = await syncSourceNow(s.deps, s.owner, sourceId);
    expect(partial.status).toBe("PARTIAL");
    const run = await system.insightsSyncRun.findFirstOrThrow({ where: { sourceId } });
    expect(run.issues).toContainEqual({ code: "post_unavailable", ref: must(posts[1]).postId });

    const t = await setup();
    await publishedPosts(t.owner, t.page.id, 3);
    const { sourceId: other } = await enableSource(t.deps, t.owner, t.page.id);
    const budgeted = await runSync(
      { ...t.deps, limits: { maxCalls: 5 } },
      { kind: "person", ctx: t.owner },
      other,
      "MANUAL",
    );
    expect(budgeted).toMatchObject({
      status: "PARTIAL",
      errorCode: "call_budget_reached",
      calls: 5,
    });
    expect(budgeted.accepted).toBeGreaterThan(0);
  });
});

describe("one run at a time", () => {
  it("refuses a second run while one holds the source, and a too-early manual one", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    s.graph.state.faults.push({ prefix: "/me/accounts", fault: "hang" });
    const running = runSync(
      { ...s.deps, limits: { deadlineMs: 300 } },
      { kind: "person", ctx: s.owner },
      sourceId,
      "MANUAL",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expectCode(
      runSync(s.deps, { kind: "system", workspaceId: s.owner.workspaceId }, sourceId, "SCHEDULED"),
      "CONFLICT",
      "insights_sync_running",
    );
    const first = await running;
    expect(first).toMatchObject({ status: "FAILED", errorCode: "deadline_reached" });
    // Right after it, a person's manual sync is too early.
    await expectCode(syncSourceNow(s.deps, s.owner, sourceId), "RATE_LIMITED");
    // The database allows one RUNNING run per source whatever the code does.
    const run = await system.insightsSyncRun.create({
      data: { workspaceId: s.owner.workspaceId, sourceId, trigger: "MANUAL" },
    });
    await expect(
      system.insightsSyncRun.create({
        data: { workspaceId: s.owner.workspaceId, sourceId, trigger: "MANUAL" },
      }),
    ).rejects.toThrow();
    await system.insightsSyncRun.update({
      where: { id: run.id },
      data: { status: "ABANDONED", finishedAt: clock.now, errorCode: "test" },
    });
    // A finished run is history.
    await expect(
      system.insightsSyncRun.update({ where: { id: run.id }, data: { calls: 9 } }),
    ).rejects.toThrow(/cannot change/);
  });

  it("recovers from a runner that died: its lease expires and the next run resumes", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    // A run that stopped mid-way: RUNNING, holding the source.
    const dead = await system.insightsSyncRun.create({
      data: { workspaceId: s.owner.workspaceId, sourceId, trigger: "SCHEDULED" },
    });
    await system.insightsSource.update({
      where: { id: sourceId },
      data: { leaseRunId: dead.id, leaseUntil: new Date(clock.now.getTime() + LEASE_MS) },
    });
    await expectCode(
      runSync(s.deps, { kind: "system", workspaceId: s.owner.workspaceId }, sourceId, "SCHEDULED"),
      "CONFLICT",
      "insights_sync_running",
    );
    later(LEASE_MS + 1000);
    const resumed = await runSync(
      s.deps,
      { kind: "system", workspaceId: s.owner.workspaceId },
      sourceId,
      "SCHEDULED",
    );
    expect(resumed.status).toBe("SUCCEEDED");
    expect(
      await system.insightsSyncRun.findUniqueOrThrow({ where: { id: dead.id } }),
    ).toMatchObject({
      status: "ABANDONED",
      errorCode: "lease_expired",
    });
  });

  it("runs due sources on schedule, skipping workspaces without a usable grant", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    const t = await setup();
    await enableSource(t.deps, t.owner, t.page.id);
    await system.adConnection.updateMany({
      where: { workspaceId: t.owner.workspaceId },
      data: { status: "EXPIRED" },
    });
    const summary = await runDueInsightsSyncs(s.deps, system);
    expect(summary).toEqual({ started: 1, failed: 0 });
    const run = await system.insightsSyncRun.findFirstOrThrow({ where: { sourceId } });
    expect(run).toMatchObject({
      trigger: "SCHEDULED",
      requestedByUserId: null,
      status: "SUCCEEDED",
    });
    // Not due again until tomorrow.
    expect(await runDueInsightsSyncs(s.deps, system)).toEqual({ started: 0, failed: 0 });
    // Not enabled on this server: nothing runs.
    later(2 * DAY);
    expect(await runDueInsightsSyncs({ ...s.deps, client: null }, system)).toEqual({
      started: 0,
      failed: 0,
    });
  });
});

describe("revocation, roles and isolation", () => {
  it("disconnecting Meta or Meta's callbacks stop every source; numbers stay as history", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    await syncSourceNow(s.deps, s.owner, sourceId);
    const stored = await system.metricObservation.count({ where: { insightsSourceId: sourceId } });
    await disconnect(db, s.owner, "META");
    expect(
      await system.insightsSource.findUniqueOrThrow({ where: { id: sourceId } }),
    ).toMatchObject({
      enabled: false,
      disabledReason: "disconnected",
      nextSyncAt: null,
    });
    const connection = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: s.owner.workspaceId },
    });
    expect(connection.tokenCiphertext).toBeNull();
    expect(await system.metricObservation.count({ where: { insightsSourceId: sourceId } })).toBe(
      stored,
    );
    await expectCode(
      syncSourceNow(s.deps, s.owner, sourceId),
      "CONFLICT",
      "insights_source_disabled",
    );

    const t = await setup();
    const { sourceId: other } = await enableSource(t.deps, t.owner, t.page.id);
    await forgetMetaUser({ system, db }, { userId: "42", issuedAt: null }, "data_deletion");
    expect(await system.insightsSource.findUniqueOrThrow({ where: { id: other } })).toMatchObject({
      enabled: false,
      disabledReason: "data_deleted",
    });
  });

  it("lets viewers read, managers sync, admins choose sources", async () => {
    const s = await setup();
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    const viewer = await memberOf(s.owner, WorkspaceRole.VIEWER);
    const client = await memberOf(s.owner, WorkspaceRole.CLIENT);
    const manager = await memberOf(s.owner, WorkspaceRole.MANAGER);
    await expectCode(syncSourceNow(s.deps, viewer, sourceId), "FORBIDDEN");
    await expectCode(syncSourceNow(s.deps, client, sourceId), "FORBIDDEN");
    await expectCode(disableSource(db, manager, sourceId), "FORBIDDEN");
    expect((await syncSourceNow(s.deps, manager, sourceId)).status).toBe("SUCCEEDED");
    expect((await getSourceOverview(s.deps, viewer)).channels).toHaveLength(2);
  });

  it("never reads or syncs another workspace's source, nor stores into it", async () => {
    const s = await setup();
    const t = await setup();
    const { sourceId } = await enableSource(t.deps, t.owner, t.page.id);
    await expectCode(syncSourceNow(s.deps, s.owner, sourceId), "NOT_FOUND");
    await expectCode(disableSource(db, s.owner, sourceId), "NOT_FOUND");
    const overview = await getSourceOverview(s.deps, s.owner);
    expect(overview.channels.every((channel) => channel.source === null)).toBe(true);
    // The database refuses an import or an observation pointing at another workspace's source.
    await expect(
      system.metricImport.create({
        data: {
          workspaceId: s.owner.workspaceId,
          provider: "meta",
          source: "VERIFIED",
          externalId: "x",
          insightsSourceId: sourceId,
          status: "SUCCEEDED",
          rowsReceived: 0,
          rowsAccepted: 0,
          rowsDuplicate: 0,
          rowsRejected: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it("never lets a token reach a run, an import, an audit entry or a stored number", async () => {
    const s = await setup();
    await publishedPosts(s.owner, s.page.id, 2);
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    await syncSourceNow(s.deps, s.owner, sourceId);
    later(MANUAL_MIN_INTERVAL_MS + 1000);
    s.graph.state.pageTokenValid = false;
    const failed = await syncSourceNow(s.deps, s.owner, sourceId);
    const dump = JSON.stringify(
      {
        failed,
        runs: await system.insightsSyncRun.findMany(),
        sources: await system.insightsSource.findMany(),
        imports: await system.metricImport.findMany(),
        audit: await system.auditLog.findMany(),
        observations: await system.metricObservation.findMany({ select: { sourceRef: true } }),
        connections: await system.adConnection.findMany({ select: { lastErrorCode: true } }),
      },
      (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(dump).not.toContain(USER_TOKEN);
    expect(dump).not.toContain(PAGE_TOKEN);
    expect(dump).not.toContain("appsecret");
    // Every Graph call carried the Page token only to Meta, with its proof.
    expect(
      s.graph.calls
        .filter((call) => call.path.endsWith("/insights"))
        .every((call) => call.token === PAGE_TOKEN),
    ).toBe(true);
  });

  it("keeps simulated and people's numbers out of VERIFIED", async () => {
    const s = await setup();
    const base = {
      workspaceId: s.owner.workspaceId,
      externalId: "x",
      status: "SUCCEEDED" as const,
      rowsReceived: 0,
      rowsAccepted: 0,
      rowsDuplicate: 0,
      rowsRejected: 0,
    };
    await expect(
      system.metricImport.create({
        data: { ...base, provider: "test-fixture", source: "VERIFIED" },
      }),
    ).rejects.toThrow();
    await expect(
      system.metricImport.create({ data: { ...base, provider: "meta", source: "SIMULATED" } }),
    ).rejects.toThrow();
    await expect(
      system.metricImport.create({ data: { ...base, provider: "meta", source: "VERIFIED" } }),
    ).rejects.toThrow();
  });
});

describe("recommendations from Meta numbers", () => {
  it("compares posts by views and engagements; account numbers never count for a campaign", async () => {
    const s = await setup();
    const { campaignId } = await publishedPosts(s.owner, s.page.id, 5, 10);
    const { sourceId } = await enableSource(s.deps, s.owner, s.page.id);
    await syncSourceNow(s.deps, s.owner, sourceId);
    const insights = await getInsights(
      db,
      s.owner,
      { campaignId: null, channel: null, metric: "VIEWS", from: null, to: null },
      clock.now,
    );
    const summary = must(insights.campaigns.find((entry) => entry.campaign.id === campaignId));
    const accountViews = await system.metricObservation.aggregate({
      where: { insightsSourceId: sourceId, campaignId: null, metric: "VIEWS" },
      _sum: { value: true },
    });
    const views = must(summary.recorded.find((total) => total.metric === "VIEWS"));
    // Five posts' lifetime views, never the Page's daily views.
    expect(views.observations).toBe(5);
    expect(views.value).not.toBe(accountViews._sum.value);
    expect(insights.content).toHaveLength(5);
    expect(insights.content.every((row) => row.exposureMetric === "VIEWS")).toBe(true);
    // Five comparable posts observed over ten days: compared (no "more data needed").
    expect(insights.recommendations.some((r) => r.kind === "MORE_DATA_NEEDED")).toBe(false);
    const weak = insights.recommendations.filter((r) => r.kind === "WEAK_CONTENT");
    for (const finding of weak) {
      expect(finding.evidence.values).toMatchObject({ exposureMetric: "VIEWS" });
      expect(finding.evidence.sufficiency).toBe("sufficient");
    }
  });
});
