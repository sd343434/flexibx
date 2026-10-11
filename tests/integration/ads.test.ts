import { randomBytes } from "node:crypto";

import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalActions, PlatformCards } from "@/app/[locale]/w/[workspaceSlug]/ads/ads-views";
import { GET as metaCallback } from "@/app/api/integrations/meta/callback/route";
import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters, AdPlatformAdapter, LaunchRequest } from "@/server/ads/adapter";
import { startConnectionAction } from "@/server/ads/ads-actions";
import { createMetaAdapter } from "@/server/ads/adapters/meta";
import {
  completeConnection,
  disconnect,
  hashState,
  refreshAccounts,
  selectAccount,
  startConnection,
  syncAccount,
  STATE_RETENTION_MS,
  type AdsDeps,
} from "@/server/ads/connections";
import { readAccountSnapshot } from "@/server/ads/model";
import {
  createAdPlan,
  discardAdPlan,
  getAdPlanReview,
  submitAdPlan,
  todayIn,
  updateAdPlan,
  type ExecutionDeps,
} from "@/server/ads/planner";
import { getMyGeneration } from "@/server/ai/ai-service";
import { createFakeProvider } from "@/server/ai/fake-provider";
import { decideApproval } from "@/server/orchestration/approvals";
import { executeRun, type OrchestrationDeps } from "@/server/orchestration/engine";
import { setAutomationPaused } from "@/server/orchestration/policy";
import {
  adLaunchWorkflow,
  type AdLaunchServices,
} from "@/server/orchestration/workflows/ad-launch";
import { setSpendLimit } from "@/server/ads/spend-limits";
import { createTenantContext, type TenantContext } from "@/server/tenancy/context";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTenant, createTestDb, resetDatabase } from "./helpers";

// The Meta advertising slice on the real database, with a deterministic stand-in for
// graph.facebook.com (no network, no real account, nothing published or paid): OAuth
// state handling, encrypted token lifecycle, workspace isolation, permission failures,
// read-only syncs, the AI planner (fake provider), the review, and the launch boundary
// gated by the approval workflow (a test adapter stands in for a platform write path).

vi.mock("next/server", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, after: () => undefined };
});

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, getCurrentUser: () => Promise.resolve(session.user) };
});

const { system, db } = createTestDb();
const KEY = randomBytes(32).toString("base64");
const TOKEN = "EAAB-integration-secret-token";
const REDIRECT = "https://app.test/api/integrations/meta/callback";
const ai = { provider: createFakeProvider(), timeoutMs: 5_000 };

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── a stand-in for the Graph API ─────────────────────────────────────────────

interface GraphOptions {
  permissions?: string[];
  failOn?: Record<string, number>;
  history?: { impressions: string; clicks: string; spend: string };
}

function fakeGraph(options: GraphOptions = {}) {
  const calls: { method: string; path: string; token: string | null }[] = [];
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/v\d+\.0/, "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      token: url.searchParams.get("access_token"),
    });
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    const failure = Object.entries(options.failOn ?? {}).find(([suffix]) => path.endsWith(suffix));
    if (failure !== undefined)
      return json({ error: { code: failure[1], message: `no ${TOKEN}` } }, 400);
    if (path === "/oauth/access_token") {
      return json({
        access_token: url.searchParams.has("fb_exchange_token") ? TOKEN : "short-lived",
        expires_in: url.searchParams.has("fb_exchange_token") ? 5_000_000 : 3600,
      });
    }
    if (path === "/me") return json({ id: "777", name: "Graph Tester" });
    if (path === "/me/permissions") {
      return json({
        data: (options.permissions ?? ["ads_read"]).map((permission) => ({
          permission,
          status: "granted",
        })),
      });
    }
    if (path === "/me/adaccounts") {
      return json({
        data: [
          {
            id: "act_111",
            account_id: "111",
            name: "Main SAR",
            currency: "SAR",
            timezone_name: "Asia/Riyadh",
            account_status: 1,
          },
          {
            id: "act_222",
            account_id: "222",
            name: "Other USD",
            currency: "USD",
            account_status: 2,
          },
        ],
      });
    }
    if (path.endsWith("/campaigns")) {
      return json({
        data: [
          {
            id: "c1",
            name: "Live campaign",
            objective: "OUTCOME_TRAFFIC",
            effective_status: "ACTIVE",
            daily_budget: "5000",
          },
        ],
      });
    }
    if (path.endsWith("/adsets"))
      return json({
        data: [{ id: "s1", campaign_id: "c1", name: "Set", effective_status: "ACTIVE" }],
      });
    if (path.endsWith("/ads"))
      return json({
        data: [
          { id: "a1", adset_id: "s1", campaign_id: "c1", name: "Ad", effective_status: "ACTIVE" },
        ],
      });
    if (path.endsWith("/insights")) {
      const history = options.history ?? {
        impressions: "100000",
        clicks: "1000",
        spend: "2000.00",
      };
      return json({ data: [{ campaign_id: "c1", ...history }] });
    }
    return json({ error: { code: 803 } }, 404);
  };
  const meta = createMetaAdapter({
    appId: "1234567890",
    appSecret: "x".repeat(32),
    version: "v26.0",
    fetch: fetchImpl,
  });
  return { meta, calls };
}

