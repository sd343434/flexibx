import { createHmac, randomBytes } from "node:crypto";

import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformCards } from "@/app/[locale]/w/[workspaceSlug]/ads/ads-views";
import { WhatsAppAccounts } from "@/app/[locale]/w/[workspaceSlug]/integrations/whatsapp-views";
import {
  GET as webhookGet,
  POST as webhookPost,
} from "@/app/api/integrations/whatsapp/webhook/route";
import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters, AdPlatformAdapter, OAuthGrant } from "@/server/ads/adapter";
import { createWhatsAppAdapter, type WhatsAppAdapter } from "@/server/ads/adapters/whatsapp";
import {
  ACCESS_LOST,
  completeConnection,
  disconnect,
  refreshAccounts,
  selectAccount,
  startConnection,
  withPlatformToken,
  type AdsDeps,
} from "@/server/ads/connections";
import { getIntegrationsOverview } from "@/server/ads/integrations";
import type { UnifiedAdAccount } from "@/server/ads/model";
import { createAdPlan } from "@/server/ads/planner";
import { decryptToken } from "@/server/ads/token-vault";
import { createFakeProvider } from "@/server/ai/fake-provider";
import type { TenantContext } from "@/server/tenancy/context";
import { getWhatsAppAccounts, syncWhatsAppAccount } from "@/server/whatsapp/whatsapp-service";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTenant, createTestDb, resetDatabase } from "./helpers";

// The multi-tenant integration architecture on the real database. Flexibx owns one app per
// platform; every workspace connects its own accounts. Covered here: independent
// connections per workspace, tokens readable only by their own workspace and platform,
// the connection lifecycle (connect, narrowed re-authorization, reconnect, disconnect),
// authorization of every step, the Integrations overview (no secrets), and WhatsApp
// Business (Embedded Signup, read-only sync, verified webhooks; sending is covered in
// whatsapp-sending.test.ts). All platforms are deterministic stand-ins: nothing reaches a real service.

vi.mock("next/server", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, after: () => undefined };
});

const APP_SECRET = "integration-meta-app-secret-000000";
const VERIFY_TOKEN = "integration-verify-token-0123456789";
vi.mock("@/server/env", async (importOriginal) => {
  const actual: Record<string, unknown> & { getAdsEnv: () => Record<string, unknown> } =
    await importOriginal();
  return {
    ...actual,
    getAdsEnv: () => ({
      ...actual.getAdsEnv(),
      META_APP_SECRET: "integration-meta-app-secret-000000",
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: "integration-verify-token-0123456789",
    }),
  };
});

const { system, db } = createTestDb();
const KEY = randomBytes(32).toString("base64");
const REDIRECT = "https://app.test/api/integrations/x/callback";
const ai = { provider: createFakeProvider(), timeoutMs: 5_000 };

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── a controllable ad platform (stands in for any of Meta / Snapchat / TikTok) ──

function testPlatform() {
  const state = {
    accounts: [
      { externalId: "acc-1", name: "One", currency: "SAR", timeZone: null, status: "ACTIVE" },
      { externalId: "acc-2", name: "Two", currency: "SAR", timeZone: null, status: "ACTIVE" },
    ] as UnifiedAdAccount[],
    issued: 0,
    calls: [] as string[],
  };
  const adapter: AdPlatformAdapter = {
    platform: "META",
    capabilities: {
      connect: true,
      listAccounts: true,
      readCampaigns: true,
      readInsights: true,
      launchCampaign: false,
    },
    requiredScopes: ["ads_read"],
    authorizeUrl: ({ state: s }) => `https://www.facebook.com/v26.0/dialog/oauth?state=${s}`,
    exchangeCode: (): Promise<OAuthGrant> => {
      state.issued += 1;
      return Promise.resolve({
        accessToken: `token-${String(state.issued)}-${randomBytes(4).toString("hex")}`,
        expiresAt: null,
        externalUser: { id: "u1", name: "Platform User" },
        grantedScopes: ["ads_read"],
      });
    },
    listAccounts: (token) => {
      state.calls.push(token);
      return Promise.resolve(state.accounts);
    },
    readAccount: () => Promise.reject(new Error("not used")),
    describeLaunch: () => [],
  };
  return { adapter, state };
}

