import { describe, expect, it } from "vitest";

import { AdPlatformError } from "@/server/ads/adapter";
import {
  createSnapchatAdapter,
  snapchatFailure,
  snapchatObjective,
  statsWindow,
  zonedMidnight,
} from "@/server/ads/adapters/snapchat";
import {
  accountSnapshotSchema,
  microToMinor,
  minorToMicro,
  placementsFor,
  readCampaignSpec,
  type AdCampaignSpec,
} from "@/server/ads/model";
import { parseAdsEnv } from "@/server/env-schema";

// The Snapchat adapter against a deterministic stand-in for accounts.snapchat.com and
// adsapi.snapchat.com: the official OAuth URLs and parameters (secret only in POST
// bodies), refresh-token handling, read-only requests with a Bearer header, paging that
// never leaves Snap's API host, normalization into the unified model and error mapping.
// No network is used.

const CLIENT_ID = "1a2b3c4d-snap-client";
const CLIENT_SECRET = "snap-test-client-secret-0123456789";
const ACCESS = "snap-access-token-xyz";
const REFRESH = "snap-refresh-token-abc";
const ACCOUNT = "0b2b6e4c-1111-4c4c-9a9a-aaaaaaaaaaaa";

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

type Route = (call: Call) => { status?: number; body: unknown };

function fakeSnap(routes: Record<string, Route>) {
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
    const key = Object.keys(routes).find((path) => `${url.origin}${url.pathname}`.endsWith(path));
    const route = key === undefined ? undefined : routes[key];
    const answer =
      route === undefined
        ? { status: 404, body: { request_status: "ERROR", debug_message: "not found" } }
        : route(call);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const adapter = createSnapchatAdapter({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetch: fetchImpl,
  });
  return { adapter, calls };
}

const tokenRoute: Route = (call) => {
  const form = new URLSearchParams(call.body ?? "");
  if (form.get("grant_type") === "authorization_code") {
    return form.get("code") === "good-code"
      ? {
          body: {
            access_token: ACCESS,
            refresh_token: REFRESH,
            expires_in: 3600,
            token_type: "Bearer",
            scope: "snapchat-marketing-api",
          },
        }
      : { status: 400, body: { error: "invalid_grant" } };
  }
  if (form.get("grant_type") === "refresh_token") {
    return form.get("refresh_token") === REFRESH
      ? { body: { access_token: "fresh-access", refresh_token: REFRESH, expires_in: 3600 } }
      : { status: 400, body: { error: "invalid_grant" } };
  }
  return { status: 400, body: { error: "unsupported_grant_type" } };
};

const meRoute: Route = () => ({
  body: {
    request_status: "SUCCESS",
    me: {
      id: "c4b0f3e2-2222-4d4d-8b8b-bbbbbbbbbbbb",
      display_name: "Snap Tester",
      email: "private@example.test",
      organization_id: "org-1",
    },
  },
});