function adapters(meta: AdPlatformAdapter | null): AdAdapters {
  return {
    META:
      meta === null
        ? { platform: "META", available: false, reason: "not_configured" }
        : { platform: "META", available: true, adapter: meta },
    SNAPCHAT: { platform: "SNAPCHAT", available: false, reason: "not_implemented" },
    TIKTOK: { platform: "TIKTOK", available: false, reason: "not_implemented" },
    WHATSAPP: { platform: "WHATSAPP", available: false, reason: "not_implemented" },
  };
}

function depsFor(meta: AdPlatformAdapter | null): AdsDeps & { system: typeof system } {
  return { db, system, adapters: adapters(meta), tokenKey: KEY };
}

/** Starts a connection and returns the raw state from the consent URL. */
async function begin(deps: AdsDeps, ctx: TenantContext): Promise<string> {
  const { url } = await startConnection(deps, ctx, {
    platform: "META",
    locale: "en",
    redirectUri: REDIRECT,
  });
  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://www.facebook.com");
  return parsed.searchParams.get("state") ?? "";
}

async function connected(ctx: TenantContext, options: GraphOptions = {}) {
  const graph = fakeGraph(options);
  const deps = depsFor(graph.meta);
  const state = await begin(deps, ctx);
  const result = await completeConnection(deps, {
    sessionUserId: ctx.userId,
    state,
    code: "auth-code",
    error: null,
    platform: "META",
    redirectUri: REDIRECT,
  });
  expect(result.outcome).toBe("connected");
  const account = await system.adAccount.findFirstOrThrow({
    where: { workspaceId: ctx.workspaceId, externalId: "111" },
  });
  return { ...graph, deps, account };
}

