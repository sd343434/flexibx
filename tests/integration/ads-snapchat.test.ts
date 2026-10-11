import { randomBytes } from "node:crypto";

import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformCards } from "@/app/[locale]/w/[workspaceSlug]/ads/ads-views";
import { GET as snapchatCallback } from "@/app/api/integrations/snapchat/callback/route";
import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters, AdPlatformAdapter } from "@/server/ads/adapter";
import { createSnapchatAdapter } from "@/server/ads/adapters/snapchat";
import {
  completeConnection,
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

// The Snapchat advertising slice on the real database, with a deterministic stand-in for
// accounts.snapchat.com and adsapi.snapchat.com (no network, no real account, nothing
// published or paid): the OAuth state bound to the platform, the refresh token stored
// encrypted (never the access token), a fresh access token per use, rotation, revocation,
// workspace isolation, read-only syncs mapped into the unified model, the shared AI
// planner and review, and the launch staying unavailable.

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
const REFRESH = "snap-refresh-integration-secret";
const ACCESS = "snap-access-integration-secret";
const EMAIL = "snap-person@private.example";
const ACCOUNT = "0b2b6e4c-1111-4c4c-9a9a-aaaaaaaaaaaa";
const REDIRECT = "https://app.test/api/integrations/snapchat/callback";
const ai = { provider: createFakeProvider(), timeoutMs: 5_000 };

beforeEach(async () => {
  await resetDatabase(system);
  session.user = null;
});

afterAll(async () => {
  await system.$disconnect();
});

// ── a stand-in for Snap ──────────────────────────────────────────────────────

interface SnapOptions {
  /** Refresh tokens Snap accepts (others are revoked). */
  validRefresh?: string[];
  /** A different refresh token returned on refresh (rotation). */
  rotateTo?: string;
  /** HTTP status for API reads (not OAuth). */
  readStatus?: number;
}

function fakeSnap(options: SnapOptions = {}) {
  const calls: { method: string; path: string; auth: string | null; body: string | null }[] = [];
  let accessCounter = 0;
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({
      method: init?.method ?? "GET",
      path: `${url.hostname}${url.pathname}`,
      auth: headers.get("authorization"),
      body,
    });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(value), { status }));
    if (url.hostname === "accounts.snapchat.com") {
      const form = new URLSearchParams(body ?? "");
      if (form.get("grant_type") === "authorization_code") {
        return form.get("code") === "auth-code"
          ? json({
              access_token: ACCESS,
              refresh_token: REFRESH,
              expires_in: 3600,
              token_type: "Bearer",
              scope: "snapchat-marketing-api",
            })
          : json({ error: "invalid_grant" }, 400);
      }
      const valid = options.validRefresh ?? [REFRESH];
      if (!valid.includes(form.get("refresh_token") ?? "")) {
        return json({ error: "invalid_grant", error_description: `bad ${REFRESH}` }, 400);
      }
      accessCounter += 1;
      return json({
        access_token: `${ACCESS}-${String(accessCounter)}`,
        refresh_token: options.rotateTo ?? form.get("refresh_token"),
        expires_in: 3600,
      });
    }
    if (options.readStatus !== undefined && url.pathname !== "/v1/me") {
      return json({ request_status: "ERROR", debug_message: "denied" }, options.readStatus);
    }
    const path = url.pathname;
    if (path === "/v1/me") {
      return json({
        request_status: "SUCCESS",
        me: { id: "snap-user-1", display_name: "Snap Tester", email: EMAIL },
      });
    }
    if (path === "/v1/me/organizations") {
      return json({
        request_status: "SUCCESS",
        organizations: [
          {
            sub_request_status: "SUCCESS",
            organization: {
              id: "org-1",
              ad_accounts: [
                {
                  id: ACCOUNT,
                  name: "Snap SAR",
                  currency: "SAR",
                  timezone: "Asia/Riyadh",
                  status: "ACTIVE",
                },
              ],
            },
          },
        ],
      });
    }
    const wrap = (collection: string, entity: string, items: unknown[]) =>
      json({
        request_status: "SUCCESS",
        [collection]: items.map((item) => ({ sub_request_status: "SUCCESS", [entity]: item })),
        paging: {},
      });
    if (path.endsWith("/campaigns")) {
      return wrap("campaigns", "campaign", [
        {
          id: "camp-1",
          name: "Snap campaign",
          status: "ACTIVE",
          objective_v2_properties: { objective_v2_type: "TRAFFIC" },
          daily_budget_micro: 50_000_000,
        },
      ]);
    }
    if (path.endsWith("/adsquads")) {
      return wrap("adsquads", "adsquad", [
        {
          id: "sq-1",
          campaign_id: "camp-1",
          name: "Squad",
          status: "ACTIVE",
          targeting: { geos: [{ country_code: "sa" }] },
        },
      ]);
    }
    if (path.endsWith("/ads")) {
      return wrap("ads", "ad", [
        {
          id: "ad-1",
          ad_squad_id: "sq-1",
          name: "Ad",
          status: "ACTIVE",
          review_status: "APPROVED",
        },
      ]);
    }
    if (path.endsWith("/stats")) {
      return json({
        request_status: "SUCCESS",
        total_stats: [
          {
            sub_request_status: "SUCCESS",
            total_stat: {
              breakdown_stats: {
                campaign: [
                  {
                    id: "camp-1",
                    stats: { impressions: 100_000, swipes: 1_000, spend: 2_000_000_000 },
                  },
                ],
              },
            },
          },
        ],
      });
    }
    return json({ request_status: "ERROR" }, 404);
  };
  const snapchat = createSnapchatAdapter({
    clientId: "snap-client-id-123",
    clientSecret: "s".repeat(32),
    fetch: fetchImpl,
  });
  return { snapchat, calls };
}

