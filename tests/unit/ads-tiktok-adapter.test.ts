import { describe, expect, it } from "vitest";

import { AdPlatformError } from "@/server/ads/adapter";
import {
  createTikTokAdapter,
  reportWindow,
  tiktokAges,
  tiktokDeliveryStatus,
  tiktokFailure,
  tiktokObjective,
} from "@/server/ads/adapters/tiktok";
import { accountSnapshotSchema, placementsFor, type AdCampaignSpec } from "@/server/ads/model";
import { parseAdsEnv } from "@/server/env-schema";

// The TikTok adapter against a deterministic stand-in for business-api.tiktok.com: the
// advertiser authorization URL, the JSON code exchange (secret only in the body), the
// Access-Token header on reads (never in a URL), the {code, data} envelope, page-numbered
// pagination, normalization into the unified model, and error mapping. No network.

const APP_ID = "7400000000000000001";
const SECRET = "tiktok-test-app-secret-0123456789";
const TOKEN = "tt-long-term-access-token";
const ADV = "7012345678901234567";

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

type Route = (call: Call) => { status?: number; body: unknown };

const ok = (data: unknown) => ({ body: { code: 0, message: "OK", request_id: "r", data } });

function fakeTikTok(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const route = routes[url.pathname.replace("/open_api/v1.3", "")];
    const answer =
      route === undefined
        ? { status: 404, body: { code: 40002, message: "not found", request_id: "r" } }
        : route(call);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const adapter = createTikTokAdapter({ appId: APP_ID, appSecret: SECRET, fetch: fetchImpl });
  return { adapter, calls };
}

const exchangeRoute: Route = (call) => {
  const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
  return body.auth_code === "good-code"
    ? ok({ access_token: TOKEN, advertiser_ids: [ADV, "7099999999999999999"], scope: [4, 5, 7] })
    : { body: { code: 40002, message: `bad code ${SECRET}`, request_id: "r" } };
};

describe("TikTok authorization", () => {
  it("builds the advertiser authorization URL with app_id, state and redirect_uri", () => {
    const { adapter } = fakeTikTok({});
    const url = new URL(
      adapter.authorizeUrl({ state: "s".repeat(43), redirectUri: "https://app.test/cb" }),
    );
    expect(url.origin).toBe("https://business-api.tiktok.com");
    expect(url.pathname).toBe("/portal/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_id: APP_ID,
      state: "s".repeat(43),
      redirect_uri: "https://app.test/cb",
    });
    expect(url.toString()).not.toContain(SECRET);
    // The URL copied from the app's dashboard can be used instead.
    const custom = createTikTokAdapter({
      appId: APP_ID,
      appSecret: SECRET,
      authorizeUrl: "https://business-api.tiktok.com/portal/auth?app_id=old&state=old",
    }).authorizeUrl({ state: "t".repeat(43), redirectUri: "https://app.test/cb" });
    expect(new URL(custom).searchParams.get("state")).toBe("t".repeat(43));
    expect(new URL(custom).searchParams.get("app_id")).toBe(APP_ID);
    expect(adapter.credential).toBe("access_token");
    expect(adapter.capabilities.launchCampaign).toBe(false);
    expect("launchCampaign" in adapter).toBe(false);
  });

  it("exchanges the auth code by JSON POST, secret in the body only, for a non-expiring token", async () => {
    const { adapter, calls } = fakeTikTok({ "/oauth2/access_token/": exchangeRoute });
    const grant = await adapter.exchangeCode({ code: "good-code", redirectUri: "https://x/cb" });
    expect(grant).toMatchObject({
      accessToken: TOKEN,
      expiresAt: null,
      grantedScopes: ["4", "5", "7"],
    });
    expect(grant.externalUser.id).toMatch(/^authorization-[0-9a-f]{24}$/);
    expect(grant.externalUser.name).toBeNull();
    // The same authorization is identified the same way.
    const again = await adapter.exchangeCode({ code: "good-code", redirectUri: "https://x/cb" });
    expect(again.externalUser.id).toBe(grant.externalUser.id);
    const [exchange] = calls;
    expect(exchange?.method).toBe("POST");
    expect(exchange?.url.toString()).toBe(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
    );
    expect(exchange?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(exchange?.body ?? "")).toEqual({
      app_id: APP_ID,
      secret: SECRET,
      auth_code: "good-code",
    });
    expect(exchange?.url.search).toBe("");
  });

  it("treats a rejected or empty exchange as an OAuth failure (never the platform's message)", async () => {
    const { adapter } = fakeTikTok({ "/oauth2/access_token/": exchangeRoute });
    const error = await adapter
      .exchangeCode({ code: "reused", redirectUri: "https://x/cb" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "oauth_invalid", platformCode: 40002 });
    expect((error as Error).message).not.toContain(SECRET);
    const empty = fakeTikTok({ "/oauth2/access_token/": () => ok({ advertiser_ids: [] }) });
    await expect(
      empty.adapter.exchangeCode({ code: "x", redirectUri: "https://x/cb" }),
    ).rejects.toMatchObject({ kind: "oauth_invalid" });
  });
});

function accountRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    "/oauth2/advertiser/get/": () =>
      ok({
        list: [
          { advertiser_id: ADV, advertiser_name: "TT SAR" },
          { advertiser_id: ADV, advertiser_name: "duplicate" },
          { advertiser_id: "bad id!", advertiser_name: "skipped" },
          { advertiser_id: 7088888888888888, advertiser_name: "numeric id (v1.2 style)" },
        ],
      }),
    "/advertiser/info/": () =>
      ok({
        list: [
          {
            advertiser_id: ADV,
            name: "TT SAR",
            currency: "SAR",
            timezone: "Etc/GMT-3",
            display_timezone: "Asia/Riyadh",
            status: "STATUS_ENABLE",
          },
          {
            advertiser_id: "7088888888888888",
            name: "TT USD",
            currency: "USD",
            timezone: "GMT+00:00",
            status: "STATUS_DISABLE",
          },
        ],
      }),
    "/campaign/get/": () =>
      ok({
        list: [
          {
            campaign_id: "1800000000000000001",
            campaign_name: "Ramadan",
            objective_type: "TRAFFIC",
            operation_status: "ENABLE",
            secondary_status: "CAMPAIGN_STATUS_ENABLE",
            budget_mode: "BUDGET_MODE_DAY",
            budget: 50.5,
          },
          {
            campaign_id: "1800000000000000002",
            campaign_name: "Old",
            objective_type: "REACH",
            operation_status: "DISABLE",
            secondary_status: "CAMPAIGN_STATUS_DISABLE",
            budget_mode: "BUDGET_MODE_INFINITE",
            budget: 0,
          },
        ],
        page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 1 },
      }),
    "/adgroup/get/": () =>
      ok({
        list: [
          {
            adgroup_id: "1810000000000000001",
            campaign_id: "1800000000000000001",
            adgroup_name: "Riyadh 18-34",
            operation_status: "ENABLE",
            secondary_status: "ADGROUP_STATUS_DELIVERY_OK",
            budget_mode: "BUDGET_MODE_TOTAL",
            budget: "3000.00",
            optimization_goal: "CLICK",
            location_ids: ["102358"],
            age_groups: ["AGE_25_34", "AGE_18_24"],
          },
        ],
        page_info: { page: 1, total_page: 1 },
      }),
    "/ad/get/": () =>
      ok({
        list: [
          {
            ad_id: "1820000000000000001",
            adgroup_id: "1810000000000000001",
            campaign_id: "1800000000000000001",
            ad_name: "Ad",
            operation_status: "ENABLE",
            secondary_status: "AD_STATUS_NOT_APPROVE",
          },
          {
            ad_id: "1820000000000000002",
            adgroup_id: "1810000000000000001",
            campaign_id: "1800000000000000001",
            ad_name: "Ad 2",
            operation_status: "ENABLE",
            secondary_status: "AD_STATUS_AUDIT",
          },
        ],
        page_info: { page: 1, total_page: 1 },
      }),
    "/report/integrated/get/": () =>
      ok({
        list: [
          {
            dimensions: { campaign_id: "1800000000000000001" },
            metrics: { spend: "2000.005", impressions: "100000", clicks: "1000", reach: "60000" },
          },
          { dimensions: { campaign_id: "1800000000000000002" }, metrics: { spend: "0" } },
        ],
        page_info: { page: 1, total_page: 1 },
      }),
    ...overrides,
  };
}