async function member(ctx: TenantContext, role: WorkspaceRole): Promise<TenantContext> {
  const user = await system.user.create({
    data: { email: `m-${crypto.randomUUID()}@test.flexibx.local`, name: role },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return createTenantContext({ userId: user.id, workspaceId: ctx.workspaceId, role });
}

const plusDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// ── OAuth state ──────────────────────────────────────────────────────────────

describe("connecting Meta", () => {
  it("connects with a single-use state and stores only an encrypted token", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps } = await connected(owner);
    const states = await system.adOAuthState.findMany({
      where: { workspaceId: owner.workspaceId },
    });
    expect(states).toHaveLength(1);
    expect(states[0]?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(states[0]?.consumedAt).not.toBeNull();

    const connection = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    expect(connection).toMatchObject({
      platform: "META",
      status: "ACTIVE",
      externalUserId: "777",
      scopes: ["ads_read"],
    });
    expect(connection.tokenCiphertext).toMatch(/^v1\./);
    expect(connection.tokenCiphertext).not.toContain(TOKEN);
    expect(await system.adAccount.count({ where: { workspaceId: owner.workspaceId } })).toBe(2);

    // Nothing anywhere in the database holds the token in clear: not the connection,
    // not the audit trail.
    const dump = JSON.stringify([
      await system.adConnection.findMany(),
      await system.auditLog.findMany(),
      await system.adOAuthState.findMany(),
    ]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain("short-lived");
    expect(
      (
        await system.auditLog.findMany({
          where: { workspaceId: owner.workspaceId },
          select: { action: true },
        })
      ).map((a) => a.action),
    ).toEqual(
      expect.arrayContaining(["ads.connect_started", "ads.connected", "ads.accounts_refreshed"]),
    );

    // The state cannot be replayed.
    const state = await begin(deps, owner);
    await completeConnection(deps, {
      sessionUserId: owner.userId,
      state,
      code: "c",
      error: null,
      platform: "META",
      redirectUri: REDIRECT,
    });
    expect(
      await completeConnection(deps, {
        sessionUserId: owner.userId,
        state,
        code: "c",
        error: null,
        platform: "META",
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "oauth_invalid", slug: null });
  });

  it("refuses expired, unknown, foreign and malformed states before any token exchange", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const graph = fakeGraph();
    const deps = depsFor(graph.meta);
    const complete = (state: string | null, sessionUserId = owner.userId) =>
      completeConnection(deps, {
        sessionUserId,
        state,
        code: "auth-code",
        error: null,
        platform: "META",
        redirectUri: REDIRECT,
      });

    const expired = await begin(deps, owner);
    await system.adOAuthState.updateMany({
      where: { stateHash: hashState(expired) },
      data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 60_000) },
    });
    expect(await complete(expired)).toMatchObject({ outcome: "oauth_invalid" });
    expect(await complete("x".repeat(43))).toMatchObject({ outcome: "oauth_invalid" });
    expect(await complete(null)).toMatchObject({ outcome: "oauth_invalid" });
    expect(await complete("<script>")).toMatchObject({ outcome: "oauth_invalid" });
    // Someone else's session presenting this person's state: refused (and the state burnt).
    const intruder = await createTenant(system, { role: WorkspaceRole.OWNER });
    const stolen = await begin(deps, owner);
    expect(await complete(stolen, intruder.userId)).toMatchObject({
      outcome: "oauth_invalid",
      slug: null,
    });
    expect(await complete(stolen)).toMatchObject({ outcome: "oauth_invalid" });
    expect(graph.calls).toHaveLength(0);
    expect(await system.adConnection.count()).toBe(0);
  });

  it("re-checks the person's role at the callback, and records a cancelled consent", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const admin = await member(owner, WorkspaceRole.ADMIN);
    const graph = fakeGraph();
    const deps = depsFor(graph.meta);
    const state = await begin(deps, admin);
    await system.workspaceMember.updateMany({
      where: { userId: admin.userId },
      data: { role: WorkspaceRole.EDITOR },
    });
    expect(
      await completeConnection(deps, {
        sessionUserId: admin.userId,
        state,
        code: "c",
        error: null,
        platform: "META",
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "forbidden" });
    const denied = await begin(deps, owner);
    expect(
      await completeConnection(deps, {
        sessionUserId: owner.userId,
        state: denied,
        code: null,
        error: "access_denied",
        platform: "META",
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "denied", slug: owner.slug, locale: "en" });
    expect(graph.calls).toHaveLength(0);
    expect(await system.auditLog.count({ where: { action: "ads.connect_failed" } })).toBe(1);
  });

  it("does not store a token when the read permission was not granted", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const graph = fakeGraph({ permissions: ["public_profile"] });
    const deps = depsFor(graph.meta);
    const state = await begin(deps, owner);
    expect(
      await completeConnection(deps, {
        sessionUserId: owner.userId,
        state,
        code: "c",
        error: null,
        platform: "META",
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "permission_missing" });
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({
      status: "ERROR",
      tokenCiphertext: null,
      lastErrorCode: "permission_missing",
    });
    expect(await system.adAccount.count()).toBe(0);
  });

  it("lets only owners and admins connect, and never offers unimplemented platforms", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const deps = depsFor(fakeGraph().meta);
    for (const role of [WorkspaceRole.MANAGER, WorkspaceRole.EDITOR, WorkspaceRole.CLIENT]) {
      await expect(begin(deps, await member(owner, role))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    for (const platform of ["SNAPCHAT", "TIKTOK", "WHATSAPP"]) {
      await expect(
        startConnection(deps, owner, { platform, locale: "en", redirectUri: REDIRECT }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        fields: [{ code: "ads_operation_unavailable" }],
      });
    }
    await expect(begin(depsFor(null), owner)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      fields: [{ code: "ads_not_configured" }],
    });
    await expect(begin({ ...deps, tokenKey: null }, owner)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    // The server action refuses unknown fields before anything else.
    const result = await startConnectionAction({
      slug: owner.slug,
      platform: "META",
      locale: "en",
      workspaceId: owner.workspaceId,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });
});

describe("the Meta callback route", () => {
  const call = (query: string) =>
    metaCallback(new Request(`http://localhost:3000/api/integrations/meta/callback?${query}`), {
      params: Promise.resolve({}),
    });

  it("sends a visitor without a session to sign-in (303, not an error)", async () => {
    session.user = null;
    const response = await call("state=abcdefghijklmnopqrstuvwxyz&code=secret-code");
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/ar/sign-in");
    expect(response.headers.get("location")).not.toContain("secret-code");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers an unknown state with an outcome code only", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    session.user = { id: owner.userId };
    const response = await call("state=abcdefghijklmnopqrstuvwxyz&code=secret-code");
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/ar/workspaces");
    expect(location.searchParams.get("connect")).toBe("oauth_invalid");
    expect(location.toString()).not.toContain("secret-code");
    expect(response.headers.get("cache-control")).toBe("no-store");
    session.user = null;
  });
});

// ── reading ──────────────────────────────────────────────────────────────────

describe("reading Meta ads", () => {
  it("syncs a selected account read-only into the unified snapshot", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account, calls } = await connected(owner);
    await expect(syncAccount(deps, owner, account.id)).rejects.toMatchObject({
      fields: [{ code: "ads_account_unavailable" }],
    });
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    const manager = await member(owner, WorkspaceRole.MANAGER);
    expect(await syncAccount(deps, manager, account.id)).toEqual({ campaigns: 1 });
    const saved = await system.adAccount.findUniqueOrThrow({ where: { id: account.id } });
    const snapshot = readAccountSnapshot(saved.snapshot);
    expect(snapshot?.campaigns[0]).toMatchObject({
      externalId: "c1",
      objective: "TRAFFIC",
      dailyBudget: { minor: 5000, currency: "SAR" },
    });
    expect(snapshot?.metrics[0]).toMatchObject({
      impressions: 100_000,
      clicks: 1000,
      spend: { minor: 200_000, currency: "SAR" },
    });
    // Only reads ever left Flexibx, all with the decrypted token for this workspace.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.filter((c) => c.path.startsWith("/act_")).every((c) => c.token === TOKEN)).toBe(
      true,
    );
    const editor = await member(owner, WorkspaceRole.EDITOR);
    await expect(syncAccount(deps, editor, account.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("marks an expired token and stops calling the platform", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const first = await connected(owner);
    await selectAccount(db, owner, { accountId: first.account.id, selected: true });
    const expiredGraph = fakeGraph({ failOn: { "/campaigns": 190 } });
    const deps = depsFor(expiredGraph.meta);
    await expect(syncAccount(deps, owner, first.account.id)).rejects.toMatchObject({
      fields: [{ code: "ads_token_expired" }],
    });
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({ status: "EXPIRED", lastErrorCode: "token_expired" });
    const before = expiredGraph.calls.length;
    await expect(syncAccount(deps, owner, first.account.id)).rejects.toMatchObject({
      fields: [{ code: "ads_token_expired" }],
    });
    expect(expiredGraph.calls.length).toBe(before);
    expect(await system.auditLog.count({ where: { action: "ads.sync_failed" } })).toBe(2);
  });

  it("reports missing permissions and rate limits from the platform clearly", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { account } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    await expect(
      syncAccount(depsFor(fakeGraph({ failOn: { "/insights": 200 } }).meta), owner, account.id),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "ads_permission_missing" }],
    });
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({ lastErrorCode: "permission_missing" });
    await expect(
      refreshAccounts(depsFor(fakeGraph({ failOn: { "/me/adaccounts": 17 } }).meta), owner, "META"),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      fields: [{ code: "ads_rate_limited" }],
    });
  });

  it("deletes the token on disconnect", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    await disconnect(db, owner, "META");
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({ status: "REVOKED", tokenCiphertext: null });
    expect((await system.adAccount.findUniqueOrThrow({ where: { id: account.id } })).selected).toBe(
      false,
    );
    await expect(refreshAccounts(deps, owner, "META")).rejects.toMatchObject({
      fields: [{ code: "ads_not_connected" }],
    });
  });
});

