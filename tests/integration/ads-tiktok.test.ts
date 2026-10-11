import { randomBytes } from "node:crypto";

import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformCards } from "@/app/[locale]/w/[workspaceSlug]/ads/ads-views";
import { GET as tiktokCallback } from "@/app/api/integrations/tiktok/callback/route";
import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters, AdPlatformAdapter } from "@/server/ads/adapter";
import { createTikTokAdapter } from "@/server/ads/adapters/tiktok";
import {
  completeConnection,
  disconnect,
  hashState,
  refreshAccounts,
  selectAccount,
  startConnection,
  syncAccount,
  type AdsDeps,
} from "@/server/ads/connections";
import { readAccountSnapshot } from "@/server/ads/model";
import { createAdPlan, getAdPlanReview, submitAdPlan } from "@/server/ads/planner";
import { decryptToken } from "@/server/ads/token-vault";
import { createFakeProvider } from "@/server/ai/fake-provider";
import type { OrchestrationDeps } from "@/server/orchestration/engine";
import {
  adLaunchWorkflow,
  type AdLaunchServices,
} from "@/server/orchestration/workflows/ad-launch";
import type { TenantContext } from "@/server/tenancy/context";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTenant, createTestDb, resetDatabase } from "./helpers";

// The TikTok advertising slice on the real database, with a deterministic stand-in for
// business-api.tiktok.com (no network, no real account, nothing published or paid): the
// OAuth state (expiry, single use, platform, session, role), the long-term token stored
// encrypted and bound to its workspace, read-only syncs with pagination mapped into the
// unified model, TikTok's error codes, the shared planner and review, and launching
// staying unavailable.

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
const TOKEN = "tt-integration-long-term-secret-token";
const SECRET = "tiktok-integration-app-secret-000";
const ADV = "7012345678901234567";
const REDIRECT = "https://app.test/api/integrations/tiktok/callback";
const ai = { provider: createFakeProvider(), timeoutMs: 5_000 };

beforeEach(async () => {
  await resetDatabase(system);
  session.user = null;
});

afterAll(async () => {
  await system.$disconnect();
});

// ── a stand-in for the TikTok API for Business ───────────────────────────────

interface TikTokOptions {
  /** A TikTok `code` returned for every read (not the exchange). */
  readCode?: number;
  /** Total pages the campaign list claims. */
  campaignPages?: number;
}

function fakeTikTok(options: TikTokOptions = {}) {
  const calls: { method: string; path: string; token: string | null; url: string }[] = [];
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace("/open_api/v1.3", "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      token: new Headers(init?.headers).get("Access-Token"),
      url: url.toString(),
    });
    const json = (data: unknown, code = 0) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code,
            message: code === 0 ? "OK" : `err ${TOKEN}`,
            request_id: "r",
            data,
          }),
        ),
      );
    if (path === "/oauth2/access_token/") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        auth_code?: string;
      };
      return body.auth_code === "auth-code"
        ? json({ access_token: TOKEN, advertiser_ids: [ADV], scope: [4, 5] })
        : json({}, 40002);
    }
    if (options.readCode !== undefined) return json({}, options.readCode);
    const page = Number(url.searchParams.get("page") ?? "1");
    const paging = (total = 1) => ({
      page,
      page_size: 1000,
      total_number: total,
      total_page: total,
    });
    switch (path) {
      case "/oauth2/advertiser/get/":
        return json({ list: [{ advertiser_id: ADV, advertiser_name: "TT SAR" }] });
      case "/advertiser/info/":
        return json({
          list: [
            {
              advertiser_id: ADV,
              name: "TT SAR",
              currency: "SAR",
              display_timezone: "Asia/Riyadh",
              status: "STATUS_ENABLE",
            },
          ],
        });
      case "/campaign/get/":
        return json({
          list: [
            {
              campaign_id: `18000000000000000${String(page)}`,
              campaign_name: `TikTok campaign ${String(page)}`,
              objective_type: "TRAFFIC",
              operation_status: "ENABLE",
              budget_mode: "BUDGET_MODE_DAY",
              budget: 50,
            },
          ],
          page_info: paging(options.campaignPages ?? 1),
        });
      case "/adgroup/get/":
        return json({
          list: [
            {
              adgroup_id: "1810000000000000001",
              campaign_id: "180000000000000001",
              adgroup_name: "Group",
              operation_status: "ENABLE",
              age_groups: ["AGE_18_24"],
            },
          ],
          page_info: paging(),
        });
      case "/ad/get/":
        return json({
          list: [
            {
              ad_id: "1820000000000000001",
              adgroup_id: "1810000000000000001",
              campaign_id: "180000000000000001",
              ad_name: "Ad",
              operation_status: "ENABLE",
            },
          ],
          page_info: paging(),
        });
      case "/report/integrated/get/":
        return json({
          list: [
            {
              dimensions: { campaign_id: "180000000000000001" },
              metrics: { spend: "2000.00", impressions: "100000", clicks: "1000", reach: "50000" },
            },
          ],
          page_info: paging(),
        });
      default:
        return json({}, 40002);
    }
  };
  const tiktok = createTikTokAdapter({
    appId: "7400000000000000001",
    appSecret: SECRET,
    fetch: fetchImpl,
  });
  return { tiktok, calls };
}