function adapters(snapchat: AdPlatformAdapter | null): AdAdapters {
  return {
    META: { platform: "META", available: false, reason: "not_configured" },
    SNAPCHAT:
      snapchat === null
        ? { platform: "SNAPCHAT", available: false, reason: "not_configured" }
        : { platform: "SNAPCHAT", available: true, adapter: snapchat },
    TIKTOK: { platform: "TIKTOK", available: false, reason: "not_implemented" },
    WHATSAPP: { platform: "WHATSAPP", available: false, reason: "not_implemented" },
  };
}

function depsFor(snapchat: AdPlatformAdapter | null): AdsDeps & { system: typeof system } {
  return { db, system, adapters: adapters(snapchat), tokenKey: KEY };
}

async function begin(deps: AdsDeps, ctx: TenantContext, platform = "SNAPCHAT") {
  const { url } = await startConnection(deps, ctx, {
    platform,
    locale: "en",
    redirectUri: REDIRECT,
  });
  return new URL(url).searchParams.get("state") ?? "";
}

async function connected(ctx: TenantContext, options: SnapOptions = {}) {
  const snap = fakeSnap(options);
  const deps = depsFor(snap.snapchat);
  const state = await begin(deps, ctx);
  const result = await completeConnection(deps, {
    platform: "SNAPCHAT",
    sessionUserId: ctx.userId,
    state,
    code: "auth-code",
    error: null,
    redirectUri: REDIRECT,
  });
  expect(result.outcome).toBe("connected");
  const account = await system.adAccount.findFirstOrThrow({
    where: { workspaceId: ctx.workspaceId, externalId: ACCOUNT },
  });
  return { ...snap, deps, account };
}

const plusDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const binding = (ctx: TenantContext) => ({ workspaceId: ctx.workspaceId, platform: "SNAPCHAT" });

// ── connecting ───────────────────────────────────────────────────────────────