describe("Snapchat OAuth", () => {
  it("builds the official authorize URL with state and the marketing scope", () => {
    const { adapter } = fakeSnap({});
    const url = new URL(
      adapter.authorizeUrl({ state: "s".repeat(43), redirectUri: "https://app.test/cb" }),
    );
    expect(url.origin).toBe("https://accounts.snapchat.com");
    expect(url.pathname).toBe("/login/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: "https://app.test/cb",
      scope: "snapchat-marketing-api",
      state: "s".repeat(43),
    });
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    expect(adapter.credential).toBe("refresh_token");
    expect(adapter.capabilities.launchCampaign).toBe(false);
    expect("launchCampaign" in adapter).toBe(false);
  });

  it("exchanges the code by form POST (secret in the body only) and keeps no email", async () => {
    const { adapter, calls } = fakeSnap({
      "/login/oauth2/access_token": tokenRoute,
      "/v1/me": meRoute,
    });
    const grant = await adapter.exchangeCode({
      code: "good-code",
      redirectUri: "https://app.test/cb",
    });
    expect(grant).toMatchObject({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      externalUser: { id: "c4b0f3e2-2222-4d4d-8b8b-bbbbbbbbbbbb", name: "Snap Tester" },
      grantedScopes: ["snapchat-marketing-api"],
    });
    expect(JSON.stringify(grant)).not.toContain("private@example.test");
    const [exchange, me] = calls;
    expect(exchange?.method).toBe("POST");
    expect(exchange?.url.toString()).toBe(
      "https://accounts.snapchat.com/login/oauth2/access_token",
    );
    expect(exchange?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(exchange?.body ?? ""))).toEqual({
      grant_type: "authorization_code",
      code: "good-code",
      redirect_uri: "https://app.test/cb",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    // No secret or token ever in a URL; the API gets a Bearer header.
    for (const call of calls) {
      expect(call.url.toString()).not.toContain(CLIENT_SECRET);
      expect(call.url.toString()).not.toContain(ACCESS);
    }
    expect(me?.url.toString()).toBe("https://adsapi.snapchat.com/v1/me");
    expect(me?.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
  });

  it("treats a rejected code, or a grant without a refresh token, as an OAuth failure", async () => {
    const { adapter } = fakeSnap({ "/login/oauth2/access_token": tokenRoute, "/v1/me": meRoute });
    await expect(
      adapter.exchangeCode({ code: "reused", redirectUri: "https://app.test/cb" }),
    ).rejects.toMatchObject({ kind: "oauth_invalid" });
    const noRefresh = fakeSnap({
      "/login/oauth2/access_token": () => ({ body: { access_token: ACCESS, expires_in: 3600 } }),
      "/v1/me": meRoute,
    });
    await expect(
      noRefresh.adapter.exchangeCode({ code: "x", redirectUri: "https://app.test/cb" }),
    ).rejects.toMatchObject({ kind: "oauth_invalid" });
  });

  it("mints access tokens from the refresh token; a revoked one is an expired connection", async () => {
    const { adapter, calls } = fakeSnap({ "/login/oauth2/access_token": tokenRoute });
    // The same refresh token back is not a rotation.
    await expect(adapter.refreshAccessToken?.(REFRESH)).resolves.toEqual({
      accessToken: "fresh-access",
      refreshToken: null,
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body ?? ""))).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    await expect(adapter.refreshAccessToken?.("revoked")).rejects.toMatchObject({
      kind: "token_expired",
    });
    const rotating = fakeSnap({
      "/login/oauth2/access_token": () => ({
        body: { access_token: "a2", refresh_token: "rotated-refresh" },
      }),
    });
    await expect(rotating.adapter.refreshAccessToken?.(REFRESH)).resolves.toEqual({
      accessToken: "a2",
      refreshToken: "rotated-refresh",
    });
  });
});

function adAccountRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    "/v1/me/organizations": () => ({
      body: {
        request_status: "SUCCESS",
        organizations: [
          {
            sub_request_status: "SUCCESS",
            organization: {
              id: "org-1",
              name: "Org",
              ad_accounts: [
                {
                  id: ACCOUNT,
                  name: "Snap SAR",
                  currency: "SAR",
                  timezone: "Asia/Riyadh",
                  status: "ACTIVE",
                },
                { id: "bad id!", name: "x", currency: "SAR", status: "ACTIVE" },
                { id: "acc-2", name: "No currency", status: "ACTIVE" },
              ],
            },
          },
          {
            sub_request_status: "SUCCESS",
            organization: {
              id: "org-2",
              ad_accounts: [
                { id: ACCOUNT, name: "Duplicate", currency: "SAR", status: "ACTIVE" },
                { id: "acc-3", name: "KWD", currency: "KWD", status: "DISABLED" },
              ],
            },
          },
        ],
      },
    }),
    [`/v1/adaccounts/${ACCOUNT}/campaigns`]: () => ({
      body: {
        request_status: "SUCCESS",
        campaigns: [
          {
            sub_request_status: "SUCCESS",
            campaign: {
              id: "camp-1",
              name: "Ramadan",
              status: "ACTIVE",
              objective_v2_properties: { objective_v2_type: "SALES" },
              daily_budget_micro: 50_000_000,
              start_time: "2026-09-01T00:00:00.000Z",
            },
          },
          {
            sub_request_status: "SUCCESS",
            campaign: {
              id: "camp-2",
              name: "Legacy",
              status: "PAUSED",
              objective: "BRAND_AWARENESS",
              lifetime_spend_cap_micro: 1_234_567_890,
            },
          },
          { sub_request_status: "ERROR", campaign: { id: "camp-3", name: "skipped" } },
        ],
      },
    }),
    [`/v1/adaccounts/${ACCOUNT}/adsquads`]: () => ({
      body: {
        request_status: "SUCCESS",
        adsquads: [
          {
            sub_request_status: "SUCCESS",
            adsquad: {
              id: "sq-1",
              campaign_id: "camp-1",
              name: "Saudi 18-35",
              status: "ACTIVE",
              lifetime_budget_micro: 3_000_000_000,
              optimization_goal: "SWIPES",
              targeting: {
                geos: [{ country_code: "sa" }, { country_code: "ae" }, { country_code: "sa" }],
                demographics: [{ min_age: "18", max_age: "35" }],
              },
            },
          },
        ],
      },
    }),
    [`/v1/adaccounts/${ACCOUNT}/ads`]: () => ({
      body: {
        request_status: "SUCCESS",
        ads: [
          {
            sub_request_status: "SUCCESS",
            ad: {
              id: "ad-1",
              ad_squad_id: "sq-1",
              name: "Ad",
              status: "ACTIVE",
              review_status: "PENDING",
            },
          },
          {
            sub_request_status: "SUCCESS",
            ad: {
              id: "ad-2",
              ad_squad_id: "sq-1",
              name: "No",
              status: "ACTIVE",
              review_status: "REJECTED",
            },
          },
          // An ad squad that was not read (cut by paging) cannot be placed: skipped.
          { sub_request_status: "SUCCESS", ad: { id: "ad-3", ad_squad_id: "sq-x", name: "?" } },
        ],
      },
    }),
    [`/v1/adaccounts/${ACCOUNT}/stats`]: () => ({
      body: {
        request_status: "SUCCESS",
        total_stats: [
          {
            sub_request_status: "SUCCESS",
            total_stat: {
              id: ACCOUNT,
              type: "AD_ACCOUNT",
              granularity: "TOTAL",
              breakdown_stats: {
                campaign: [
                  {
                    id: "camp-1",
                    type: "CAMPAIGN",
                    stats: { impressions: 120_000, swipes: 1_500, spend: 1_234_567_890 },
                  },
                  {
                    id: "camp-2",
                    type: "CAMPAIGN",
                    stats: { impressions: 0, swipes: 0, spend: 0 },
                  },
                ],
              },
            },
          },
        ],
      },
    }),
    ...overrides,
  };
}