function adapters(tiktok: AdPlatformAdapter | null): AdAdapters {
  return {
    META: { platform: "META", available: false, reason: "not_configured" },
    SNAPCHAT: { platform: "SNAPCHAT", available: false, reason: "not_configured" },
    TIKTOK:
      tiktok === null
        ? { platform: "TIKTOK", available: false, reason: "not_configured" }
        : { platform: "TIKTOK", available: true, adapter: tiktok },
    WHATSAPP: { platform: "WHATSAPP", available: false, reason: "not_implemented" },
  };
}

function depsFor(tiktok: AdPlatformAdapter | null): AdsDeps & { system: typeof system } {
  return { db, system, adapters: adapters(tiktok), tokenKey: KEY };
}

async function begin(deps: AdsDeps, ctx: TenantContext, platform = "TIKTOK") {
  const { url } = await startConnection(deps, ctx, {
    platform,
    locale: "en",
    redirectUri: REDIRECT,
  });
  return new URL(url).searchParams.get("state") ?? "";
}

const complete = (
  deps: AdsDeps & { system: typeof system },
  ctx: { userId: string },
  state: string,
  overrides: Partial<{ code: string | null; platform: "TIKTOK" | "META"; error: string }> = {},
) =>
  completeConnection(deps, {
    platform: overrides.platform ?? "TIKTOK",
    sessionUserId: ctx.userId,
    state,
    code: overrides.code === undefined ? "auth-code" : overrides.code,
    error: overrides.error ?? null,
    redirectUri: REDIRECT,
  });

async function connected(ctx: TenantContext, options: TikTokOptions = {}) {
  const fake = fakeTikTok(options);
  const deps = depsFor(fake.tiktok);
  const state = await begin(deps, ctx);
  expect((await complete(deps, ctx, state)).outcome).toBe("connected");
  const account = await system.adAccount.findFirstOrThrow({
    where: { workspaceId: ctx.workspaceId, externalId: ADV },
  });
  return { ...fake, deps, account };
}

const plusDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// ── authentication ───────────────────────────────────────────────────────────