// ── workspace isolation ──────────────────────────────────────────────────────

describe("workspace isolation", () => {
  it("keeps connections, accounts, tokens and plans inside their workspace", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account } = await connected(a);
    await expect(
      selectAccount(db, b, { accountId: account.id, selected: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(syncAccount(deps, b, account.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The tenant guard refuses unscoped reads of advertising rows.
    await expect(db.adConnection.findMany()).rejects.toThrow();
    await expect(db.adAccount.findMany({ where: {} })).rejects.toThrow();
    // A ciphertext copied into another workspace's row does not decrypt there.
    const stolen = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: a.workspaceId },
    });
    await system.adConnection.create({
      data: {
        workspaceId: b.workspaceId,
        platform: "META",
        externalUserId: "777",
        tokenCiphertext: stolen.tokenCiphertext,
      },
    });
    await expect(refreshAccounts(deps, b, "META")).rejects.toMatchObject({
      fields: [{ code: "ads_not_connected" }],
    });
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: b.workspaceId } }),
    ).toMatchObject({ status: "ERROR", lastErrorCode: "token_unreadable" });
    // A plan cannot point at another workspace's account (database trigger).
    await expect(
      system.adPlan.create({
        data: {
          workspaceId: b.workspaceId,
          accountId: account.id,
          platform: "META",
          name: "x",
          proposal: {},
          budgetTotalMinor: 100n,
          currency: "SAR",
          startDate: new Date("2026-11-01"),
          endDate: new Date("2026-11-02"),
        },
      }),
    ).rejects.toThrow();
  });
});

// ── planning ─────────────────────────────────────────────────────────────────

async function readyToPlan(options: GraphOptions = {}) {
  const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
  const setup = await connected(owner, options);
  await selectAccount(db, owner, { accountId: setup.account.id, selected: true });
  await syncAccount(setup.deps, owner, setup.account.id);
  const image = await system.mediaAsset.create({
    data: {
      workspaceId: owner.workspaceId,
      filename: "storefront.png",
      contentType: "image/png",
      sizeBytes: 1,
      storageKey: `workspaces/${owner.workspaceId}/content-media/${crypto.randomUUID()}.png`,
      storageProvider: "LEGACY_S3",
      altText: "Our storefront",
    },
  });
  return { owner, ...setup, image };
}

