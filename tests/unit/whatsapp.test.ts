import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMetaAdapter } from "@/server/ads/adapters/meta";
import { createWhatsAppAdapter, maskPhoneNumber } from "@/server/ads/adapters/whatsapp";
import type { AdCampaignSpec } from "@/server/ads/model";
import { renderAdData } from "@/server/ads/planner-math";
import { parseAdsEnv } from "@/server/env-schema";
import { INVITATION_URL_PATTERN } from "@/server/redact";
import { parseWebhook, verifyChallenge, verifySignature } from "@/server/whatsapp/webhook";

// WhatsApp Business, pure parts: webhook signature and verification handshake, payload
// parsing without personal data, the Embedded Signup adapter against a deterministic Graph
// stand-in (GET only, no send path), Meta's click-to-WhatsApp description, env rules.

const APP_SECRET = "whatsapp-test-app-secret-0123456789";
const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const bytes = (text: string) => new TextEncoder().encode(text);

const CUSTOMER = "999500000001";
const MESSAGE_TEXT = "my order number is 123";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1000000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "2000000001" },
              statuses: [
                {
                  id: "wamid.status-1",
                  status: "delivered",
                  timestamp: "1791600000",
                  recipient_id: CUSTOMER,
                },
                {
                  id: "wamid.status-2",
                  status: "failed",
                  timestamp: "1791600001",
                  recipient_id: CUSTOMER,
                  errors: [{ code: 131026, title: "Message undeliverable" }],
                },
              ],
              messages: [
                {
                  from: CUSTOMER,
                  id: "wamid.inbound-1",
                  timestamp: "1791600002",
                  type: "text",
                  text: { body: MESSAGE_TEXT },
                },
              ],
              contacts: [{ wa_id: CUSTOMER, profile: { name: "Customer Name" } }],
            },
          },
          { field: "message_template_status_update", value: { event: "APPROVED" } },
        ],
      },
    ],
    ...overrides,
  };
}

describe("WhatsApp webhook signature and verification", () => {
  it("accepts only the exact HMAC-SHA256 of the raw body with the app secret", () => {
    const body = JSON.stringify(payload());
    expect(verifySignature(bytes(body), sign(body), APP_SECRET)).toBe(true);
    expect(
      verifySignature(
        bytes(body),
        sign(body).toUpperCase().replace("SHA256=", "sha256="),
        APP_SECRET,
      ),
    ).toBe(true);
    // Any change to the body, another secret, a missing or malformed header: refused.
    expect(verifySignature(bytes(`${body} `), sign(body), APP_SECRET)).toBe(false);
    expect(verifySignature(bytes(body), sign(body, "another-secret-xxxxxxxxxx"), APP_SECRET)).toBe(
      false,
    );
    expect(verifySignature(bytes(body), null, APP_SECRET)).toBe(false);
    expect(verifySignature(bytes(body), "sha1=abc", APP_SECRET)).toBe(false);
    expect(verifySignature(bytes(body), "sha256=", APP_SECRET)).toBe(false);
    expect(verifySignature(bytes(body), `sha256=${"0".repeat(64)}`, APP_SECRET)).toBe(false);
  });

  it("echoes the challenge only for subscribe with the configured verify token", () => {
    const token = "v".repeat(32);
    const params = (extra: Record<string, string>) =>
      new URLSearchParams({ "hub.mode": "subscribe", "hub.challenge": "1158201444", ...extra });
    expect(verifyChallenge(params({ "hub.verify_token": token }), token)).toBe("1158201444");
    expect(verifyChallenge(params({ "hub.verify_token": "wrong" }), token)).toBeNull();
    expect(
      verifyChallenge(params({ "hub.verify_token": token, "hub.mode": "unsubscribe" }), token),
    ).toBeNull();
    expect(verifyChallenge(params({ "hub.verify_token": token }), undefined)).toBeNull();
    // Only a plain challenge is echoed (nothing that could become markup).
    expect(
      verifyChallenge(params({ "hub.verify_token": token, "hub.challenge": "<script>" }), token),
    ).toBeNull();
  });
});