describe("TikTok reads", () => {
  it("discovers authorized ad accounts and their details", async () => {
    const { adapter, calls } = fakeTikTok(accountRoutes());
    expect(await adapter.listAccounts(TOKEN)).toEqual([
      {
        externalId: ADV,
        name: "TT SAR",
        currency: "SAR",
        timeZone: "Asia/Riyadh",
        status: "ACTIVE",
      },
      {
        externalId: "7088888888888888",
        name: "TT USD",
        currency: "USD",
        // An offset is not a time zone name: unknown.
        timeZone: null,
        status: "DISABLED",
      },
    ]);
    const [authorized, info] = calls;
    expect(authorized?.url.searchParams.get("app_id")).toBe(APP_ID);
    expect(JSON.parse(info?.url.searchParams.get("advertiser_ids") ?? "[]")).toEqual([
      ADV,
      "7088888888888888",
    ]);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.url.origin).toBe("https://business-api.tiktok.com");
      expect(call.headers.get("Access-Token")).toBe(TOKEN);
      expect(call.url.toString()).not.toContain(TOKEN);
    }
  });

  it("reads campaigns, ad groups, ads and campaign totals into the unified model", async () => {
    const { adapter, calls } = fakeTikTok(accountRoutes());
    const snapshot = await adapter.readAccount(
      TOKEN,
      { externalId: ADV, currency: "SAR", timeZone: "Asia/Riyadh" },
      30,
    );
    expect(accountSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.campaigns).toEqual([
      {
        externalId: "1800000000000000001",
        name: "Ramadan",
        objective: "TRAFFIC",
        status: "ACTIVE",
        dailyBudget: { minor: 5050, currency: "SAR" },
        lifetimeBudget: null,
        startAt: null,
        stopAt: null,
      },
      {
        externalId: "1800000000000000002",
        name: "Old",
        objective: "AWARENESS",
        status: "PAUSED",
        dailyBudget: null,
        lifetimeBudget: null,
        startAt: null,
        stopAt: null,
      },
    ]);
    expect(snapshot.adSets).toEqual([
      {
        externalId: "1810000000000000001",
        campaignExternalId: "1800000000000000001",
        name: "Riyadh 18-34",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: { minor: 300_000, currency: "SAR" },
        optimizationGoal: "CLICK",
        countries: [],
        ageMin: 18,
        ageMax: 34,
      },
    ]);
    expect(snapshot.ads.map((ad) => ad.status)).toEqual(["REJECTED", "IN_REVIEW"]);
    expect(snapshot.metrics).toEqual([
      {
        campaignExternalId: "1800000000000000001",
        impressions: 100_000,
        reach: 60_000,
        clicks: 1_000,
        // 2000.005 SAR → 2000.01 (half up), exact.
        spend: { minor: 200_001, currency: "SAR" },
      },
    ]);
    expect(snapshot.truncated).toBe(false);
    const report = calls.find((call) => call.url.pathname.endsWith("/report/integrated/get/"));
    expect(Object.fromEntries(report?.url.searchParams ?? [])).toMatchObject({
      advertiser_id: ADV,
      report_type: "BASIC",
      service_type: "AUCTION",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: '["campaign_id"]',
      metrics: '["spend","impressions","clicks","reach"]',
    });
    expect(
      calls.every((call) => call.method === "GET" && !call.url.toString().includes(TOKEN)),
    ).toBe(true);
  });

  it("pages with page/page_size, stops at total_page, and marks truncation after 3 pages", async () => {
    let served = 0;
    const endless: Route = (call) => {
      served += 1;
      const page = Number(call.url.searchParams.get("page"));
      return ok({
        list: [
          { campaign_id: `18000000000000000${String(page)}`, campaign_name: `p${String(page)}` },
        ],
        page_info: { page, page_size: 1000, total_page: 9 },
      });
    };
    const paged = fakeTikTok(accountRoutes({ "/campaign/get/": endless }));
    const snapshot = await paged.adapter.readAccount(
      TOKEN,
      { externalId: ADV, currency: "SAR" },
      30,
    );
    expect(served).toBe(3);
    expect(snapshot.campaigns.map((c) => c.name)).toEqual(["p1", "p2", "p3"]);
    expect(snapshot.truncated).toBe(true);
    const pages = paged.calls
      .filter((call) => call.url.pathname.endsWith("/campaign/get/"))
      .map((call) => [call.url.searchParams.get("page"), call.url.searchParams.get("page_size")]);
    expect(pages).toEqual([
      ["1", "1000"],
      ["2", "1000"],
      ["3", "1000"],
    ]);
    // Two pages exactly: both read, not truncated.
    const two = fakeTikTok(
      accountRoutes({
        "/campaign/get/": (call) => {
          const page = Number(call.url.searchParams.get("page"));
          return ok({
            list: [{ campaign_id: `1900000000000000${String(page)}` }],
            page_info: { page, total_page: 2 },
          });
        },
      }),
    );
    const result = await two.adapter.readAccount(TOKEN, { externalId: ADV, currency: "SAR" }, 30);
    expect(result.campaigns).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("maps API errors — including HTTP 200 with a non-zero code — without the message", async () => {
    for (const [answer, kind] of [
      [{ body: { code: 40100, message: "throttled", request_id: "r" } }, "rate_limited"],
      [{ body: { code: 40105, message: `token ${TOKEN}`, request_id: "r" } }, "token_expired"],
      [{ body: { code: 40001, message: "no permission", request_id: "r" } }, "permission_missing"],
      [{ status: 401, body: { code: 40104 } }, "token_expired"],
      [{ status: 500, body: { code: 50000 } }, "provider_error"],
      [{ status: 502, body: "<html>" }, "provider_error"],
    ] as const) {
      const { adapter } = fakeTikTok({ "/oauth2/advertiser/get/": () => answer });
      const error = await adapter.listAccounts(TOKEN).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdPlatformError);
      expect((error as AdPlatformError).kind).toBe(kind);
      expect((error as AdPlatformError).message).not.toContain(TOKEN);
    }
    expect(tiktokFailure(40100, 200).retryable).toBe(true);
    expect(tiktokFailure(null, 429).kind).toBe("rate_limited");
  });

  it("maps objectives, statuses and age groups", () => {
    expect(tiktokObjective("LEAD_GENERATION")).toBe("LEADS");
    expect(tiktokObjective("APP_PROMOTION")).toBe("APP_PROMOTION");
    expect(tiktokObjective("NEW_THING")).toBeNull();
    expect(tiktokDeliveryStatus("DISABLE", "CAMPAIGN_STATUS_DELETE")).toBe("DELETED");
    expect(tiktokDeliveryStatus("ENABLE", null)).toBe("ACTIVE");
    expect(tiktokDeliveryStatus("X", null)).toBe("OTHER");
    expect(tiktokAges(["AGE_55_100"])).toEqual({ min: 55, max: 65 });
    expect(tiktokAges([])).toEqual({ min: null, max: null });
  });

  it("reports the last full days in the account's time zone (today excluded)", () => {
    expect(reportWindow("Asia/Riyadh", 30, new Date("2026-10-09T22:30:00Z"))).toEqual({
      startDate: "2026-09-10",
      endDate: "2026-10-09",
    });
    expect(reportWindow(null, 7, new Date("2026-10-10T12:00:00Z"))).toEqual({
      startDate: "2026-10-03",
      endDate: "2026-10-09",
    });
  });
});

