import { createHmac } from "node:crypto";

import {
  AdPlatformError,
  inclusiveDays,
  type AdPlatformAdapter,
  type ExternalAction,
  type LaunchRequest,
  type OAuthGrant,
} from "../adapter";
import {
  META_WRITE_SCOPES,
  createMetaWriter,
  metaStepParams,
  metaSupportsCurrency,
  metaSupportsObjective,
  metaSupportsPlacements,
} from "./meta-writer";
import {
  majorToMinor,
  type AccountSnapshot,
  type AdAccountStatus,
  type AdDeliveryStatus,
  type AdObjective,
  type AdPlacement,
  type Money,
  type UnifiedAdAccount,
} from "../model";

// Meta (Facebook and Instagram ads) through the official Graph / Marketing API.
//
// Connection: the Facebook Login dialog (www.facebook.com/{version}/dialog/oauth) with a
// single-use `state`, then a server-to-server code exchange (graph.facebook.com/
// {version}/oauth/access_token) and an exchange for a long-lived user token
// (grant_type=fb_exchange_token, ~60 days). Only `ads_read` is requested: reading ad
// accounts, campaigns, ad sets, ads and insights. Every Graph call carries
// `appsecret_proof` (HMAC-SHA256 of the token with the app secret). Tokens are sent in
// the request only, never put into errors or logs.
//
// Writes (meta-writer.ts) run only through the shared execution service inside approved
// orchestration tasks, and only when execution is enabled on the server and the
// connection was granted `ads_management` (App Review + Business Verification). They
// have been exercised against deterministic stand-ins only, never against real Meta.

export const META_REQUIRED_SCOPES = ["ads_read"] as const;
const PAGE_LIMIT = 100;
const MAX_PAGES = 3;
const TIMEOUT_MS = 15_000;

export interface MetaAdapterConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** e.g. v26.0 */
  readonly version: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Also ask for the write permissions (ads_management, pages_show_list) at sign-in:
   * only when this server enables campaign creation (ADS_EXECUTION_ENABLED). Reading
   * never needs them; a connection without them simply cannot create campaigns.
   */
  readonly requestWriteAccess?: boolean;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const int = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/** Graph error codes → normalized failures (https://developers.facebook.com/docs/graph-api/guides/error-handling). */
export function metaFailure(code: number | null, httpStatus: number): AdPlatformError {
  if (code === 190 || code === 102 || code === 463 || code === 467) {
    return new AdPlatformError("token_expired", code);
  }
  if (code === 10 || code === 3 || (code !== null && code >= 200 && code <= 299)) {
    return new AdPlatformError("permission_missing", code);
  }
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    (code !== null && code >= 80000 && code <= 80014)
  ) {
    return new AdPlatformError("rate_limited", code);
  }
  if (code === 100) return new AdPlatformError("invalid_request", code);
  if (httpStatus === 401) return new AdPlatformError("token_expired", code);
  if (httpStatus === 403) return new AdPlatformError("permission_missing", code);
  return new AdPlatformError("provider_error", code);
}

const ACCOUNT_STATUS: Readonly<Record<number, AdAccountStatus>> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING",
  8: "PENDING",
  9: "ACTIVE",
  100: "PENDING",
  101: "CLOSED",
};

export function metaDeliveryStatus(value: unknown): AdDeliveryStatus {
  switch (value) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return "PAUSED";
    case "IN_PROCESS":
    case "PENDING_REVIEW":
    case "PREAPPROVED":
    case "PENDING_BILLING_INFO":
      return "IN_REVIEW";
    case "DISAPPROVED":
    case "WITH_ISSUES":
      return "REJECTED";
    case "ARCHIVED":
      return "ARCHIVED";
    case "DELETED":
      return "DELETED";
    default:
      return "OTHER";
  }
}

/** Current (ODAX) and legacy Meta objectives → unified objective. */
export function metaObjective(value: unknown): AdObjective | null {
  switch (value) {
    case "OUTCOME_AWARENESS":
    case "BRAND_AWARENESS":
    case "REACH":
      return "AWARENESS";
    case "OUTCOME_TRAFFIC":
    case "LINK_CLICKS":
      return "TRAFFIC";
    case "OUTCOME_ENGAGEMENT":
    case "POST_ENGAGEMENT":
    case "PAGE_LIKES":
    case "VIDEO_VIEWS":
    case "EVENT_RESPONSES":
      return "ENGAGEMENT";
    case "OUTCOME_LEADS":
    case "LEAD_GENERATION":
      return "LEADS";
    case "OUTCOME_SALES":
    case "CONVERSIONS":
    case "PRODUCT_CATALOG_SALES":
      return "SALES";
    case "OUTCOME_APP_PROMOTION":
    case "APP_INSTALLS":
      return "APP_PROMOTION";
    case "MESSAGES":
      return "MESSAGES";
    default:
      return null;
  }
}