function adapters(
  meta: AdPlatformAdapter | null,
  whatsapp: AdPlatformAdapter | null = null,
): AdAdapters {
  return {
    META:
      meta === null
        ? { platform: "META", available: false, reason: "not_configured" }
        : { platform: "META", available: true, adapter: meta },
    SNAPCHAT: { platform: "SNAPCHAT", available: false, reason: "not_configured" },
    TIKTOK: { platform: "TIKTOK", available: false, reason: "not_configured" },
    WHATSAPP:
      whatsapp === null
        ? { platform: "WHATSAPP", available: false, reason: "not_configured" }
        : { platform: "WHATSAPP", available: true, adapter: whatsapp },
  };
}

const depsFor = (meta: AdPlatformAdapter | null, whatsapp: AdPlatformAdapter | null = null) => ({
  db,
  system,
  adapters: adapters(meta, whatsapp),
  tokenKey: KEY,
});

async function connect(
  deps: AdsDeps & { system: typeof system },
  ctx: TenantContext,
  platform: "META" | "WHATSAPP" = "META",
  code = "auth-code",
) {
  const { url } = await startConnection(deps, ctx, {
    platform,
    locale: "en",
    redirectUri: REDIRECT,
  });
  const state = new URL(url).searchParams.get("state") ?? "";
  return completeConnection(deps, {
    platform,
    sessionUserId: ctx.userId,
    state,
    code,
    error: null,
    redirectUri: REDIRECT,
  });
}

const tokenOf = async (ctx: TenantContext, platform: "META" | "WHATSAPP") => {
  const row = await system.adConnection.findFirstOrThrow({
    where: { workspaceId: ctx.workspaceId, platform },
  });
  return decryptToken(KEY, row.tokenCiphertext ?? "", { workspaceId: ctx.workspaceId, platform });
};

// ── independent connections ──────────────────────────────────────────────────