describe("TikTok launch description (review only)", () => {
  it("describes disabled objects with automatic placement; nothing can be sent", () => {
    const spec: AdCampaignSpec = {
      objective: "SALES",
      campaignName: "Autumn",
      audience: {
        description: "Shoppers",
        countries: ["SA"],
        ageMin: 18,
        ageMax: 34,
        genders: "MALE",
        interests: [],
      },
      placements: placementsFor("TIKTOK", ["INSTAGRAM_FEED"]),
      creative: {
        headline: "Sale",
        primaryText: "30% off",
        callToAction: "SHOP_NOW",
        mediaAssetId: null,
      },
      rationale: "r",
    };
    expect(spec.placements).toEqual(["AUTOMATIC"]);
    const { adapter } = fakeTikTok({});
    const actions = adapter.describeLaunch({
      planId: "p",
      accountExternalId: ADV,
      currency: "SAR",
      budgetTotalMinor: 150_050,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      spec,
      media: null,
    });
    expect(actions.map((a) => a.endpoint)).toEqual([
      "/open_api/v1.3/campaign/create/",
      "/open_api/v1.3/adgroup/create/",
      "/open_api/v1.3/ad/create/",
    ]);
    const text = JSON.stringify(actions);
    expect(text).toContain('"budget":1500.5');
    expect(text).toContain('"gender":"GENDER_MALE"');
    expect(text.match(/"operation_status":"DISABLE"/g)).toHaveLength(3);
    expect(text).not.toContain('"ENABLE"');
  });
});

describe("TikTok env", () => {
  it("is off by default and needs the app id and secret together", () => {
    expect(parseAdsEnv({})).toEqual({ META_GRAPH_VERSION: "v26.0" });
    expect(() => parseAdsEnv({ TIKTOK_APP_ID: APP_ID })).toThrow(/TIKTOK_APP_SECRET/);
    expect(parseAdsEnv({ TIKTOK_APP_ID: APP_ID, TIKTOK_APP_SECRET: SECRET })).toMatchObject({
      TIKTOK_APP_ID: APP_ID,
    });
    // The authorization URL must be TikTok's own, over https.
    expect(() =>
      parseAdsEnv({
        TIKTOK_APP_ID: APP_ID,
        TIKTOK_APP_SECRET: SECRET,
        TIKTOK_AUTHORIZE_URL: "https://evil.example/portal/auth",
      }),
    ).toThrow();
    expect(() =>
      parseAdsEnv({ TIKTOK_AUTHORIZE_URL: "http://business-api.tiktok.com/portal/auth" }),
    ).toThrow();
    expect(
      parseAdsEnv({ TIKTOK_AUTHORIZE_URL: "https://business-api.tiktok.com/portal/auth?app_id=1" }),
    ).toMatchObject({
      TIKTOK_AUTHORIZE_URL: "https://business-api.tiktok.com/portal/auth?app_id=1",
    });
  });
});
