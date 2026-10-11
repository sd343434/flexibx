import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AdPlatformError } from "@/server/ads/adapter";
import { createMetaAdapter, metaFailure } from "@/server/ads/adapters/meta";
import { accountSnapshotSchema } from "@/server/ads/model";

// The Meta adapter against a deterministic stand-in for graph.facebook.com: the official
// OAuth URLs and parameters, appsecret_proof on every token call, read-only requests,
// normalization into the unified model, and error mapping. No network is used.

const APP_SECRET = "test-app-secret-0123456789";
const TOKEN = "EAAB-test-long-lived-token";

interface Call {
  readonly method: string;
  readonly url: URL;
}

type Route = (url: URL) => { status?: number; body: unknown };

function fakeGraph(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ method: init?.method ?? "GET", url });
    const key = Object.keys(routes).find((path) => url.pathname.endsWith(path));
    const route = key === undefined ? undefined : routes[key];
    const answer =
      route === undefined ? { status: 404, body: { error: { code: 803 } } } : route(url);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const adapter = createMetaAdapter({
    appId: "1234567890",
    appSecret: APP_SECRET,
    version: "v26.0",
    fetch: fetchImpl,
  });
  return { adapter, calls };
}

const proof = (token: string) => createHmac("sha256", APP_SECRET).update(token).digest("hex");

describe("Meta OAuth", () => {
  it("builds the official login dialog URL with state and the read-only scope", () => {
    const { adapter } = fakeGraph({});
    const url = new URL(
      adapter.authorizeUrl({ state: "s".repeat(43), redirectUri: "https://app.test/cb" }),
    );
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v26.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1234567890",
      redirect_uri: "https://app.test/cb",
      state: "s".repeat(43),
      response_type: "code",
      scope: "ads_read",
    });
    expect(url.toString()).not.toContain(APP_SECRET);
  });

  it("names the Facebook Login for Business configuration instead of a scope when one is set", () => {
    for (const requestWriteAccess of [false, true]) {
      const adapter = createMetaAdapter({
        appId: "1234567890",
        appSecret: APP_SECRET,
        version: "v26.0",
        configId: "1402673982022294",
        requestWriteAccess,
      });
      const url = new URL(
        adapter.authorizeUrl({ state: "s".repeat(43), redirectUri: "https://app.test/cb" }),
      );
      expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
      // Meta: config_id has replaced scope, which should not be sent with it.
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: "1234567890",
        redirect_uri: "https://app.test/cb",
        state: "s".repeat(43),
        response_type: "code",
        config_id: "1402673982022294",
        override_default_response_type: "true",
      });
      expect(url.toString()).not.toContain(APP_SECRET);
    }
  });

  it("exchanges the code server-side for a long-lived token and reads granted permissions", async () => {
    const { adapter, calls } = fakeGraph({
      "/oauth/access_token": (url) =>
        url.searchParams.get("grant_type") === "fb_exchange_token"
          ? { body: { access_token: TOKEN, token_type: "bearer", expires_in: 5_183_944 } }
          : { body: { access_token: "short-token", token_type: "bearer", expires_in: 3600 } },
      "/me/permissions": () => ({
        body: {
          data: [
            { permission: "ads_read", status: "granted" },
            { permission: "business_management", status: "declined" },
          ],
        },
      }),
      "/me": () => ({ body: { id: "10001", name: "Test Advertiser" } }),
    });
    const grant = await adapter.exchangeCode({
      code: "auth-code",
      redirectUri: "https://app.test/cb",
    });
    expect(grant).toMatchObject({
      accessToken: TOKEN,
      externalUser: { id: "10001", name: "Test Advertiser" },
      grantedScopes: ["ads_read"],
    });
    expect(grant.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 59 * 24 * 3_600_000);
    // Every call goes to the Graph API host with GET; token calls carry appsecret_proof.
    expect(calls.every((call) => call.url.origin === "https://graph.facebook.com")).toBe(true);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    const exchange = calls[0]?.url.searchParams;
    expect(exchange?.get("code")).toBe("auth-code");
    expect(exchange?.get("redirect_uri")).toBe("https://app.test/cb");
    for (const call of calls.filter((c) => c.url.searchParams.has("access_token"))) {
      expect(call.url.searchParams.get("appsecret_proof")).toBe(
        proof(call.url.searchParams.get("access_token") ?? ""),
      );
    }
  });

  it("reports an unusable code as an OAuth failure, without echoing it", async () => {
    const { adapter } = fakeGraph({
      "/oauth/access_token": () => ({
        status: 400,
        body: { error: { code: 100, message: "Invalid verification code format: auth-code" } },
      }),
    });
    const error = await adapter
      .exchangeCode({ code: "auth-code", redirectUri: "https://app.test/cb" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdPlatformError);
    expect(error).toMatchObject({ kind: "oauth_invalid", platformCode: 100 });
    expect((error as Error).message).not.toContain("auth-code");
  });
});