describe("independent workspace connections", () => {
  it("lets two workspaces connect the same platform with separate, non-transferable tokens", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { adapter, state } = testPlatform();
    const deps = depsFor(adapter);
    expect((await connect(deps, a)).outcome).toBe("connected");
    expect((await connect(deps, b)).outcome).toBe("connected");
    const [tokenA, tokenB] = [await tokenOf(a, "META"), await tokenOf(b, "META")];
    expect(tokenA).not.toBe(tokenB);

    // Each workspace's token is used only for that workspace.
    state.calls.length = 0;
    await withPlatformToken(deps, a.workspaceId, "META", (token) => {
      expect(token).toBe(tokenA);
      return Promise.resolve();
    });
    // A ciphertext moved to another workspace (or platform) cannot be decrypted there.
    const rowA = await system.adConnection.findFirstOrThrow({
      where: { workspaceId: a.workspaceId },
    });
    expect(() =>
      decryptToken(KEY, rowA.tokenCiphertext ?? "", {
        workspaceId: b.workspaceId,
        platform: "META",
      }),
    ).toThrow();
    expect(() =>
      decryptToken(KEY, rowA.tokenCiphertext ?? "", {
        workspaceId: a.workspaceId,
        platform: "WHATSAPP",
      }),
    ).toThrow();

    // Accounts with the same external ids are separate rows per workspace.
    const rows = await system.adAccount.findMany({ where: { externalId: "acc-1" } });
    expect(new Set(rows.map((row) => row.workspaceId))).toEqual(
      new Set([a.workspaceId, b.workspaceId]),
    );
    // One workspace cannot see, select or refresh the other's.
    const foreign = rows.find((row) => row.workspaceId === a.workspaceId);
    await expect(
      selectAccount(db, b, { accountId: foreign?.id ?? "", selected: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never authorizes spending or publishing by connecting", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { adapter } = testPlatform();
    await connect(depsFor(adapter), owner);
    expect(
      await system.adAccount.count({ where: { workspaceId: owner.workspaceId, selected: true } }),
    ).toBe(0);
    expect(await system.agentRun.count()).toBe(0);
    expect(await system.agentTaskApproval.count()).toBe(0);
    expect(await system.adPlan.count()).toBe(0);
  });

  it("disconnecting one workspace leaves every other workspace untouched", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { adapter } = testPlatform();
    const deps = depsFor(adapter);
    await connect(deps, a);
    await connect(deps, b);
    for (const ctx of [a, b]) {
      const account = await system.adAccount.findFirstOrThrow({
        where: { workspaceId: ctx.workspaceId, externalId: "acc-1" },
      });
      await selectAccount(db, ctx, { accountId: account.id, selected: true });
    }
    const tokenB = await tokenOf(b, "META");

    await disconnect(db, a, "META");
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: a.workspaceId } }),
    ).toMatchObject({
      status: "REVOKED",
      tokenCiphertext: null,
    });
    expect(
      await system.adAccount.count({ where: { workspaceId: a.workspaceId, selected: true } }),
    ).toBe(0);
    await expect(
      withPlatformToken(deps, a.workspaceId, "META", () => Promise.resolve()),
    ).rejects.toMatchObject({
      fields: [{ code: "ads_not_connected" }],
    });
    // B: still active, same token, same selection.
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: b.workspaceId } }),
    ).toMatchObject({ status: "ACTIVE" });
    expect(await tokenOf(b, "META")).toBe(tokenB);
    expect(
      await system.adAccount.count({ where: { workspaceId: b.workspaceId, selected: true } }),
    ).toBe(1);
    // Disconnecting twice, or a workspace with nothing connected, is refused cleanly.
    await expect(disconnect(db, a, "META")).rejects.toMatchObject({
      fields: [{ code: "ads_not_connected" }],
    });
    const audit = await system.auditLog.findMany({ where: { action: "ads.disconnected" } });
    expect(audit.map((row) => row.workspaceId)).toEqual([a.workspaceId]);

    // A can reconnect on its own; B is unaffected again.
    expect((await connect(deps, a)).outcome).toBe("connected");
    expect(await tokenOf(b, "META")).toBe(tokenB);
  });

  it("handles narrowed re-authorization: lost accounts are deselected and cannot be selected", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { adapter, state } = testPlatform();
    const deps = depsFor(adapter);
    await connect(deps, owner);
    const two = await system.adAccount.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId, externalId: "acc-2" },
    });
    await selectAccount(db, owner, { accountId: two.id, selected: true });

    // The person reconnects and shares only acc-1.
    state.accounts = state.accounts.filter((account) => account.externalId === "acc-1");
    expect((await connect(deps, owner)).outcome).toBe("connected");
    expect(await system.adAccount.findUniqueOrThrow({ where: { id: two.id } })).toMatchObject({
      selected: false,
      syncErrorCode: ACCESS_LOST,
    });
    await expect(
      selectAccount(db, owner, { accountId: two.id, selected: true }),
    ).rejects.toMatchObject({
      fields: [{ code: "ads_account_unavailable" }],
    });
    const overview = await getIntegrationsOverview(db, owner, adapters(adapter));
    expect(overview.platforms.find((row) => row.platform === "META")?.accounts).toEqual({
      total: 2,
      selected: 0,
      accessLost: 1,
    });

    // Access granted back: usable again.
    state.accounts = [
      ...state.accounts,
      { externalId: "acc-2", name: "Two", currency: "SAR", timeZone: null, status: "ACTIVE" },
    ];
    await refreshAccounts(deps, owner, "META");
    expect(
      (await system.adAccount.findUniqueOrThrow({ where: { id: two.id } })).syncErrorCode,
    ).toBeNull();
    await selectAccount(db, owner, { accountId: two.id, selected: true });
  });

  it("refuses to select accounts of an expired or revoked connection", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { adapter } = testPlatform();
    await connect(depsFor(adapter), owner);
    const account = await system.adAccount.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    await system.adConnection.updateMany({
      where: { workspaceId: owner.workspaceId },
      data: { status: "EXPIRED" },
    });
    await expect(
      selectAccount(db, owner, { accountId: account.id, selected: true }),
    ).rejects.toMatchObject({
      fields: [{ code: "ads_account_unavailable" }],
    });
    // Deselecting is always allowed.
    await selectAccount(db, owner, { accountId: account.id, selected: false });
  });

  it("lets only owners and admins connect, select or disconnect; others may view", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { adapter } = testPlatform();
    const deps = depsFor(adapter);
    await connect(deps, owner);
    const account = await system.adAccount.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    for (const role of [
      WorkspaceRole.MANAGER,
      WorkspaceRole.EDITOR,
      WorkspaceRole.VIEWER,
      WorkspaceRole.CLIENT,
    ]) {
      const ctx = { ...owner, role };
      await expect(connect(deps, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        selectAccount(db, ctx, { accountId: account.id, selected: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(disconnect(db, ctx, "META")).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const manager = await getIntegrationsOverview(
      db,
      { ...owner, role: WorkspaceRole.MANAGER },
      adapters(adapter),
    );
    expect(manager.canManage).toBe(false);
    await expect(
      getIntegrationsOverview(db, { ...owner, role: WorkspaceRole.EDITOR }, adapters(adapter)),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const admin = await getIntegrationsOverview(
      db,
      { ...owner, role: WorkspaceRole.ADMIN },
      adapters(adapter),
    );
    expect(admin.canManage).toBe(true);
  });

  it("shows each workspace only its own connections, with no secrets", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { adapter } = testPlatform();
    await connect(depsFor(adapter), a);
    const tokenA = await tokenOf(a, "META");
    const forA = await getIntegrationsOverview(db, a, adapters(adapter));
    const forB = await getIntegrationsOverview(db, b, adapters(adapter));
    expect(forA.platforms.find((row) => row.platform === "META")).toMatchObject({
      available: true,
      connection: { status: "ACTIVE", externalUserName: "Platform User", scopes: ["ads_read"] },
      accounts: { total: 2, selected: 0, accessLost: 0 },
    });
    expect(forB.platforms.find((row) => row.platform === "META")).toMatchObject({
      connection: null,
      accounts: { total: 0 },
    });
    expect(forA.platforms.map((row) => [row.platform, row.available, row.reason])).toEqual([
      ["META", true, null],
      ["SNAPCHAT", false, "not_configured"],
      ["TIKTOK", false, "not_configured"],
      ["WHATSAPP", false, "not_configured"],
    ]);
    const text = JSON.stringify(forA);
    expect(text).not.toContain(tokenA);
    expect(text).not.toMatch(/v1\.[A-Za-z0-9_-]+\./);
    expect(text).not.toContain("ciphertext");
  });
});

// ── WhatsApp Business ────────────────────────────────────────────────────────

const WABA = "1000000001";

function whatsappGraph(options: { failCode?: number } = {}) {
  const calls: { method: string; path: string }[] = [];
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/v\d+\.0/, "");
    calls.push({ method: init?.method ?? "GET", path });
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (path === "/oauth/access_token")
      return json({ access_token: `wa-token-${randomBytes(4).toString("hex")}` });
    if (path === "/debug_token") {
      return json({
        data: {
          is_valid: true,
          expires_at: 0,
          user_id: "777",
          scopes: ["whatsapp_business_management"],
          granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }],
        },
      });
    }
    if (options.failCode !== undefined) return json({ error: { code: options.failCode } }, 403);
    if (path === `/${WABA}`)
      return json({ id: WABA, name: "Acme WhatsApp", account_review_status: "APPROVED" });
    if (path === `/${WABA}/phone_numbers`) {
      return json({
        data: [
          {
            id: "2000000001",
            display_phone_number: "+999 50 123 4567",
            verified_name: "Acme",
            quality_rating: "YELLOW",
          },
        ],
      });
    }
    if (path === `/${WABA}/message_templates`) {
      return json({
        data: [{ name: "welcome", language: "ar", category: "MARKETING", status: "APPROVED" }],
      });
    }
    return json({ error: { code: 100 } }, 400);
  };
  const whatsapp = createWhatsAppAdapter({
    appId: "1234567890",
    appSecret: APP_SECRET,
    configId: "987654321",
    version: "v26.0",
    fetch: fetchImpl,
  });
  return { whatsapp, calls };
}