describe("Snapchat reads", () => {
  it("discovers ad accounts across organizations (deduplicated, invalid ones skipped)", async () => {
    const { adapter, calls } = fakeSnap(adAccountRoutes());
    const accounts = await adapter.listAccounts(ACCESS);
    expect(accounts).toEqual([
      {
        externalId: ACCOUNT,
        name: "Snap SAR",
        currency: "SAR",
        timeZone: "Asia/Riyadh",
        status: "ACTIVE",
      },
      { externalId: "acc-3", name: "KWD", currency: "KWD", timeZone: null, status: "DISABLED" },
    ]);
    expect(calls[0]?.url.searchParams.get("with_ad_accounts")).toBe("true");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reads campaigns, ad squads, ads and campaign totals into the unified model", async () => {
    const { adapter, calls } = fakeSnap(adAccountRoutes());
    const snapshot = await adapter.readAccount(
      ACCESS,
      { externalId: ACCOUNT, currency: "SAR", timeZone: "Asia/Riyadh" },
      30,
    );
    expect(accountSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.campaigns).toEqual([
      {
        externalId: "camp-1",
        name: "Ramadan",
        objective: "SALES",
        status: "ACTIVE",
        dailyBudget: { minor: 5000, currency: "SAR" },
        lifetimeBudget: null,
        startAt: "2026-09-01T00:00:00.000Z",
        stopAt: null,
      },
      {
        externalId: "camp-2",
        name: "Legacy",
        objective: "AWARENESS",
        status: "PAUSED",
        dailyBudget: null,
        // 1,234.567890 SAR → 1234.57 (half up).
        lifetimeBudget: { minor: 123_457, currency: "SAR" },
        startAt: null,
        stopAt: null,
      },
    ]);
    expect(snapshot.adSets).toEqual([
      {
        externalId: "sq-1",
        campaignExternalId: "camp-1",
        name: "Saudi 18-35",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: { minor: 300_000, currency: "SAR" },
        optimizationGoal: "SWIPES",
        countries: ["SA", "AE"],
        ageMin: 18,
        ageMax: 35,
      },
    ]);
    expect(snapshot.ads.map((ad) => [ad.externalId, ad.campaignExternalId, ad.status])).toEqual([
      ["ad-1", "camp-1", "IN_REVIEW"],
      ["ad-2", "camp-1", "REJECTED"],
    ]);
    expect(snapshot.metrics).toEqual([
      {
        campaignExternalId: "camp-1",
        impressions: 120_000,
        reach: null,
        clicks: 1_500,
        spend: { minor: 123_457, currency: "SAR" },
      },
      {
        campaignExternalId: "camp-2",
        impressions: 0,
        reach: null,
        clicks: 0,
        spend: { minor: 0, currency: "SAR" },
      },
    ]);
    expect(snapshot.range.days).toBe(30);
    expect(snapshot.truncated).toBe(false);
    // Read-only, Bearer-authorized, the token never in a URL.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
      expect(call.url.toString()).not.toContain(ACCESS);
    }
    const stats = calls.find((call) => call.url.pathname.endsWith("/stats"));
    expect(Object.fromEntries(stats?.url.searchParams ?? [])).toMatchObject({
      granularity: "TOTAL",
      breakdown: "campaign",
      fields: "impressions,swipes,spend",
    });
    expect(stats?.url.searchParams.get("start_time")).toMatch(/T00:00:00\.000\+03:00$/);
    expect(stats?.url.searchParams.get("end_time")).toMatch(/T00:00:00\.000\+03:00$/);
  });

  it("follows next_link only on adsapi.snapchat.com, at most three pages", async () => {
    const page =
      (next: string | null, id: string): Route =>
      () => ({
        body: {
          request_status: "SUCCESS",
          campaigns: [
            { sub_request_status: "SUCCESS", campaign: { id, name: id, status: "ACTIVE" } },
          ],
          paging: next === null ? {} : { next_link: next },
        },
      });
    let served = 0;
    const endless: Route = (call) => {
      served += 1;
      return page(
        `https://adsapi.snapchat.com/v1/adaccounts/${ACCOUNT}/campaigns?cursor=${String(served)}`,
        `c${String(served)}`,
      )(call);
    };
    const paged = fakeSnap(adAccountRoutes({ [`/v1/adaccounts/${ACCOUNT}/campaigns`]: endless }));
    const snapshot = await paged.adapter.readAccount(
      ACCESS,
      { externalId: ACCOUNT, currency: "SAR" },
      30,
    );
    expect(snapshot.campaigns.map((c) => c.externalId)).toEqual(["c1", "c2", "c3"]);
    expect(snapshot.truncated).toBe(true);

    // A next_link to another host is never followed (the token would go with it).
    const hostile = fakeSnap(
      adAccountRoutes({
        [`/v1/adaccounts/${ACCOUNT}/campaigns`]: page("https://evil.example/v1/steal", "c1"),
      }),
    );
    await hostile.adapter.readAccount(ACCESS, { externalId: ACCOUNT, currency: "SAR" }, 30);
    expect(hostile.calls.some((call) => call.url.hostname !== "adsapi.snapchat.com")).toBe(false);
  });

  it("maps HTTP failures to normalized errors without the platform's message", async () => {
    for (const [status, kind] of [
      [401, "token_expired"],
      [403, "permission_missing"],
      [429, "rate_limited"],
      [400, "invalid_request"],
      [503, "provider_error"],
    ] as const) {
      const { adapter } = fakeSnap({
        "/v1/me/organizations": () => ({
          status,
          body: { request_status: "ERROR", debug_message: `leak ${ACCESS}` },
        }),
      });
      const error = await adapter.listAccounts(ACCESS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdPlatformError);
      expect((error as AdPlatformError).kind).toBe(kind);
      expect((error as AdPlatformError).message).not.toContain(ACCESS);
    }
    expect(snapchatFailure(400, "invalid_grant").kind).toBe("token_expired");
    // A 200 with an ERROR request status is not success.
    const { adapter } = fakeSnap({
      "/v1/me/organizations": () => ({ body: { request_status: "ERROR" } }),
    });
    await expect(adapter.listAccounts(ACCESS)).rejects.toMatchObject({ kind: "provider_error" });
  });

  it("maps current and legacy objectives", () => {
    expect(snapchatObjective({ objective_v2_properties: { objective_v2_type: "TRAFFIC" } })).toBe(
      "TRAFFIC",
    );
    expect(snapchatObjective({ objective: "APP_INSTALLS" })).toBe("APP_PROMOTION");
    expect(snapchatObjective({ objective: "LEAD_GENERATION" })).toBe("LEADS");
    expect(snapchatObjective({ objective: "SOMETHING_NEW" })).toBeNull();
  });
});