describe("connecting TikTok", () => {
  it("stores the long-term token encrypted and bound to the workspace, never in clear", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { calls } = await connected(owner);
    const connection = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    expect(connection).toMatchObject({
      platform: "TIKTOK",
      status: "ACTIVE",
      scopes: ["4", "5"],
      tokenExpiresAt: null,
      externalUserName: null,
    });
    expect(connection.externalUserId).toMatch(/^authorization-[0-9a-f]{24}$/);
    expect(
      decryptToken(KEY, connection.tokenCiphertext ?? "", {
        workspaceId: owner.workspaceId,
        platform: "TIKTOK",
      }),
    ).toBe(TOKEN);
    // Bound to TikTok in this workspace: no other binding opens it.
    expect(() =>
      decryptToken(KEY, connection.tokenCiphertext ?? "", {
        workspaceId: owner.workspaceId,
        platform: "SNAPCHAT",
      }),
    ).toThrow();
    expect(
      await system.adAccount.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({
      platform: "TIKTOK",
      currency: "SAR",
      timeZone: "Asia/Riyadh",
      externalStatus: "ACTIVE",
    });
    const dump = JSON.stringify([
      await system.adConnection.findMany(),
      await system.adAccount.findMany(),
      await system.auditLog.findMany(),
      await system.adOAuthState.findMany(),
    ]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(SECRET);
    // The token travels in the Access-Token header only.
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
    expect(calls.filter((c) => c.method === "GET").every((c) => c.token === TOKEN)).toBe(true);
  });

  it("refuses expired, replayed, foreign-session and other-platform states before any exchange", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const intruder = await createTenant(system, { role: WorkspaceRole.OWNER });
    const fake = fakeTikTok();
    const deps = depsFor(fake.tiktok);

    const expired = await begin(deps, owner);
    await system.adOAuthState.updateMany({
      where: { stateHash: hashState(expired) },
      data: { createdAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await complete(deps, owner, expired)).toMatchObject({
      outcome: "oauth_invalid",
      slug: null,
    });

    const foreign = await begin(deps, owner);
    expect(await complete(deps, intruder, foreign)).toMatchObject({
      outcome: "oauth_invalid",
      slug: null,
    });
    // The foreign attempt burnt it: the owner cannot use it afterwards either.
    expect(await complete(deps, owner, foreign)).toMatchObject({ outcome: "oauth_invalid" });

    const crossPlatform = await begin(deps, owner);
    expect(await complete(deps, owner, crossPlatform, { platform: "META" })).toMatchObject({
      outcome: "oauth_invalid",
    });
    expect(await complete(deps, owner, "x".repeat(10))).toMatchObject({ outcome: "oauth_invalid" });
    expect(fake.calls).toHaveLength(0);
    expect(await system.adConnection.count()).toBe(0);

    const used = await begin(deps, owner);
    expect((await complete(deps, owner, used)).outcome).toBe("connected");
    expect(await complete(deps, owner, used)).toMatchObject({ outcome: "oauth_invalid" });
  });

  it("re-checks the role at the callback, records a cancelled consent and a rejected code", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const fake = fakeTikTok();
    const deps = depsFor(fake.tiktok);
    const demoted = await begin(deps, owner);
    await system.workspaceMember.updateMany({
      where: { workspaceId: owner.workspaceId, userId: owner.userId },
      data: { role: WorkspaceRole.EDITOR },
    });
    expect(await complete(deps, owner, demoted)).toMatchObject({ outcome: "forbidden" });
    await system.workspaceMember.updateMany({
      where: { workspaceId: owner.workspaceId, userId: owner.userId },
      data: { role: WorkspaceRole.OWNER },
    });
    expect(
      await complete(deps, owner, await begin(deps, owner), { code: null, error: "access_denied" }),
    ).toMatchObject({ outcome: "denied", slug: owner.slug });
    expect(
      await complete(deps, owner, await begin(deps, owner), { code: "expired-code" }),
    ).toMatchObject({ outcome: "oauth_invalid", slug: owner.slug });
    expect(await system.adConnection.count()).toBe(0);
    expect(await system.auditLog.count({ where: { action: "ads.connect_failed" } })).toBe(2);
    // Managers and below cannot start a connection; nor can anyone when not configured.
    await expect(begin(deps, { ...owner, role: WorkspaceRole.MANAGER })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(begin(depsFor(null), owner)).rejects.toMatchObject({
      fields: [{ code: "ads_not_configured" }],
    });
  });
});

describe("the TikTok callback route", () => {
  const call = (query: string) =>
    tiktokCallback(new Request(`http://localhost:3000/api/integrations/tiktok/callback?${query}`), {
      params: Promise.resolve({}),
    });

  it("sends a visitor without a session to sign-in and never echoes the code", async () => {
    const response = await call("state=abcdefghijklmnopqrstuvwxyz&auth_code=secret-auth-code");
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/ar/sign-in");
    expect(response.headers.get("location")).not.toContain("secret-auth-code");
  });

  it("reads TikTok's auth_code parameter", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    session.user = { id: owner.userId };
    // A real state, started with a test adapter; this deployment has no TikTok app
    // configured, so a state whose code was read ends as "not configured" — without the
    // auth_code it would be "oauth_invalid" (no code). Nothing reaches TikTok.
    const state = await begin(depsFor(fakeTikTok().tiktok), owner);
    const response = await call(`state=${state}&auth_code=secret-auth-code`);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe(`/en/w/${owner.slug}/integrations`);
    expect(location.searchParams.get("connect")).toBe("not_configured");
    expect(location.toString()).not.toContain("secret-auth-code");
    const missing = await begin(depsFor(fakeTikTok().tiktok), owner);
    const withoutCode = await call(`state=${missing}`);
    expect(new URL(withoutCode.headers.get("location") ?? "").searchParams.get("connect")).toBe(
      "oauth_invalid",
    );
  });
});

// ── reading ──────────────────────────────────────────────────────────────────

describe("reading TikTok ads", () => {
  it("syncs read-only with pagination into the unified snapshot", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { account } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    const paged = fakeTikTok({ campaignPages: 2 });
    await expect(syncAccount(depsFor(paged.tiktok), owner, account.id)).resolves.toEqual({
      campaigns: 2,
    });
    expect(paged.calls.every((c) => c.method === "GET")).toBe(true);
    expect(paged.calls.filter((c) => c.path === "/campaign/get/")).toHaveLength(2);
    const snapshot = readAccountSnapshot(
      (await system.adAccount.findUniqueOrThrow({ where: { id: account.id } })).snapshot,
    );
    expect(snapshot?.campaigns.map((c) => [c.name, c.objective, c.dailyBudget])).toEqual([
      ["TikTok campaign 1", "TRAFFIC", { minor: 5000, currency: "SAR" }],
      ["TikTok campaign 2", "TRAFFIC", { minor: 5000, currency: "SAR" }],
    ]);
    expect(snapshot?.metrics).toEqual([
      {
        campaignExternalId: "180000000000000001",
        impressions: 100_000,
        reach: 50_000,
        clicks: 1_000,
        spend: { minor: 200_000, currency: "SAR" },
      },
    ]);
    expect(snapshot?.truncated).toBe(false);
    // More pages than allowed: the rest is not read and the snapshot says so.
    const many = fakeTikTok({ campaignPages: 9 });
    await syncAccount(depsFor(many.tiktok), owner, account.id);
    expect(many.calls.filter((c) => c.path === "/campaign/get/")).toHaveLength(3);
    expect(
      readAccountSnapshot(
        (await system.adAccount.findUniqueOrThrow({ where: { id: account.id } })).snapshot,
      )?.truncated,
    ).toBe(true);
    expect(await system.auditLog.count({ where: { action: "ads.synced" } })).toBe(2);
  });

  it("marks a rejected token expired, and reports permissions and throttling clearly", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { account } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });

    await expect(
      syncAccount(depsFor(fakeTikTok({ readCode: 40001 }).tiktok), owner, account.id),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "ads_permission_missing" }],
    });
    await expect(
      syncAccount(depsFor(fakeTikTok({ readCode: 40100 }).tiktok), owner, account.id),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      fields: [{ code: "ads_rate_limited" }],
    });
    await expect(
      syncAccount(depsFor(fakeTikTok({ readCode: 50000 }).tiktok), owner, account.id),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });

    const revoked = fakeTikTok({ readCode: 40105 });
    await expect(syncAccount(depsFor(revoked.tiktok), owner, account.id)).rejects.toMatchObject({
      fields: [{ code: "ads_token_expired" }],
    });
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({ status: "EXPIRED", lastErrorCode: "token_expired" });
    revoked.calls.length = 0;
    await expect(syncAccount(depsFor(revoked.tiktok), owner, account.id)).rejects.toMatchObject({
      fields: [{ code: "ads_token_expired" }],
    });
    expect(revoked.calls).toHaveLength(0);
    // Errors are stored as codes, never TikTok's message (which here echoes the token).
    expect(JSON.stringify(await system.auditLog.findMany())).not.toContain(TOKEN);
  });

  it("keeps TikTok tokens and accounts inside their workspace, and disconnect deletes the token", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account } = await connected(a);
    await selectAccount(db, a, { accountId: account.id, selected: true });
    await expect(syncAccount(deps, b, account.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      selectAccount(db, b, { accountId: account.id, selected: false }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(refreshAccounts(deps, b, "TIKTOK")).rejects.toMatchObject({
      fields: [{ code: "ads_not_connected" }],
    });
    const source = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: a.workspaceId },
    });
    await system.adConnection.create({
      data: {
        workspaceId: b.workspaceId,
        platform: "TIKTOK",
        externalUserId: "copied",
        tokenCiphertext: source.tokenCiphertext,
      },
    });
    const fake = fakeTikTok();
    await expect(refreshAccounts(depsFor(fake.tiktok), b, "TIKTOK")).rejects.toMatchObject({
      fields: [{ code: "ads_not_connected" }],
    });
    expect(fake.calls).toHaveLength(0);

    await disconnect(db, a, "TIKTOK");
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: a.workspaceId } }),
    ).toMatchObject({ status: "REVOKED", tokenCiphertext: null });
    await expect(syncAccount(deps, a, account.id)).rejects.toMatchObject({
      fields: [{ code: "ads_account_unavailable" }],
    });
  });
});