async function connectedWhatsApp(ctx: TenantContext, whatsapp: WhatsAppAdapter, select = true) {
  const deps = { ...depsFor(null, whatsapp), whatsapp };
  expect((await connect(deps, ctx, "WHATSAPP")).outcome).toBe("connected");
  const account = await system.adAccount.findFirstOrThrow({
    where: { workspaceId: ctx.workspaceId, platform: "WHATSAPP" },
  });
  if (select) await selectAccount(db, ctx, { accountId: account.id, selected: true });
  return { deps, account };
}

describe("WhatsApp Business connection and reads", () => {
  it("connects through Embedded Signup, stores the business token encrypted and reads read-only", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { whatsapp, calls } = whatsappGraph();
    const { deps, account } = await connectedWhatsApp(owner, whatsapp);
    expect(account).toMatchObject({
      platform: "WHATSAPP",
      externalId: WABA,
      name: "Acme WhatsApp",
      currency: "XXX",
    });
    expect(
      await system.adConnection.findFirstOrThrow({ where: { workspaceId: owner.workspaceId } }),
    ).toMatchObject({
      platform: "WHATSAPP",
      status: "ACTIVE",
      scopes: ["whatsapp_business_management"],
      tokenExpiresAt: null,
    });

    await expect(syncWhatsAppAccount(deps, owner, account.id)).resolves.toEqual({
      phoneNumbers: 1,
      templates: 1,
    });
    const [view] = await getWhatsAppAccounts(db, owner);
    expect(view?.snapshot?.phoneNumbers[0]).toMatchObject({
      maskedNumber: "•••• 4567",
      verifiedName: "Acme",
      qualityRating: "YELLOW",
    });
    expect(view?.snapshot?.templates).toEqual([
      { name: "welcome", language: "ar", category: "MARKETING", status: "APPROVED" },
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/messages"))).toBe(false);

    // The full business number never reaches the database.
    const dump = JSON.stringify([
      await system.whatsAppSnapshot.findMany(),
      await system.auditLog.findMany(),
      await system.adConnection.findMany(),
    ]);
    expect(dump).not.toContain("123 4567");
    expect(dump).not.toContain("1234567");
    expect(dump).not.toContain(await tokenOf(owner, "WHATSAPP"));
    expect(await system.auditLog.count({ where: { action: "whatsapp.synced" } })).toBe(1);
  });

  it("reports a missing WhatsApp permission and keeps WhatsApp out of ad planning", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { account } = await connectedWhatsApp(owner, whatsappGraph().whatsapp);
    const denied = whatsappGraph({ failCode: 200 }).whatsapp;
    await expect(
      syncWhatsAppAccount({ ...depsFor(null, denied), whatsapp: denied }, owner, account.id),
    ).rejects.toMatchObject({ fields: [{ code: "ads_permission_missing" }] });
    expect(await system.auditLog.count({ where: { action: "whatsapp.sync_failed" } })).toBe(1);
    await expect(
      createAdPlan(
        db,
        owner,
        ai,
        { accountId: account.id, budget: "100", startDate: "2099-01-01", endDate: "2099-01-05" },
        "en",
      ),
    ).rejects.toMatchObject({ fields: [{ code: "ads_operation_unavailable" }] });
    expect(await system.adPlan.count()).toBe(0);
  });

  it("isolates WhatsApp accounts and reads per workspace", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { whatsapp } = whatsappGraph();
    const { deps, account } = await connectedWhatsApp(a, whatsapp);
    await expect(syncWhatsAppAccount(deps, b, account.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await getWhatsAppAccounts(db, b)).toEqual([]);
    const viewer = { ...a, role: WorkspaceRole.EDITOR };
    await expect(getWhatsAppAccounts(db, viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(syncWhatsAppAccount(deps, viewer, account.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

// ── the webhook ──────────────────────────────────────────────────────────────

const sign = (body: string) =>
  `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;

function notification(messageId: string, status: string, seconds = Math.floor(Date.now() / 1000)) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "2000000001", display_phone_number: "999501234567" },
              statuses: [
                { id: messageId, status, timestamp: String(seconds), recipient_id: "999500000009" },
              ],
              messages: [
                {
                  id: `${messageId}-in`,
                  from: "999500000009",
                  timestamp: String(seconds),
                  type: "text",
                  text: { body: "private text" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

const post = (body: string, signature: string | null = sign(body)) =>
  webhookPost(
    new Request("http://localhost:3000/api/integrations/whatsapp/webhook", {
      method: "POST",
      body,
      headers: signature === null ? {} : { "x-hub-signature-256": signature },
    }),
  );

describe("the WhatsApp webhook", () => {
  it("completes Meta's verification only with the configured token", async () => {
    const ok = webhookGet(
      new Request(
        `http://localhost:3000/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=424242`,
      ),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("424242");
    const bad = webhookGet(
      new Request(
        "http://localhost:3000/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=424242",
      ),
    );
    expect(bad.status).toBe(403);
  });

  it("refuses unsigned, tampered and malformed notifications before reading them", async () => {
    const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
    await connectedWhatsApp(owner, whatsappGraph().whatsapp);
    const body = notification("wamid.1", "delivered");
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, sign(`${body}x`))).status).toBe(401);
    expect((await post(`${body}x`, sign(body))).status).toBe(401);
    expect((await post("not json", sign("not json"))).status).toBe(400);
    const other = JSON.stringify({ object: "page", entry: [] });
    expect((await post(other, sign(other))).status).toBe(400);
    expect(await system.whatsAppWebhookEvent.count()).toBe(0);
  });

  it("records each event once, ignores replays and unknown accounts, and stores no personal data", async () => {
    const a = await createTenant(system, { role: WorkspaceRole.OWNER });
    const b = await createTenant(system, { role: WorkspaceRole.OWNER });
    const c = await createTenant(system, { role: WorkspaceRole.OWNER });
    const { whatsapp } = whatsappGraph();
    await connectedWhatsApp(a, whatsapp);
    await connectedWhatsApp(b, whatsapp);
    // C connected the same WABA but did not select it: it receives nothing.
    await connectedWhatsApp(c, whatsapp, false);

    const body = notification("wamid.abc", "delivered");
    expect((await post(body)).status).toBe(200);
    // Meta's retry (and an attacker's replay) of the same signed payload: no new rows.
    expect((await post(body)).status).toBe(200);
    const rows = await system.whatsAppWebhookEvent.findMany();
    expect(rows).toHaveLength(4); // one status + one inbound message, for A and for B
    expect(new Set(rows.map((row) => row.workspaceId))).toEqual(
      new Set([a.workspaceId, b.workspaceId]),
    );
    expect(rows.map((row) => row.status).sort()).toEqual([
      "delivered",
      "delivered",
      "received",
      "received",
    ]);

    // Older than Meta's 7-day retry window: ignored.
    const old = notification("wamid.old", "read", Math.floor(Date.now() / 1000) - 8 * 86_400);
    expect((await post(old)).status).toBe(200);
    // An account nobody connected: ignored.
    const unknown = notification("wamid.u", "read").replace(WABA, "9999999999");
    expect((await post(unknown)).status).toBe(200);
    expect(await system.whatsAppWebhookEvent.count()).toBe(4);

    const dump = JSON.stringify(await system.whatsAppWebhookEvent.findMany());
    for (const secret of ["999500000009", "private text", "wamid", "999501234567"])
      expect(dump).not.toContain(secret);

    // Counts per workspace, by status.
    const [view] = await getWhatsAppAccounts(db, a);
    expect(view?.statusCounts).toEqual({ delivered: 1, received: 1 });
    expect((await getWhatsAppAccounts(db, c))[0]?.statusCounts).toEqual({});

    // After A disconnects, A stops receiving; B continues.
    await disconnect(db, a, "WHATSAPP");
    expect((await post(notification("wamid.after", "read"))).status).toBe(200);
    expect(await system.whatsAppWebhookEvent.count({ where: { workspaceId: a.workspaceId } })).toBe(
      2,
    );
    expect(await system.whatsAppWebhookEvent.count({ where: { workspaceId: b.workspaceId } })).toBe(
      4,
    );
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

describe("the Integrations views", () => {
  it("show WhatsApp honestly in Arabic and English, with no send action", () => {
    const platforms = [
      {
        platform: "WHATSAPP" as const,
        available: true,
        reason: null,
        capabilities: {
          connect: true,
          listAccounts: true,
          readCampaigns: false,
          readInsights: false,
          launchCampaign: false,
        },
        connection: {
          status: "ACTIVE" as const,
          externalUserName: null,
          scopes: ["whatsapp_business_management"],
          tokenExpiresAt: null,
          lastErrorCode: null,
          connectedByName: "Owner",
        },
        accounts: { total: 2, selected: 1, accessLost: 1 },
      },
    ];
    const accounts = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Acme WhatsApp",
        externalId: WABA,
        status: "ACTIVE",
        selected: true,
        usable: true,
        lastSyncedAt: new Date(),
        syncErrorCode: null,
        snapshot: {
          phoneNumbers: [
            {
              id: "2000000001",
              maskedNumber: "•••• 4567",
              verifiedName: "Acme",
              qualityRating: "GREEN" as const,
              verificationStatus: null,
              platformType: null,
            },
          ],
          templates: [
            { name: "welcome", language: "ar", category: "MARKETING", status: "APPROVED" },
          ],
        },
        statusCounts: { delivered: 3, read: 2 },
      },
    ];
    for (const locale of ["ar", "en"] as const) {
      const messages = locale === "ar" ? ar : en;
      const cards = render(
        locale,
        createElement(PlatformCards, {
          slug: "acme",
          locale,
          timeZone: "Asia/Riyadh",
          platforms,
          canManage: true,
        }),
      );
      expect(cards).toContain(messages.ads.platforms.WHATSAPP.name);
      expect(cards).toMatch(/data-capability="whatsappSend" data-available="false"/);
      expect(cards).toMatch(/data-capability="whatsappRead" data-available="true"/);
      expect(cards).toContain('data-testid="ads-access-lost"');
      expect(cards).toContain("Owner");
      const list = render(
        locale,
        createElement(WhatsAppAccounts, {
          slug: "acme",
          locale,
          timeZone: "Asia/Riyadh",
          accounts,
          canManage: true,
          canPlan: true,
        }),
      );
      expect(list).toContain("•••• 4567");
      expect(list).toContain(messages.integrations.whatsapp.statusLabels.delivered);
      expect(list).toMatch(/data-status="delivered"[^>]*><dt[^>]*>[^<]+<\/dt><dd[^>]*>3</);
      expect(list).not.toMatch(/send|إرسال/i);
      // RTL-safe: logical spacing only, numbers isolated left-to-right.
      expect(list).not.toMatch(/\b(?:ml|mr|pl|pr|text-left|text-right)-/);
      expect(list).toContain('<bdi dir="ltr" class="tabular-nums">•••• 4567</bdi>');
    }
  });
});