const OBJECTIVE_TO_META: Readonly<Record<AdObjective, string>> = {
  AWARENESS: "OUTCOME_AWARENESS",
  TRAFFIC: "OUTCOME_TRAFFIC",
  ENGAGEMENT: "OUTCOME_ENGAGEMENT",
  LEADS: "OUTCOME_LEADS",
  SALES: "OUTCOME_SALES",
  APP_PROMOTION: "OUTCOME_APP_PROMOTION",
  MESSAGES: "OUTCOME_ENGAGEMENT",
};

const PLACEMENT_TO_META: Readonly<
  Record<Exclude<AdPlacement, "AUTOMATIC">, readonly [string, string]>
> = {
  FACEBOOK_FEED: ["facebook", "feed"],
  FACEBOOK_STORIES: ["facebook", "story"],
  FACEBOOK_REELS: ["facebook", "facebook_reels"],
  INSTAGRAM_FEED: ["instagram", "stream"],
  INSTAGRAM_STORIES: ["instagram", "story"],
  INSTAGRAM_REELS: ["instagram", "reels"],
};

function money(value: unknown, currency: string): Money | null {
  const minor = int(value);
  return minor === null || minor === 0 ? null : { minor, currency };
}

function cleanId(value: unknown): string | null {
  const id = str(value);
  return id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

export function createMetaAdapter(config: MetaAdapterConfig): AdPlatformAdapter {
  const http = config.fetch ?? fetch;
  const graph = `https://graph.facebook.com/${config.version}`;
  const proof = (token: string) =>
    createHmac("sha256", config.appSecret).update(token).digest("hex");

  async function call(path: string, params: Record<string, string>, token?: string): Promise<Json> {
    const url = new URL(`${graph}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (token !== undefined) {
      url.searchParams.set("access_token", token);
      url.searchParams.set("appsecret_proof", proof(token));
    }
    let response: Response;
    try {
      response = await http(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new AdPlatformError("provider_error");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || (isRecord(body) && isRecord(body.error))) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : {};
      throw metaFailure(int(error.code), response.status);
    }
    if (!isRecord(body)) throw new AdPlatformError("provider_error");
    return body;
  }

  /** A list edge, following `after` cursors up to MAX_PAGES. */
  async function list(
    path: string,
    params: Record<string, string>,
    token: string,
  ): Promise<{ readonly items: Json[]; readonly truncated: boolean }> {
    const items: Json[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await call(
        path,
        { ...params, limit: String(PAGE_LIMIT), ...(after === null ? {} : { after }) },
        token,
      );
      const data = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
      items.push(...data);
      const paging = isRecord(body.paging) ? body.paging : {};
      const cursors = isRecord(paging.cursors) ? paging.cursors : {};
      after = typeof paging.next === "string" ? str(cursors.after) : null;
      if (after === null) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  return {
    platform: "META",
    capabilities: {
      connect: true,
      listAccounts: true,
      readCampaigns: true,
      readInsights: true,
      launchCampaign: true,
    },
    requiredScopes: META_REQUIRED_SCOPES,
    writer: createMetaWriter({
      appSecret: config.appSecret,
      version: config.version,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    }),

    authorizeUrl({ state, redirectUri }) {
      const url = new URL(`https://www.facebook.com/${config.version}/dialog/oauth`);
      url.searchParams.set("client_id", config.appId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set(
        "scope",
        [
          ...META_REQUIRED_SCOPES,
          ...(config.requestWriteAccess === true ? META_WRITE_SCOPES : []),
        ].join(","),
      );
      return url.toString();
    },

    async exchangeCode({ code, redirectUri }): Promise<OAuthGrant> {
      const short = await call("/oauth/access_token", {
        client_id: config.appId,
        client_secret: config.appSecret,
        redirect_uri: redirectUri,
        code,
      }).catch((error: unknown) => {
        // An unusable code (expired, reused, wrong redirect) is an OAuth failure.
        if (error instanceof AdPlatformError && error.kind === "invalid_request") {
          throw new AdPlatformError("oauth_invalid", error.platformCode);
        }
        throw error;
      });
      const shortToken = str(short.access_token);
      if (shortToken === null) throw new AdPlatformError("oauth_invalid");
      const long = await call("/oauth/access_token", {
        grant_type: "fb_exchange_token",
        client_id: config.appId,
        client_secret: config.appSecret,
        fb_exchange_token: shortToken,
      });
      const accessToken = str(long.access_token) ?? shortToken;
      const expiresIn = int(long.expires_in) ?? int(short.expires_in);
      const [me, permissions] = await Promise.all([
        call("/me", { fields: "id,name" }, accessToken),
        call("/me/permissions", {}, accessToken),
      ]);
      const userId = cleanId(me.id);
      if (userId === null) throw new AdPlatformError("provider_error");
      const granted = (Array.isArray(permissions.data) ? permissions.data : [])
        .filter(isRecord)
        .filter((entry) => entry.status === "granted")
        .map((entry) => str(entry.permission))
        .filter((name): name is string => name !== null && /^[a-z_]{1,60}$/.test(name));
      return {
        accessToken,
        expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
        externalUser: { id: userId, name: str(me.name)?.slice(0, 200) ?? null },
        grantedScopes: [...new Set(granted)].sort(),
      };
    },

    async listAccounts(token): Promise<UnifiedAdAccount[]> {
      const { items } = await list(
        "/me/adaccounts",
        { fields: "id,account_id,name,currency,timezone_name,account_status" },
        token,
      );
      return items.flatMap((item) => {
        const externalId = cleanId(item.account_id);
        const currency = str(item.currency);
        if (externalId === null || currency === null || !/^[A-Z]{3}$/.test(currency)) return [];
        return [
          {
            externalId,
            name: (str(item.name) ?? externalId).slice(0, 200),
            currency,
            timeZone: str(item.timezone_name)?.slice(0, 64) ?? null,
            status: ACCOUNT_STATUS[int(item.account_status) ?? -1] ?? "OTHER",
          },
        ];
      });
    },

    async readAccount(token, account, days): Promise<AccountSnapshot> {
      const act = `/act_${account.externalId}`;
      const [campaigns, adSets, ads, insights] = await Promise.all([
        list(
          `${act}/campaigns`,
          {
            fields:
              "id,name,objective,effective_status,daily_budget,lifetime_budget,start_time,stop_time",
          },
          token,
        ),
        list(
          `${act}/adsets`,
          {
            fields:
              "id,name,campaign_id,effective_status,daily_budget,lifetime_budget,optimization_goal,targeting",
          },
          token,
        ),
        list(`${act}/ads`, { fields: "id,name,adset_id,campaign_id,effective_status" }, token),
        list(
          `${act}/insights`,
          {
            level: "campaign",
            date_preset: days <= 7 ? "last_7d" : days <= 14 ? "last_14d" : "last_30d",
            fields: "campaign_id,impressions,reach,clicks,spend",
          },
          token,
        ),
      ]);
      const currency = account.currency;
      const snapshot: AccountSnapshot = {
        version: 1,
        fetchedAt: new Date().toISOString(),
        range: { days: days <= 7 ? 7 : days <= 14 ? 14 : 30 },
        campaigns: campaigns.items.flatMap((item) => {
          const externalId = cleanId(item.id);
          if (externalId === null) return [];
          return [
            {
              externalId,
              name: (str(item.name) ?? externalId).slice(0, 400),
              objective: metaObjective(item.objective),
              status: metaDeliveryStatus(item.effective_status),
              dailyBudget: money(item.daily_budget, currency),
              lifetimeBudget: money(item.lifetime_budget, currency),
              startAt: str(item.start_time)?.slice(0, 40) ?? null,
              stopAt: str(item.stop_time)?.slice(0, 40) ?? null,
            },
          ];
        }),
        adSets: adSets.items.flatMap((item) => {
          const externalId = cleanId(item.id);
          const campaignExternalId = cleanId(item.campaign_id);
          if (externalId === null || campaignExternalId === null) return [];
          const targeting = isRecord(item.targeting) ? item.targeting : {};
          const geo = isRecord(targeting.geo_locations) ? targeting.geo_locations : {};
          const age = (value: unknown) => {
            const n = int(value);
            return n === null ? null : Math.min(65, Math.max(13, n));
          };
          return [
            {
              externalId,
              campaignExternalId,
              name: (str(item.name) ?? externalId).slice(0, 400),
              status: metaDeliveryStatus(item.effective_status),
              dailyBudget: money(item.daily_budget, currency),
              lifetimeBudget: money(item.lifetime_budget, currency),
              optimizationGoal: str(item.optimization_goal)?.slice(0, 60) ?? null,
              countries: (Array.isArray(geo.countries) ? geo.countries : [])
                .map(str)
                .filter((code): code is string => code !== null && /^[A-Z]{2}$/.test(code))
                .slice(0, 50),
              ageMin: age(targeting.age_min),
              ageMax: age(targeting.age_max),
            },
          ];
        }),
        ads: ads.items.flatMap((item) => {
          const externalId = cleanId(item.id);
          const adSetExternalId = cleanId(item.adset_id);
          const campaignExternalId = cleanId(item.campaign_id);
          if (externalId === null || adSetExternalId === null || campaignExternalId === null) {
            return [];
          }
          return [
            {
              externalId,
              adSetExternalId,
              campaignExternalId,
              name: (str(item.name) ?? externalId).slice(0, 400),
              status: metaDeliveryStatus(item.effective_status),
            },
          ];
        }),
        metrics: insights.items.flatMap((item) => {
          const campaignExternalId = cleanId(item.campaign_id);
          const spend = majorToMinor(str(item.spend) ?? "0", currency);
          const impressions = int(item.impressions);
          const clicks = int(item.clicks);
          if (campaignExternalId === null || spend === null || impressions === null) return [];
          return [
            {
              campaignExternalId,
              impressions,
              reach: int(item.reach),
              clicks: clicks ?? 0,
              spend: { minor: spend, currency },
            },
          ];
        }),
        truncated: [campaigns, adSets, ads, insights].some((part) => part.truncated),
      };
      return snapshot;
    },

    describeLaunch(request: LaunchRequest): readonly ExternalAction[] {
      const act = `act_${request.accountExternalId}`;
      if (
        metaSupportsObjective(request.spec.objective) &&
        metaSupportsPlacements(request.spec.placements) &&
        metaSupportsCurrency(request.currency)
      ) {
        // Exactly what the write path sends (ids of created objects are filled in order).
        const context = {
          request,
          tag: "{plan tag}",
          identityId: request.identityId ?? "{your Facebook Page}",
          ids: {},
          media:
            request.media === null
              ? null
              : { body: new Uint8Array(), contentType: "", filename: request.media.filename },
        };
        const steps = [
          ...(request.media === null ? [] : (["media"] as const)),
          "campaign",
          "adset",
          "creative",
          "ad",
        ] as const;
        const edge = {
          media: "adimages",
          campaign: "campaigns",
          adset: "adsets",
          creative: "adcreatives",
          ad: "ads",
        } as const;
        return steps.map((step) => ({
          method: "POST" as const,
          endpoint: `/${act}/${edge[step]}`,
          params: metaStepParams(step, context) as ExternalAction["params"],
        }));
      }
      const { spec } = request;
      const placements = spec.placements.includes("AUTOMATIC")
        ? null
        : spec.placements.filter((p): p is Exclude<AdPlacement, "AUTOMATIC"> => p !== "AUTOMATIC");
      const positions = (platform: string) =>
        (placements ?? [])
          .map((p) => PLACEMENT_TO_META[p])
          .filter(([owner]) => owner === platform)
          .map(([, position]) => position);
      const targeting = {
        geo_locations: { countries: [...spec.audience.countries] },
        age_min: spec.audience.ageMin,
        age_max: spec.audience.ageMax,
        ...(spec.audience.genders === "ALL"
          ? {}
          : { genders: [spec.audience.genders === "MALE" ? 1 : 2] }),
        ...(placements === null
          ? {}
          : {
              publisher_platforms: [
                ...new Set(placements.map((p) => PLACEMENT_TO_META[p][0])),
              ].sort(),
              facebook_positions: positions("facebook"),
              instagram_positions: positions("instagram"),
            }),
      };
      // Everything is created PAUSED: nothing delivers or spends until a person turns it
      // on in Meta Ads Manager (or a later, separately approved action).
      return [
        {
          method: "POST",
          endpoint: `/${act}/campaigns`,
          params: {
            name: spec.campaignName,
            objective: OBJECTIVE_TO_META[spec.objective],
            status: "PAUSED",
            special_ad_categories: [],
          },
        },
        {
          method: "POST",
          endpoint: `/${act}/adsets`,
          params: {
            name: `${spec.campaignName} · ${String(inclusiveDays(request.startDate, request.endDate))}d`,
            campaign_id: "{created campaign}",
            lifetime_budget: request.budgetTotalMinor,
            currency: request.currency,
            start_time: request.startDate,
            end_time: request.endDate,
            billing_event: "IMPRESSIONS",
            targeting,
            // Ads that click to WhatsApp (Marketing API): the conversation opens in the
            // business's WhatsApp; the Facebook Page is required, the number optional.
            ...(spec.objective === "MESSAGES"
              ? {
                  destination_type: "WHATSAPP",
                  optimization_goal: "CONVERSATIONS",
                  promoted_object: { page_id: "{your Facebook Page}" },
                }
              : {}),
            status: "PAUSED",
          },
        },
        {
          method: "POST",
          endpoint: `/${act}/adcreatives`,
          params: {
            title: spec.creative.headline,
            body: spec.creative.primaryText,
            call_to_action_type: spec.creative.callToAction,
            image:
              request.media === null ? null : `${request.media.filename} (${request.media.id})`,
          },
        },
        {
          method: "POST",
          endpoint: `/${act}/ads`,
          params: {
            name: spec.creative.headline,
            adset_id: "{created ad set}",
            creative_id: "{created creative}",
            status: "PAUSED",
          },
        },
      ];
    },
  };
}