// ── planning ─────────────────────────────────────────────────────────────────

describe("planning TikTok campaigns", () => {
  it("reuses the shared planner and review; launching is refused before any run", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account, tiktok } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    await syncAccount(deps, owner, account.id);
    const { planId } = await createAdPlan(
      db,
      owner,
      ai,
      { accountId: account.id, budget: "1500", startDate: plusDays(1), endDate: plusDays(30) },
      "en",
    );
    const plan = await system.adPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan).toMatchObject({ platform: "TIKTOK", budgetTotalMinor: 150_000n });
    expect(plan.proposal).toMatchObject({ placements: ["AUTOMATIC"] });

    const review = await getAdPlanReview(db, owner, adapters(tiktok), planId);
    expect(review).toMatchObject({
      platform: "TIKTOK",
      launch: { available: false, reason: "blocked" },
      expected: { available: true },
    });
    expect(review.externalActions?.map((a) => a.endpoint)).toEqual([
      "/open_api/v1.3/campaign/create/",
      "/open_api/v1.3/adgroup/create/",
      "/open_api/v1.3/ad/create/",
    ]);

    const orchestration: OrchestrationDeps<AdLaunchServices> & { adapters: AdAdapters } = {
      db,
      adapters: adapters(tiktok),
      services: { ads: () => adapters(tiktok), tokenKey: () => KEY },
      workflows: { ad_launch: adLaunchWorkflow },
    };
    await expect(submitAdPlan(orchestration, owner, planId)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "ads_operation_unavailable" }],
    });
    expect(await system.agentRun.count()).toBe(0);
    expect(await system.agentTaskApproval.count()).toBe(0);
    expect((await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe("DRAFT");
  });
});