describe("WhatsApp webhook parsing", () => {
  it("keeps statuses and inbound-message facts, never numbers, ids or contents", () => {
    const events = parseWebhook(payload());
    expect(events?.map((e) => [e.kind, e.status, e.errorCode, e.phoneNumberId])).toEqual([
      ["status", "delivered", null, "2000000001"],
      ["status", "failed", 131026, "2000000001"],
      ["message", "received", null, "2000000001"],
    ]);
    expect(events?.[0]?.eventAt.toISOString()).toBe(new Date(1_791_600_000_000).toISOString());
    // Only three transient fields carry identifiers, for in-memory matching (a status to
    // Flexibx's own sent message, a sender to a contact's keyed hash); they are never stored.
    expect(
      events?.map((e) => [e.messageId?.startsWith("wamid") ?? null, e.from, e.keyword]),
    ).toEqual([
      [true, null, null],
      [true, null, null],
      [null, CUSTOMER, null],
    ]);
    const stored = JSON.stringify(
      events?.map(({ messageId: _id, from: _from, keyword: _keyword, ...rest }) => rest),
    );
    for (const secret of [CUSTOMER, MESSAGE_TEXT, "wamid", "Customer Name", "15550001111"]) {
      expect(stored).not.toContain(secret);
    }
    expect(JSON.stringify(events)).not.toContain(MESSAGE_TEXT);
    // The same event always hashes the same (so duplicates deduplicate), others differ.
    const again = parseWebhook(payload());
    expect(again?.map((e) => e.eventHash)).toEqual(events?.map((e) => e.eventHash));
    expect(new Set(events?.map((e) => e.eventHash)).size).toBe(3);
    expect(events?.every((e) => /^[0-9a-f]{64}$/.test(e.eventHash))).toBe(true);
  });

  it("refuses other objects and skips unreadable entries", () => {
    expect(parseWebhook(payload({ object: "page" }))).toBeNull();
    expect(parseWebhook({ object: "whatsapp_business_account" })).toBeNull();
    expect(parseWebhook("nope")).toBeNull();
    expect(
      parseWebhook({
        object: "whatsapp_business_account",
        entry: [
          { id: "bad id!", changes: [] },
          { id: "1", changes: [{ field: "messages", value: { metadata: {} } }] },
          {
            id: "2",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "3" },
                  statuses: [{ id: "x", status: "sent", timestamp: "not-a-time" }],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});

// ── the Embedded Signup adapter ──────────────────────────────────────────────

function fakeGraph(options: { scopes?: string[]; targets?: string[] } = {}) {
  const calls: { method: string; url: URL }[] = [];
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ method: init?.method ?? "GET", url });
    const path = url.pathname.replace(/^\/v\d+\.0/, "");
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (path === "/oauth/access_token") {
      return url.searchParams.get("code") === "es-code"
        ? json({ access_token: "business-token", token_type: "bearer" })
        : json({ error: { code: 100, message: "invalid code" } }, 400);
    }
    if (path === "/debug_token") {
      return json({
        data: {
          app_id: "1234567890",
          is_valid: true,
          expires_at: 0,
          user_id: "555000",
          scopes: options.scopes ?? ["whatsapp_business_management", "business_management"],
          granular_scopes: [
            {
              scope: "whatsapp_business_management",
              target_ids: options.targets ?? ["1000000001"],
            },
          ],
        },
      });
    }
    if (path === "/1000000001") {
      return json({
        id: "1000000001",
        name: "Acme WhatsApp",
        currency: "SAR",
        account_review_status: "APPROVED",
      });
    }
    if (path === "/1000000001/phone_numbers") {
      return json({
        data: [
          {
            id: "2000000001",
            display_phone_number: "+999 50 123 4567",
            verified_name: "Acme",
            quality_rating: "GREEN",
            code_verification_status: "VERIFIED",
            platform_type: "CLOUD_API",
          },
        ],
      });
    }
    if (path === "/1000000001/message_templates") {
      return json({
        data: [{ name: "order_update", language: "ar", category: "UTILITY", status: "APPROVED" }],
      });
    }
    return json({ error: { code: 100 } }, 400);
  };
  const adapter = createWhatsAppAdapter({
    appId: "1234567890",
    appSecret: APP_SECRET,
    configId: "987654321",
    version: "v26.0",
    fetch: fetchImpl,
  });
  return { adapter, calls };
}

describe("WhatsApp Embedded Signup adapter", () => {
  it("opens Facebook Login for Business with the configuration id and state", () => {
    const { adapter } = fakeGraph();
    const url = new URL(
      adapter.authorizeUrl({ state: "s".repeat(43), redirectUri: "https://app.test/cb" }),
    );
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1234567890",
      redirect_uri: "https://app.test/cb",
      state: "s".repeat(43),
      config_id: "987654321",
      response_type: "code",
      override_default_response_type: "true",
    });
    expect(url.toString()).not.toContain(APP_SECRET);
  });

  it("exchanges the code, finds the shared WABAs and reads them read-only", async () => {
    const { adapter, calls } = fakeGraph();
    const grant = await adapter.exchangeCode({
      code: "es-code",
      redirectUri: "https://app.test/cb",
    });
    expect(grant).toMatchObject({
      accessToken: "business-token",
      expiresAt: null,
      externalUser: { id: "555000" },
      grantedScopes: ["business_management", "whatsapp_business_management"],
    });
    expect(await adapter.listAccounts("business-token")).toEqual([
      {
        externalId: "1000000001",
        name: "Acme WhatsApp",
        currency: "SAR",
        timeZone: null,
        status: "ACTIVE",
      },
    ]);
    const read = await adapter.readBusiness("business-token", "1000000001");
    expect(read.phoneNumbers).toEqual([
      {
        id: "2000000001",
        maskedNumber: "•••• 4567",
        verifiedName: "Acme",
        qualityRating: "GREEN",
        verificationStatus: "VERIFIED",
        platformType: "CLOUD_API",
      },
    ]);
    expect(read.templates).toEqual([
      { name: "order_update", language: "ar", category: "UTILITY", status: "APPROVED" },
    ]);
    expect(JSON.stringify(read)).not.toContain("123 4567");
    // Read-only: every call is a GET, nothing reaches a messages endpoint.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url.pathname.includes("/messages"))).toBe(false);
    // Token calls carry appsecret_proof.
    const proofed = calls.filter(
      (call) => call.url.searchParams.get("access_token") === "business-token",
    );
    expect(proofed.length).toBeGreaterThan(0);
    expect(proofed.every((call) => call.url.searchParams.has("appsecret_proof"))).toBe(true);
  });

  it("has no campaigns or launches; sending is its own approved path", async () => {
    const { adapter } = fakeGraph();
    expect(adapter.capabilities).toEqual({
      connect: true,
      listAccounts: true,
      readCampaigns: false,
      readInsights: false,
      launchCampaign: false,
    });
    expect("launchCampaign" in adapter).toBe(false);
    expect(Object.keys(adapter).filter((key) => /send|message/i.test(key))).toEqual([
      "sendMessage",
    ]);
    await expect(
      adapter.readAccount("t", { externalId: "1", currency: "SAR" }, 30),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(adapter.describeLaunch({} as never)).toEqual([]);
  });

  it("refuses an unusable code as an OAuth failure, and masks numbers", async () => {
    const { adapter } = fakeGraph();
    await expect(
      adapter.exchangeCode({ code: "old", redirectUri: "https://x" }),
    ).rejects.toMatchObject({
      kind: "oauth_invalid",
    });
    expect(maskPhoneNumber("+1 555 000 1111")).toBe("•••• 1111");
    expect(maskPhoneNumber("12")).toBe("••••");
    expect(maskPhoneNumber(null)).toBe("••••");
  });
});

describe("WhatsApp as a conversion channel", () => {
  const spec: AdCampaignSpec = {
    objective: "MESSAGES",
    campaignName: "Chat with us",
    audience: {
      description: "d",
      countries: ["SA"],
      ageMin: 18,
      ageMax: 40,
      genders: "ALL",
      interests: [],
    },
    placements: ["AUTOMATIC"],
    creative: {
      headline: "Chat",
      primaryText: "Ask us on WhatsApp",
      callToAction: "SEND_MESSAGE",
      mediaAssetId: null,
    },
    rationale: "r",
  };
  const request = {
    planId: "p",
    accountExternalId: "111",
    currency: "SAR",
    budgetTotalMinor: 100_000,
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    spec,
    media: null,
  };
  const meta = createMetaAdapter({ appId: "1234567890", appSecret: APP_SECRET, version: "v26.0" });

  it("describes Meta MESSAGES ad sets as ads that click to WhatsApp (review only)", () => {
    const adSet = meta.describeLaunch(request)[1];
    expect(adSet?.params).toMatchObject({
      destination_type: "WHATSAPP",
      optimization_goal: "CONVERSATIONS",
      billing_event: "IMPRESSIONS",
      status: "PAUSED",
    });
    const traffic = meta.describeLaunch({ ...request, spec: { ...spec, objective: "TRAFFIC" } })[1];
    expect(traffic?.params).not.toHaveProperty("destination_type");
  });

  it("tells the planner WhatsApp is a destination, without numbers", () => {
    const base = {
      accountName: "Main",
      platform: "META",
      budget: { minor: 100_000, currency: "SAR" },
      days: 10,
      history: null,
      topCampaigns: [],
      assets: [],
    };
    expect(renderAdData({ ...base, language: "en", whatsapp: "Acme WhatsApp" })).toContain(
      "WhatsApp Business is connected (Acme WhatsApp)",
    );
    expect(renderAdData({ ...base, language: "ar", whatsapp: "Acme WhatsApp" })).toContain(
      "واتساب للأعمال مربوط",
    );
    expect(renderAdData({ ...base, language: "en", whatsapp: null })).not.toContain("WhatsApp");
  });
});

describe("WhatsApp configuration and logs", () => {
  it("needs the Meta app for Embedded Signup and a strong verify token", () => {
    expect(() => parseAdsEnv({ WHATSAPP_CONFIG_ID: "987654321" })).toThrow(/WHATSAPP_CONFIG_ID/);
    expect(
      parseAdsEnv({
        META_APP_ID: "1234567890",
        META_APP_SECRET: APP_SECRET,
        WHATSAPP_CONFIG_ID: "987654321",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "v".repeat(32),
      }),
    ).toMatchObject({ WHATSAPP_CONFIG_ID: "987654321" });
    expect(() => parseAdsEnv({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: "short" })).toThrow();
  });

  it("keeps webhook URLs (with the verify token) out of the request log", () => {
    expect(
      INVITATION_URL_PATTERN.test(
        "/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=1",
      ),
    ).toBe(true);
    expect(INVITATION_URL_PATTERN.test("/api/integrations/whatsapp/callback?code=x&state=y")).toBe(
      true,
    );
    expect(INVITATION_URL_PATTERN.test("/en/w/acme/integrations")).toBe(false);
  });
});