describe("connecting Snapchat", () => {
  it("stores only the encrypted refresh token, never the access token or the email", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { calls } = await connected(owner);

    const connection = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    expect(connection).toMatchObject({
      platform: "SNAPCHAT",
      status: "ACTIVE",
      externalUserId: "snap-user-1",
      externalUserName: "Snap Tester",
      scopes: ["snapchat-marketing-api"],
      // A refresh token states no expiry; the hour-long access token is not kept.
      tokenExpiresAt: null,
    });
    expect(connection.tokenCiphertext).toMatch(/^v1\./);
    expect(decryptToken(KEY, connection.tokenCiphertext ?? "", binding(owner))).toBe(REFRESH);

    const account = await system.adAccount.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    expect(account).toMatchObject({
      platform: "SNAPCHAT",
      externalId: ACCOUNT,
      currency: "SAR",
      timeZone: "Asia/Riyadh",
      externalStatus: "ACTIVE",
      selected: false,
    });

    const dump = JSON.stringify([
      await system.adConnection.findMany(),
      await system.adAccount.findMany(),
      await system.auditLog.findMany(),
      await system.adOAuthState.findMany(),
    ]);
    for (const secret of [REFRESH, ACCESS, EMAIL, "s".repeat(32)]) {
      expect(dump).not.toContain(secret);
    }
    // The discovery used the access token from the exchange (Bearer), not a URL.
    expect(calls.find((c) => c.path === "adsapi.snapchat.com/v1/me/organizations")?.auth).toBe(
      `Bearer ${ACCESS}`,
    );
    expect(
      (
        await system.auditLog.findMany({
          where: { workspaceId: owner.workspaceId },
          select: { action: true, metadata: true },
        })
      ).map((a) => a.action),
    ).toEqual(
      expect.arrayContaining(["ads.connect_started", "ads.connected", "ads.accounts_refreshed"]),
    );
  });

  it("accepts a state only at the callback of the platform it was started for", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const snap = fakeSnap();
    const deps = depsFor(snap.snapchat);
    const state = await begin(deps, owner);
    // The Snapchat state arriving at the Meta callback is refused (and burnt).
    expect(
      await completeConnection(deps, {
        platform: "META",
        sessionUserId: owner.userId,
        state,
        code: "auth-code",
        error: null,
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "oauth_invalid", slug: null });
    expect(
      await completeConnection(deps, {
        platform: "SNAPCHAT",
        sessionUserId: owner.userId,
        state,
        code: "auth-code",
        error: null,
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "oauth_invalid" });
    expect(snap.calls).toHaveLength(0);
    expect(await system.adConnection.count()).toBe(0);
  });

  it("re-checks the role at the callback and records a rejected code without storing", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const snap = fakeSnap();
    const deps = depsFor(snap.snapchat);
    const state = await begin(deps, owner);
    expect(
      await completeConnection(deps, {
        platform: "SNAPCHAT",
        sessionUserId: owner.userId,
        state,
        code: "stale-code",
        error: null,
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "oauth_invalid", slug: owner.slug });
    expect(await system.adConnection.count()).toBe(0);
    expect(await system.auditLog.count({ where: { action: "ads.connect_failed" } })).toBe(1);

    // A demoted person cannot complete a connection they started.
    const second = await begin(deps, owner);
    await system.workspaceMember.updateMany({
      where: { workspaceId: owner.workspaceId, userId: owner.userId },
      data: { role: WorkspaceRole.MANAGER },
    });
    expect(
      await completeConnection(deps, {
        platform: "SNAPCHAT",
        sessionUserId: owner.userId,
        state: second,
        code: "auth-code",
        error: null,
        redirectUri: REDIRECT,
      }),
    ).toMatchObject({ outcome: "forbidden" });
    expect(await system.adConnection.count()).toBe(0);
  });

  it("is not offered when the server is not configured, and only owners and admins connect", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    await expect(begin(depsFor(null), owner)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      fields: [{ code: "ads_not_configured" }],
    });
    const manager = { ...owner, role: WorkspaceRole.MANAGER };
    await expect(begin(depsFor(fakeSnap().snapchat), manager)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("the Snapchat callback route", () => {
  const call = (query: string) =>
    snapchatCallback(
      new Request(`http://localhost:3000/api/integrations/snapchat/callback?${query}`),
      { params: Promise.resolve({}) },
    );

  it("sends a visitor without a session to sign-in and leaks nothing", async () => {
    const response = await call("state=abcdefghijklmnopqrstuvwxyz&code=secret-code");
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/ar/sign-in");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers an unknown state with an outcome code only", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    session.user = { id: owner.userId };
    const response = await call("state=abcdefghijklmnopqrstuvwxyz&code=secret-code");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/ar/workspaces");
    expect(location.searchParams.get("connect")).toBe("oauth_invalid");
    expect(location.toString()).not.toContain("secret-code");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

// ── reading ──────────────────────────────────────────────────────────────────

describe("reading Snapchat ads", () => {
  it("mints a fresh access token per use and syncs read-only into the unified model", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account, calls } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    const before = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    calls.length = 0;
    await expect(syncAccount(deps, owner, account.id)).resolves.toEqual({ campaigns: 1 });

    // One refresh, then only GETs with that fresh token.
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "accounts.snapchat.com/login/oauth2/access_token",
    });
    const reads = calls.slice(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.method === "GET" && c.auth === `Bearer ${ACCESS}-1`)).toBe(true);

    const stored = await system.adAccount.findUniqueOrThrow({ where: { id: account.id } });
    const snapshot = readAccountSnapshot(stored.snapshot);
    expect(snapshot?.campaigns).toEqual([
      expect.objectContaining({
        externalId: "camp-1",
        objective: "TRAFFIC",
        status: "ACTIVE",
        dailyBudget: { minor: 5000, currency: "SAR" },
      }),
    ]);
    expect(snapshot?.metrics).toEqual([
      {
        campaignExternalId: "camp-1",
        impressions: 100_000,
        reach: null,
        clicks: 1_000,
        spend: { minor: 200_000, currency: "SAR" },
      },
    ]);
    expect(snapshot?.adSets[0]?.countries).toEqual(["SA"]);
    // The same refresh token came back: the stored one is untouched.
    const after = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    expect(after.tokenCiphertext).toBe(before.tokenCiphertext);
    expect(JSON.stringify([after, stored, await system.auditLog.findMany()])).not.toContain(ACCESS);
    expect(await system.auditLog.count({ where: { action: "ads.synced" } })).toBe(1);
  });

  it("stores a rotated refresh token, encrypted, in place of the old one", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { snapchat } = fakeSnap({ validRefresh: [REFRESH], rotateTo: "rotated-refresh-2" });
    const first = await connected(owner);
    const deps = depsFor(snapchat);
    await refreshAccounts(deps, owner, "SNAPCHAT");
    const connection = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    expect(connection.tokenCiphertext).not.toContain("rotated-refresh-2");
    expect(decryptToken(KEY, connection.tokenCiphertext ?? "", binding(owner))).toBe(
      "rotated-refresh-2",
    );
    expect(first.account.platform).toBe("SNAPCHAT");
  });

  it("marks a revoked refresh token as expired and stops calling the platform", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { account } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    const revoked = fakeSnap({ validRefresh: [] });
    const deps = depsFor(revoked.snapchat);
    await expect(syncAccount(deps, owner, account.id)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "ads_token_expired" }],
    });
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({ status: "EXPIRED", lastErrorCode: "token_expired" });
    revoked.calls.length = 0;
    await expect(syncAccount(deps, owner, account.id)).rejects.toMatchObject({
      fields: [{ code: "ads_token_expired" }],
    });
    expect(revoked.calls).toHaveLength(0);
    // The error recorded is a code, never the platform's message.
    expect(JSON.stringify(await system.auditLog.findMany())).not.toContain(REFRESH);
  });

  it("reports a missing permission on an ad account clearly", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { account } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    const denied = fakeSnap({ readStatus: 403 });
    await expect(syncAccount(depsFor(denied.snapchat), owner, account.id)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "ads_permission_missing" }],
    });
    expect(await system.adAccount.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
      syncErrorCode: "ads_permission_missing",
    });
    const limited = fakeSnap({ readStatus: 429 });
    await expect(syncAccount(depsFor(limited.snapchat), owner, account.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("keeps Snapchat credentials and accounts inside their workspace", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account } = await connected(a);
    await selectAccount(db, a, { accountId: account.id, selected: true });
    await expect(syncAccount(deps, b, account.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      selectAccount(db, b, { accountId: account.id, selected: false }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A's encrypted refresh token copied into B's row cannot be read there (bound to A).
    const source = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: a.workspaceId },
    });
    await system.adConnection.create({
      data: {
        workspaceId: b.workspaceId,
        platform: "SNAPCHAT",
        externalUserId: "x",
        tokenCiphertext: source.tokenCiphertext,
      },
    });
    const snap = fakeSnap();
    await expect(refreshAccounts(depsFor(snap.snapchat), b, "SNAPCHAT")).rejects.toMatchObject({
      fields: [{ code: "ads_not_connected" }],
    });
    expect(snap.calls).toHaveLength(0);
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: b.workspaceId } }),
    ).toMatchObject({ status: "ERROR", lastErrorCode: "token_unreadable" });
  });
});