describe("AI advertising planner", () => {
  it("proposes a plan with the person's budget and dates and a workspace image", async () => {
    const { owner, account, image, meta } = await readyToPlan();
    const manager = await member(owner, WorkspaceRole.MANAGER);
    const { planId } = await createAdPlan(
      db,
      manager,
      ai,
      {
        accountId: account.id,
        budget: "1,500.50",
        startDate: plusDays(1),
        endDate: plusDays(30),
        request: "Weekend offer",
      },
      "en",
    );
    const plan = await system.adPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan).toMatchObject({
      status: "DRAFT",
      platform: "META",
      currency: "SAR",
      budgetTotalMinor: 150_050n,
      createdByUserId: manager.userId,
    });
    expect(plan.proposal).toMatchObject({
      objective: "TRAFFIC",
      audience: { countries: ["SA"] },
      creative: { mediaAssetId: image.id },
    });
    const generation = await system.aiGeneration.findUniqueOrThrow({
      where: { id: plan.aiGenerationId ?? "" },
    });
    expect(generation).toMatchObject({ operation: "AD_PLAN", status: "SUCCEEDED" });
    expect(generation.appliedAt).not.toBeNull();
    // An advertising proposal is never usable as content in AI Studio.
    await expect(getMyGeneration(db, manager, generation.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const review = await getAdPlanReview(db, owner, adapters(meta), planId);
    expect(review).toMatchObject({
      budget: { minor: 150_050, currency: "SAR" },
      days: 30,
      media: { id: image.id, filename: "storefront.png" },
      // The AI chose Instagram placements, which need an Instagram identity Flexibx does
      // not select: creation from Flexibx is refused for this plan, before any call.
      launch: { available: false, reason: "placement_unsupported" },
      expected: { available: true },
    });
    // Not executable as planned: the review describes the plan's calls (no image upload).
    expect(review.externalActions?.map((action) => action.endpoint)).toEqual([
      "/act_111/campaigns",
      "/act_111/adsets",
      "/act_111/adcreatives",
      "/act_111/ads",
    ]);
    expect(review.externalActions?.[1]?.params).toMatchObject({
      lifetime_budget: 150_050,
      status: "PAUSED",
    });
    expect(await system.auditLog.count({ where: { action: "ads.plan_created" } })).toBe(1);
  });

  it("validates money and dates deterministically and refuses roles without ads.plan", async () => {
    const { owner, account } = await readyToPlan({
      history: { impressions: "100", clicks: "1", spend: "1.00" },
    });
    const plan = (input: Record<string, string>) =>
      createAdPlan(
        db,
        owner,
        ai,
        {
          accountId: account.id,
          budget: "100",
          startDate: plusDays(1),
          endDate: plusDays(5),
          request: "",
          ...input,
        },
        "ar",
      );
    await expect(plan({ budget: "0" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      fields: [{ path: "budget" }],
    });
    await expect(plan({ budget: "-5" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(plan({ startDate: plusDays(-2) })).rejects.toMatchObject({
      fields: [{ path: "startDate" }],
    });
    await expect(plan({ endDate: plusDays(0) })).rejects.toMatchObject({
      fields: [{ path: "endDate" }],
    });
    await expect(plan({ endDate: plusDays(120) })).rejects.toMatchObject({
      fields: [{ path: "endDate", code: "too_big" }],
    });
    const editor = await member(owner, WorkspaceRole.EDITOR);
    await expect(
      createAdPlan(
        db,
        editor,
        ai,
        { accountId: account.id, budget: "100", startDate: plusDays(1), endDate: plusDays(5) },
        "en",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Too little history: no estimate is invented.
    const { planId } = await plan({});
    const review = await getAdPlanReview(db, owner, adapters(null), planId);
    expect(review.expected).toEqual({ available: false, reason: "insufficient_history" });
    expect(review.externalActions).toBeNull();
    expect(review.launch).toEqual({ available: false, reason: "not_configured" });
    expect(await system.aiGeneration.count({ where: { operation: "AD_PLAN" } })).toBe(1);
  });

  it("refuses to submit a Meta plan until execution, a spend limit and a destination exist", async () => {
    const { owner, account, meta } = await readyToPlan();
    const { planId } = await createAdPlan(
      db,
      owner,
      ai,
      { accountId: account.id, budget: "500", startDate: plusDays(1), endDate: plusDays(7) },
      "en",
    );
    const deps: OrchestrationDeps<AdLaunchServices> & { adapters: AdAdapters } = {
      db,
      adapters: adapters(meta),
      services: { ads: () => adapters(meta), tokenKey: () => KEY },
      workflows: { ad_launch: adLaunchWorkflow },
    };
    await expect(submitAdPlan(deps, owner, planId)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "ads_execution_disabled" }],
    });
    const enabled = { ...deps, executionEnabled: true, tokenKey: KEY };
    // Instagram placements (chosen by the AI) are refused: no Instagram identity.
    await expect(submitAdPlan(enabled, owner, planId)).rejects.toMatchObject({
      fields: [{ code: "ads_operation_unavailable" }],
    });
    const proposal = (await system.adPlan.findUniqueOrThrow({ where: { id: planId } }))
      .proposal as Record<string, unknown>;
    await system.adPlan.update({
      where: { id: planId },
      data: { proposal: { ...proposal, placements: ["FACEBOOK_FEED"] } },
    });
    await expect(submitAdPlan(enabled, owner, planId)).rejects.toMatchObject({
      fields: [{ code: "ads_destination_missing" }],
    });
    await updateAdPlan(db, owner, planId, {
      budget: "500",
      startDate: plusDays(1),
      endDate: plusDays(7),
      campaignName: "Week",
      headline: "Fresh",
      primaryText: "Coffee",
      destinationUrl: "https://shop.example.com/offer",
    });
    // Connected with read access only: creating needs the write permissions.
    await expect(submitAdPlan(enabled, owner, planId)).rejects.toMatchObject({
      fields: [{ code: "ads_permission_missing" }],
    });
    await system.adConnection.updateMany({
      where: { workspaceId: owner.workspaceId },
      data: { scopes: ["ads_read", "ads_management", "pages_show_list", "pages_manage_ads"] },
    });
    await expect(submitAdPlan(enabled, owner, planId)).rejects.toMatchObject({
      fields: [{ code: "ads_spend_limit_missing" }],
    });
    await setSpendLimit(db, owner, {
      currency: "SAR",
      maxPlanBudget: "400",
      maxDailyBudget: "100",
    });
    await expect(submitAdPlan(enabled, owner, planId)).rejects.toMatchObject({
      fields: [{ code: "ads_spend_limit_exceeded" }],
    });
    await setSpendLimit(db, owner, {
      currency: "SAR",
      maxPlanBudget: "5000",
      maxDailyBudget: "50",
    });
    await expect(submitAdPlan(enabled, owner, planId)).rejects.toMatchObject({
      fields: [{ code: "ads_daily_limit_exceeded" }],
    });
    const review = await getAdPlanReview(db, owner, adapters(meta), planId, {
      executionEnabled: true,
    });
    expect(review.launch).toEqual({ available: true });
    expect(await system.agentRun.count()).toBe(0);
  });
});

describe("planner robustness", () => {
  it("records malformed AI output as a failed generation and creates no plan", async () => {
    const { owner, account } = await readyToPlan();
    for (const scenario of ["schema_mismatch", "malformed", "empty"] as const) {
      await expect(
        createAdPlan(
          db,
          owner,
          { provider: createFakeProvider({ scenario }), timeoutMs: 5_000 },
          { accountId: account.id, budget: "100", startDate: plusDays(1), endDate: plusDays(3) },
          "en",
        ),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    }
    expect(await system.adPlan.count()).toBe(0);
    expect(
      await system.aiGeneration.count({
        where: { operation: "AD_PLAN", status: "FAILED", errorCode: "invalid_output" },
      }),
    ).toBe(3);
  });

  it("drops an image handle the AI was not shown, and plans without images", async () => {
    const { owner, account } = await readyToPlan();
    const { planId } = await createAdPlan(
      db,
      owner,
      { provider: createFakeProvider({ scenario: "unknown_references" }), timeoutMs: 5_000 },
      { accountId: account.id, budget: "100", startDate: plusDays(1), endDate: plusDays(3) },
      "en",
    );
    expect(
      (await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).proposal,
    ).toMatchObject({
      creative: { mediaAssetId: null },
    });
    await system.mediaAsset.deleteMany({ where: { workspaceId: owner.workspaceId } });
    const second = await createAdPlan(
      db,
      owner,
      ai,
      { accountId: account.id, budget: "100", startDate: plusDays(1), endDate: plusDays(3) },
      "ar",
    );
    const review = await getAdPlanReview(db, owner, adapters(null), second.planId);
    expect(review.media).toBeNull();
    expect(review.spec?.creative.mediaAssetId).toBeNull();
  });

  it("judges 'today' in the ad account's time zone", () => {
    const lateUtc = new Date("2026-10-10T22:30:00Z"); // already 11 October in Riyadh
    expect(todayIn("Asia/Riyadh", lateUtc)).toBe("2026-10-11");
    expect(todayIn(null, lateUtc)).toBe("2026-10-10");
    expect(todayIn("Not/AZone", lateUtc)).toBe("2026-10-10");
  });

  it("cleans up long-expired OAuth states when a new connection starts", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const other = await createTenant(system, { role: WorkspaceRole.OWNER });
    const old = new Date(Date.now() - STATE_RETENTION_MS - 3_600_000);
    for (const tenant of [owner, other]) {
      await system.adOAuthState.create({
        data: {
          workspaceId: tenant.workspaceId,
          userId: tenant.userId,
          platform: "META",
          stateHash: hashState(crypto.randomUUID()),
          locale: "en",
          createdAt: old,
          expiresAt: new Date(old.getTime() + 600_000),
        },
      });
    }
    await begin(depsFor(fakeGraph().meta), owner);
    expect(await system.adOAuthState.count({ where: { workspaceId: owner.workspaceId } })).toBe(1);
    // Another workspace's rows are not touched.
    expect(await system.adOAuthState.count({ where: { workspaceId: other.workspaceId } })).toBe(1);
  });
});

// ── the launch boundary and approvals ────────────────────────────────────────

describe("launching through approvals", () => {
  async function launchable() {
    const setup = await readyToPlan();
    const launches: LaunchRequest[] = [];
    let fail = false;
    // A platform with a single-call launch and no step-by-step write path (the legacy
    // boundary): the approval engine and limits are the same.
    const { writer: _writer, ...withoutWriter } = setup.meta;
    const adapter: AdPlatformAdapter = {
      ...withoutWriter,
      capabilities: { ...setup.meta.capabilities, launchCampaign: true },
      launchCampaign: (token, request) => {
        expect(token).toBe(TOKEN);
        launches.push(request);
        if (fail) return Promise.reject(new Error("platform refused"));
        return Promise.resolve({ externalCampaignId: "999000" });
      },
    };
    const all = adapters(adapter);
    const deps: OrchestrationDeps<AdLaunchServices> & ExecutionDeps = {
      db,
      adapters: all,
      executionEnabled: true,
      services: { ads: () => all, tokenKey: () => KEY, executionEnabled: () => true },
      workflows: { ad_launch: adLaunchWorkflow },
    };
    await setSpendLimit(db, setup.owner, {
      currency: "SAR",
      maxPlanBudget: "100000",
      maxDailyBudget: "100000",
    });
    const { planId } = await createAdPlan(
      db,
      setup.owner,
      ai,
      { accountId: setup.account.id, budget: "750", startDate: plusDays(1), endDate: plusDays(10) },
      "en",
    );
    return { ...setup, deps, planId, launches, failNext: () => (fail = true) };
  }

  const launchTask = (runId: string) =>
    system.agentTask.findFirstOrThrow({ where: { runId, key: "launch" } });

  it("spends nothing until a person approves the exact launch, then launches once", async () => {
    const { owner, deps, planId, launches } = await launchable();
    const manager = await member(owner, WorkspaceRole.MANAGER);
    await expect(submitAdPlan(deps, manager, planId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { runId } = await submitAdPlan(deps, owner, planId);
    await expect(
      updateAdPlan(db, owner, planId, {
        budget: "1",
        startDate: plusDays(1),
        endDate: plusDays(2),
        campaignName: "x",
        headline: "x",
        primaryText: "x",
      }),
    ).rejects.toMatchObject({
      fields: [{ code: "ads_plan_locked" }],
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
      state: "NEEDS_ATTENTION",
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
      state: "NEEDS_ATTENTION",
    });
    expect(launches).toHaveLength(0);
    const task = await launchTask(runId);
    expect(task).toMatchObject({ state: "NEEDS_APPROVAL", risk: "SPEND" });
    expect(task.approvalRequest).toMatchObject({
      action: "launch_ad_campaign",
      amount: { minor: 75_000, currency: "SAR" },
      details: { platform: "META", account: "111", planId },
    });

    const admin = await member(owner, WorkspaceRole.ADMIN);
    await decideApproval(db, admin, {
      taskId: task.id,
      decision: "APPROVED",
      snapshotHash: task.approvalHash,
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      planId,
      budgetTotalMinor: 75_000,
      currency: "SAR",
      accountExternalId: "111",
    });
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      status: "LAUNCHED",
      externalCampaignId: "999000",
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });
    expect(launches).toHaveLength(1);
    expect(
      await system.auditLog.count({
        where: { action: { in: ["ads.launch_requested", "ads.launch_succeeded"] } },
      }),
    ).toBe(2);
  });

  it("asks again when the plan changes after approval, and honours the emergency stop", async () => {
    const { owner, deps, planId, launches } = await launchable();
    const { runId } = await submitAdPlan(deps, owner, planId);
    await executeRun(deps, owner.workspaceId, runId);
    const task = await launchTask(runId);
    await decideApproval(db, owner, {
      taskId: task.id,
      decision: "APPROVED",
      snapshotHash: task.approvalHash,
    });
    // The budget changes behind the approval: the approved action is no longer the one.
    await system.adPlan.update({
      where: { id: planId },
      data: { budgetTotalMinor: 9_999_900n, version: { increment: 1 } },
    });
    await executeRun(deps, owner.workspaceId, runId);
    expect(launches).toHaveLength(0);
    const again = await launchTask(runId);
    expect(again).toMatchObject({ state: "NEEDS_APPROVAL", approvalRound: 2 });
    expect(again.approvalRequest).toMatchObject({ amount: { minor: 9_999_900 } });
    // Approved again, but the emergency stop is on: nothing is sent.
    await decideApproval(db, owner, {
      taskId: again.id,
      decision: "APPROVED",
      snapshotHash: again.approvalHash,
    });
    await setAutomationPaused(db, owner, true);
    expect(await executeRun(deps, owner.workspaceId, runId)).toEqual({ status: "paused" });
    expect(launches).toHaveLength(0);
    await setAutomationPaused(db, owner, false);
    await executeRun(deps, owner.workspaceId, runId);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.budgetTotalMinor).toBe(9_999_900);
  });

  it("fails closed on a platform error, without retrying, and a rejection launches nothing", async () => {
    const { owner, deps, planId, launches, failNext } = await launchable();
    const { runId } = await submitAdPlan(deps, owner, planId);
    await executeRun(deps, owner.workspaceId, runId);
    const task = await launchTask(runId);
    failNext();
    await decideApproval(db, owner, {
      taskId: task.id,
      decision: "APPROVED",
      snapshotHash: task.approvalHash,
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({ state: "FAILED" });
    expect(launches).toHaveLength(1);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      status: "FAILED",
    });
    expect(await system.auditLog.count({ where: { action: "ads.launch_failed" } })).toBe(1);

    const second = await launchable();
    const { runId: other } = await submitAdPlan(second.deps, second.owner, second.planId);
    await executeRun(second.deps, second.owner.workspaceId, other);
    const pending = await launchTask(other);
    await decideApproval(db, second.owner, {
      taskId: pending.id,
      decision: "REJECTED",
      snapshotHash: pending.approvalHash,
    });
    expect(await executeRun(second.deps, second.owner.workspaceId, other)).toMatchObject({
      state: "FAILED",
    });
    expect(second.launches).toHaveLength(0);
    await expect(discardAdPlan(db, second.owner, second.planId)).rejects.toMatchObject({
      fields: [{ code: "ads_plan_locked" }],
    });
  });
});

// ── rendered views ───────────────────────────────────────────────────────────

function render(locale: "ar" | "en", node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "ar" ? ar : en,
      timeZone: "Asia/Riyadh",
      children: node,
    }),
  );
}