describe("Snapchat time and money", () => {
  it("converts micro-currency exactly per currency", () => {
    expect(microToMinor(1_234_567_890, "SAR")).toBe(123_457);
    expect(microToMinor(1_234_564_999, "SAR")).toBe(123_456);
    expect(microToMinor(1_500_000_000, "JPY")).toBe(1500);
    expect(microToMinor(1_234_500, "KWD")).toBe(1235);
    expect(microToMinor(-1, "SAR")).toBeNull();
    expect(minorToMicro(150_000, "SAR")).toBe(1_500_000_000);
    expect(minorToMicro(1500, "JPY")).toBe(1_500_000_000);
  });

  it("anchors the stats window to midnight in the account's time zone", () => {
    expect(zonedMidnight("2026-10-01", "Asia/Riyadh")).toBe("2026-10-01T00:00:00.000+03:00");
    expect(zonedMidnight("2026-07-01", "America/Los_Angeles")).toBe(
      "2026-07-01T00:00:00.000-07:00",
    );
    expect(zonedMidnight("2026-12-01", "America/Los_Angeles")).toBe(
      "2026-12-01T00:00:00.000-08:00",
    );
    expect(zonedMidnight("2026-10-01", null)).toBe("2026-10-01T00:00:00.000+00:00");
    expect(zonedMidnight("2026-10-01", "Not/AZone")).toBe("2026-10-01T00:00:00.000+00:00");
    // 22:30 UTC on 9 Oct is already 10 Oct in Riyadh: the window ends at its midnight.
    expect(statsWindow("Asia/Riyadh", 30, new Date("2026-10-09T22:30:00Z"))).toEqual({
      start: "2026-09-10T00:00:00.000+03:00",
      end: "2026-10-10T00:00:00.000+03:00",
    });
  });
});