// ── planning ─────────────────────────────────────────────────────────────────

describe("planning Snapchat campaigns", () => {
  it("reuses the shared planner and review; placement is automatic and launch stays off", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { deps, account, snapchat } = await connected(owner);
    await selectAccount(db, owner, { accountId: account.id, selected: true });
    await syncAccount(deps, owner, account.id);
    const { planId } = await createAdPlan(
      db,
      owner,
      ai,
      { accountId: account.id, budget: "1500", startDate: plusDays(1), endDate: plusDays(30) },
      "ar",
    );
    const plan = await system.adPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan).toMatchObject({
      platform: "SNAPCHAT",
      currency: "SAR",
      budgetTotalMinor: 150_000n,
    });
    // The fake AI proposed Facebook/Instagram placements: Snapchat keeps only AUTOMATIC.
    expect(plan.proposal).toMatchObject({ placements: ["AUTOMATIC"] });

    const review = await getAdPlanReview(db, owner, adapters(snapchat), planId);
    expect(review).toMatchObject({
      platform: "SNAPCHAT",
      launch: { available: false, reason: "blocked" },
      expected: { available: true },
    });
    expect(review.externalActions?.map((action) => action.endpoint)).toEqual([
      `/v1/adaccounts/${ACCOUNT}/campaigns`,
      "/v1/campaigns/{created campaign}/adsquads",
      `/v1/adaccounts/${ACCOUNT}/creatives`,
      "/v1/adsquads/{created ad squad}/ads",
    ]);
    expect(JSON.stringify(review.externalActions)).toContain('"lifetime_budget_micro":1500000000');

    const orchestration: OrchestrationDeps<AdLaunchServices> & { adapters: AdAdapters } = {
      db,
      adapters: adapters(snapchat),
      services: { ads: () => adapters(snapchat), tokenKey: () => KEY },
      workflows: { ad_launch: adLaunchWorkflow },
    };
    await expect(submitAdPlan(orchestration, owner, planId)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "ads_operation_unavailable" }],
    });
    expect(await system.agentRun.count()).toBe(0);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      status: "DRAFT",
    });
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

describe("Snapchat in the advertising views", () => {
  it("lists what works and labels launching as not available, in Arabic and English", () => {
    const platforms = [
      {
        platform: "SNAPCHAT" as const,
        available: true,
        reason: null,
        capabilities: fakeSnap().snapchat.capabilities,
        connection: {
          status: "ACTIVE" as const,
          externalUserName: "Snap Tester",
          scopes: ["snapchat-marketing-api"],
          tokenExpiresAt: null,
          lastErrorCode: null,
          updatedAt: new Date(),
          connectedByName: "Owner",
        },
      },
      {
        platform: "TIKTOK" as const,
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
      expect(html).toContain(messages.ads.platforms.SNAPCHAT.name);
      expect(html).toMatch(/data-capability="launchCampaign" data-available="false"/);
      expect(html).toMatch(/data-capability="readInsights" data-available="true"/);
      expect(html).toContain(messages.ads.capabilityOff);
      expect(html).toContain(messages.ads.platforms.TIKTOK.unavailable);
      // Logical (RTL-safe) layout only.
      expect(html).not.toMatch(/\b(?:ml|mr|pl|pr|text-left|text-right)-/);
    }
  });
});