describe("advertising views", () => {
  it("shows each platform honestly, in Arabic and English", () => {
    const platforms = [
      {
        platform: "META" as const,
        available: true,
        reason: null,
        capabilities: null,
        connection: {
          status: "ACTIVE" as const,
          externalUserName: "Graph Tester",
          scopes: ["ads_read"],
          tokenExpiresAt: null,
          lastErrorCode: null,
          updatedAt: new Date(),
          connectedByName: "Owner",
        },
      },
      {
        platform: "SNAPCHAT" as const,
        available: false,
        reason: "not_implemented" as const,
        capabilities: null,
        connection: null,
      },
      {
        platform: "TIKTOK" as const,
        available: false,
        reason: "not_implemented" as const,
        capabilities: null,
        connection: null,
      },
      {
        platform: "WHATSAPP" as const,
        available: false,
        reason: "not_implemented" as const,
        capabilities: null,
        connection: null,
      },
    ];
    const props = { slug: "acme", timeZone: "Asia/Riyadh", platforms, canManage: true };
    const html = render("en", createElement(PlatformCards, { ...props, locale: "en" }));
    expect(html).toContain('data-platform="META" data-status="connected"');
    expect(html).toContain('data-platform="SNAPCHAT" data-status="notAvailable"');
    expect(html.match(/Not available yet/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain(TOKEN);
    const arabic = render("ar", createElement(PlatformCards, { ...props, locale: "ar" }));
    expect(arabic).toContain("غير متاحة بعد");
    expect(arabic).toContain("ميتا (فيسبوك وإنستغرام)");
    const actions = render(
      "en",
      createElement(ExternalActions, {
        actions: [{ method: "POST", endpoint: "/act_111/campaigns", params: { status: "PAUSED" } }],
      }),
    );
    expect(actions).toContain("POST /act_111/campaigns");
    expect(actions).toContain('dir="ltr"');
  });
});