describe("Meta error mapping", () => {
  it("maps Graph error codes to normalized failures", () => {
    expect(metaFailure(190, 400).kind).toBe("token_expired");
    expect(metaFailure(10, 400).kind).toBe("permission_missing");
    expect(metaFailure(200, 403).kind).toBe("permission_missing");
    expect(metaFailure(294, 403).kind).toBe("permission_missing");
    expect(metaFailure(17, 400).kind).toBe("rate_limited");
    expect(metaFailure(80004, 400).kind).toBe("rate_limited");
    expect(metaFailure(100, 400).kind).toBe("invalid_request");
    expect(metaFailure(null, 500).kind).toBe("provider_error");
    expect(metaFailure(17, 400).retryable).toBe(true);
    expect(metaFailure(190, 400).retryable).toBe(false);
  });
});

describe("Meta reads", () => {
  it("lists ad accounts across pages and normalizes them", async () => {
    let pages = 0;
    const { adapter, calls } = fakeGraph({
      "/me/adaccounts": (url) => {
        pages += 1;
        return url.searchParams.has("after")
          ? {
              body: {
                data: [
                  {
                    id: "act_222",
                    account_id: "222",
                    name: "Second",
                    currency: "USD",
                    account_status: 101,
                  },
                ],
                paging: { cursors: { after: "c2" } },
              },
            }
          : {
              body: {
                data: [
                  {
                    id: "act_111",
                    account_id: "111",
                    name: "Main",
                    currency: "SAR",
                    timezone_name: "Asia/Riyadh",
                    account_status: 1,
                  },
                  { id: "act_x", account_id: "../bad", name: "Bad", currency: "SAR" },
                  { id: "act_333", account_id: "333", name: "No currency" },
                ],
                paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/next" },
              },
            };
      },
    });
    expect(await adapter.listAccounts(TOKEN)).toEqual([
      {
        externalId: "111",
        name: "Main",
        currency: "SAR",
        timeZone: "Asia/Riyadh",
        status: "ACTIVE",
      },
      { externalId: "222", name: "Second", currency: "USD", timeZone: null, status: "CLOSED" },
    ]);
    expect(pages).toBe(2);
    expect(calls[1]?.url.searchParams.get("after")).toBe("c1");
    expect(calls[0]?.url.searchParams.get("appsecret_proof")).toBe(proof(TOKEN));
  });

  it("reads campaigns, ad sets, ads and insights into a valid unified snapshot (GET only)", async () => {
    const { adapter, calls } = fakeGraph({
      "/act_111/campaigns": () => ({
        body: {
          data: [
            {
              id: "c1",
              name: "Ramadan traffic",
              objective: "OUTCOME_TRAFFIC",
              effective_status: "ACTIVE",
              daily_budget: "5000",
            },
            {
              id: "c2",
              name: "Old",
              objective: "LINK_CLICKS",
              effective_status: "CAMPAIGN_PAUSED",
            },
          ],
        },
      }),
      "/act_111/adsets": () => ({
        body: {
          data: [
            {
              id: "s1",
              campaign_id: "c1",
              name: "KSA 25-44",
              effective_status: "ACTIVE",
              lifetime_budget: "150000",
              optimization_goal: "LINK_CLICKS",
              targeting: { age_min: 25, age_max: 44, geo_locations: { countries: ["SA", "xx"] } },
            },
          ],
        },
      }),
      "/act_111/ads": () => ({
        body: {
          data: [
            {
              id: "a1",
              adset_id: "s1",
              campaign_id: "c1",
              name: "Ad",
              effective_status: "DISAPPROVED",
            },
          ],
        },
      }),
      "/act_111/insights": () => ({
        body: {
          data: [
            {
              campaign_id: "c1",
              impressions: "12000",
              reach: "9000",
              clicks: "240",
              spend: "345.67",
            },
          ],
        },
      }),
    });
    const snapshot = await adapter.readAccount(TOKEN, { externalId: "111", currency: "SAR" }, 30);
    expect(accountSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.campaigns).toEqual([
      {
        externalId: "c1",
        name: "Ramadan traffic",
        objective: "TRAFFIC",
        status: "ACTIVE",
        dailyBudget: { minor: 5000, currency: "SAR" },
        lifetimeBudget: null,
        startAt: null,
        stopAt: null,
      },
      expect.objectContaining({ externalId: "c2", objective: "TRAFFIC", status: "PAUSED" }),
    ]);
    expect(snapshot.adSets[0]).toMatchObject({
      countries: ["SA"],
      ageMin: 25,
      ageMax: 44,
      lifetimeBudget: { minor: 150_000, currency: "SAR" },
    });
    expect(snapshot.ads[0]).toMatchObject({ status: "REJECTED" });
    expect(snapshot.metrics).toEqual([
      {
        campaignExternalId: "c1",
        impressions: 12_000,
        reach: 9000,
        clicks: 240,
        spend: { minor: 34_567, currency: "SAR" },
      },
    ]);
    expect(snapshot.truncated).toBe(false);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(
      calls.find((c) => c.url.pathname.endsWith("/insights"))?.url.searchParams.get("date_preset"),
    ).toBe("last_30d");
  });

  it("surfaces an expired token as token_expired, with no token in the error", async () => {
    const { adapter } = fakeGraph({
      "/act_111/campaigns": () => ({
        status: 400,
        body: { error: { code: 190, message: `bad ${TOKEN}` } },
      }),
      "/act_111/adsets": () => ({ body: { data: [] } }),
      "/act_111/ads": () => ({ body: { data: [] } }),
      "/act_111/insights": () => ({ body: { data: [] } }),
    });
    const error = await adapter
      .readAccount(TOKEN, { externalId: "111", currency: "SAR" }, 30)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "token_expired", platformCode: 190 });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe("Meta launch boundary", () => {
  const request = {
    planId: "00000000-0000-4000-8000-000000000001",
    accountExternalId: "111",
    currency: "SAR",
    budgetTotalMinor: 150_000,
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    media: null,
    spec: {
      objective: "TRAFFIC" as const,
      campaignName: "November traffic",
      audience: {
        description: "Young professionals in Riyadh",
        countries: ["SA"],
        ageMin: 25,
        ageMax: 44,
        genders: "FEMALE" as const,
        interests: ["coffee"],
      },
      placements: ["FACEBOOK_FEED" as const, "FACEBOOK_STORIES" as const],
      creative: {
        headline: "Fresh every morning",
        primaryText: "قهوة مختصة في الرياض",
        callToAction: "LEARN_MORE" as const,
        mediaAssetId: null,
      },
      rationale: "Fits the goal.",
    },
  };

  it("describes the exact calls in creation order, everything paused", () => {
    const { adapter } = fakeGraph({});
    const actions = adapter.describeLaunch(request);
    expect(actions.map((a) => `${a.method} ${a.endpoint}`)).toEqual([
      "POST /act_111/campaigns",
      "POST /act_111/adsets",
      "POST /act_111/adcreatives",
      "POST /act_111/ads",
    ]);
    expect(actions[0]?.params).toMatchObject({ objective: "OUTCOME_TRAFFIC", status: "PAUSED" });
    expect(actions[1]?.params).not.toHaveProperty("currency"); // account-level on Meta
    expect(actions[1]?.params).toMatchObject({
      lifetime_budget: 150_000,
      billing_event: "IMPRESSIONS",
      optimization_goal: "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      status: "PAUSED",
      targeting: {
        geo_locations: { countries: ["SA"] },
        age_min: 25,
        age_max: 44,
        genders: [2],
        // Always explicit: Meta's defaults would include Instagram.
        publisher_platforms: ["facebook"],
        facebook_positions: ["feed", "story"],
      },
    });
    expect(actions[3]?.params).toMatchObject({ status: "PAUSED" });
    // Deterministic: the same request describes the same calls.
    expect(adapter.describeLaunch(request)).toEqual(actions);
    // Creation goes through the shared executor (adapter.writer), never a one-shot launch.
    expect(adapter.capabilities.launchCampaign).toBe(true);
    expect("launchCampaign" in adapter).toBe(false);
    expect(adapter.writer?.ready).toBe(true);
  });
});