describe("Snapchat launch description", () => {
  const spec: AdCampaignSpec = {
    objective: "TRAFFIC",
    campaignName: "Autumn",
    audience: {
      description: "Shoppers",
      countries: ["SA", "AE"],
      ageMin: 18,
      ageMax: 34,
      genders: "FEMALE",
      interests: ["fashion"],
    },
    placements: placementsFor("SNAPCHAT", ["INSTAGRAM_FEED", "FACEBOOK_FEED"]),
    creative: {
      headline: "Autumn sale",
      primaryText: "Up to 30% off",
      callToAction: "SHOP_NOW",
      mediaAssetId: null,
    },
    rationale: "r",
  };

  it("only allows automatic placement and describes paused objects with micro budgets", () => {
    expect(spec.placements).toEqual(["AUTOMATIC"]);
    expect(readCampaignSpec(spec)).not.toBeNull();
    expect(placementsFor("META", ["INSTAGRAM_FEED", "INSTAGRAM_FEED"])).toEqual(["INSTAGRAM_FEED"]);
    const { adapter } = fakeSnap({});
    const actions = adapter.describeLaunch({
      planId: "p",
      accountExternalId: ACCOUNT,
      currency: "SAR",
      budgetTotalMinor: 150_000,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      spec,
      media: null,
    });
    expect(actions.map((a) => a.endpoint)).toEqual([
      `/v1/adaccounts/${ACCOUNT}/campaigns`,
      "/v1/campaigns/{created campaign}/adsquads",
      `/v1/adaccounts/${ACCOUNT}/creatives`,
      "/v1/adsquads/{created ad squad}/ads",
    ]);
    const text = JSON.stringify(actions);
    expect(text).toContain('"lifetime_budget_micro":1500000000');
    expect(text).toContain('"country_code":"sa"');
    expect(text).toContain('"gender":"FEMALE"');
    expect(text).not.toContain('"ACTIVE"');
    expect(text.match(/"status":"PAUSED"/g)).toHaveLength(3);
  });
});

describe("Snapchat env", () => {
  it("is off by default and needs the client id and secret together", () => {
    expect(parseAdsEnv({})).toEqual({ META_GRAPH_VERSION: "v26.0" });
    expect(() => parseAdsEnv({ SNAPCHAT_CLIENT_ID: CLIENT_ID })).toThrow(/SNAPCHAT_CLIENT_SECRET/);
    expect(() =>
      parseAdsEnv({ SNAPCHAT_CLIENT_ID: "bad id", SNAPCHAT_CLIENT_SECRET: CLIENT_SECRET }),
    ).toThrow();
    expect(
      parseAdsEnv({ SNAPCHAT_CLIENT_ID: CLIENT_ID, SNAPCHAT_CLIENT_SECRET: CLIENT_SECRET }),
    ).toMatchObject({ SNAPCHAT_CLIENT_ID: CLIENT_ID });
  });
});