// ── views ────────────────────────────────────────────────────────────────────

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

describe("TikTok in the advertising views", () => {
  it("shows what works and that launching is not available, in Arabic and English", () => {
    const platforms = [
      {
        platform: "TIKTOK" as const,
        available: true,
        reason: null,
        capabilities: fakeTikTok().tiktok.capabilities,
        connection: {
          status: "ACTIVE" as const,
          externalUserName: null,
          scopes: ["4", "5"],
          tokenExpiresAt: null,
          lastErrorCode: null,
          updatedAt: new Date(),
          connectedByName: "Owner",
        },
      },
      {
        platform: "WHATSAPP" as const,
        available: false,
        reason: "not_implemented" as const,
        capabilities: null,
        connection: null,
      },
    ];
    for (const locale of ["ar", "en"] as const) {
      const html = render(
        locale,
        createElement(PlatformCards, {
          slug: "acme",
          locale,
          timeZone: "Asia/Riyadh",
          platforms,
          canManage: true,
        }),
      );
      const messages = locale === "ar" ? ar : en;
      expect(html).toContain(messages.ads.platforms.TIKTOK.name);
      expect(html).toMatch(/data-platform="TIKTOK" data-status="connected"/);
      expect(html).toMatch(/data-capability="launchCampaign" data-available="false"/);
      expect(html).toMatch(/data-capability="readCampaigns" data-available="true"/);
      expect(html).toContain(messages.ads.capabilityOff);
      expect(html).toMatch(/data-platform="WHATSAPP" data-status="notAvailable"/);
      expect(html).toContain(messages.ads.platforms.WHATSAPP.unavailable.split("'")[0]);
    }
  });
});
