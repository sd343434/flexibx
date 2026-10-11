import {
  AdPlatformError,
  inclusiveDays,
  type AdPlatformAdapter,
  type ExternalAction,
  type LaunchRequest,
  type OAuthGrant,
  type RefreshedAccess,
} from "../adapter";
import { createSnapchatWriter } from "./blocked-writers";
import {
  microToMinor,
  minorToMicro,
  type AccountSnapshot,
  type AdAccountStatus,
  type AdDeliveryStatus,
  type AdObjective,
  type Money,
  type UnifiedAdAccount,
} from "../model";

// Snapchat Ads through the official Snap Marketing API (Ads API v1).
//
// Connection (developers.snap.com/marketing-api/Ads-API/authentication): OAuth 2.0
// authorization code. The person consents at accounts.snapchat.com/login/oauth2/authorize
// (scope `snapchat-marketing-api`, a single-use `state`); the code is exchanged
// server-to-server at accounts.snapchat.com/login/oauth2/access_token (client secret in
// the POST body, never in a URL). Snap returns a short-lived access token (expires_in
// 3600 s) and a refresh token that does not expire but stops working when the person's
// access is removed. Flexibx stores only the refresh token (encrypted) and mints a fresh
// access token for each use (grant_type=refresh_token); the access token is held in
// memory for that operation only. API calls send `Authorization: Bearer`.
//
// Read-only: the person's organizations and ad accounts (/v1/me/organizations
// ?with_ad_accounts=true), campaigns, ad squads, ads, and campaign totals from the stats
// endpoint (impressions, swipes, spend in micro-currency). Swipe-ups are Snapchat's
// clicks. Pagination follows `paging.next_link`, but only to adsapi.snapchat.com.
//
// Not implemented: creating or changing campaigns. `describeLaunch` states what a launch
// would send (for review), but `capabilities.launchCampaign` is false and there is no
// `launchCampaign`: no write path has been built or tested against a real Snap account.

export const SNAPCHAT_SCOPE = "snapchat-marketing-api";
export const SNAPCHAT_REQUIRED_SCOPES = [SNAPCHAT_SCOPE] as const;
const AUTH_ORIGIN = "https://accounts.snapchat.com";
const API_ORIGIN = "https://adsapi.snapchat.com";
const API = `${API_ORIGIN}/v1`;
const PAGE_LIMIT = 200;
const MAX_PAGES = 3;
const TIMEOUT_MS = 15_000;

export interface SnapchatAdapterConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const int = (value: unknown): number | null => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function cleanId(value: unknown): string | null {
  const id = str(value);
  return id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** HTTP status (and Snap's OAuth `error`) → normalized failure. */
export function snapchatFailure(httpStatus: number, oauthError: string | null = null) {
  if (oauthError === "invalid_grant") return new AdPlatformError("token_expired", httpStatus);
  if (httpStatus === 401) return new AdPlatformError("token_expired", httpStatus);
  if (httpStatus === 403) return new AdPlatformError("permission_missing", httpStatus);
  if (httpStatus === 429) return new AdPlatformError("rate_limited", httpStatus);
  if (httpStatus === 400 || httpStatus === 404 || httpStatus === 422) {
    return new AdPlatformError("invalid_request", httpStatus);
  }
  return new AdPlatformError("provider_error", httpStatus === 0 ? null : httpStatus);
}

export function snapchatAccountStatus(value: unknown): AdAccountStatus {
  switch (value) {
    case "ACTIVE":
      return "ACTIVE";
    case "DISABLED":
      return "DISABLED";
    case "PENDING":
    case "PENDING_REVIEW":
      return "PENDING";
    case "DELETED":
    case "CLOSED":
      return "CLOSED";
    default:
      return "OTHER";
  }
}

/** An entity's delivery status, refined by an ad's review status when present. */
export function snapchatDeliveryStatus(status: unknown, reviewStatus?: unknown): AdDeliveryStatus {
  if (reviewStatus === "REJECTED") return "REJECTED";
  if (status === "ACTIVE" && (reviewStatus === "PENDING" || reviewStatus === "PENDING_REVIEW")) {
    return "IN_REVIEW";
  }
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "PAUSED";
    case "ARCHIVED":
      return "ARCHIVED";
    case "DELETED":
      return "DELETED";
    default:
      return "OTHER";
  }
}

/** Snap objectives (current `objective_v2_type` first, then legacy `objective`). */
export function snapchatObjective(campaign: Json): AdObjective | null {
  const v2 = isRecord(campaign.objective_v2_properties)
    ? str(campaign.objective_v2_properties.objective_v2_type)
    : null;
  switch (v2 ?? campaign.objective) {
    case "AWARENESS_AND_ENGAGEMENT":
    case "BRAND_AWARENESS":
    case "AWARENESS":
    case "PROMOTE_STORIES":
    case "PROMOTE_PLACES":
      return "AWARENESS";
    case "ENGAGEMENT":
    case "VIDEO_VIEWS":
      return "ENGAGEMENT";
    case "TRAFFIC":
    case "WEB_VIEW":
    case "DRIVE_REPLAY":
      return "TRAFFIC";
    case "LEADS":
    case "LEAD_GENERATION":
      return "LEADS";
    case "SALES":
    case "WEB_CONVERSION":
    case "CATALOG_SALES":
      return "SALES";
    case "APP_PROMOTION":
    case "APP_INSTALLS":
    case "APP_CONVERSION":
    case "APP_REENGAGEMENT":
      return "APP_PROMOTION";
    default:
      return null;
  }
}

const OBJECTIVE_TO_SNAP: Readonly<Record<AdObjective, string>> = {
  AWARENESS: "AWARENESS_AND_ENGAGEMENT",
  ENGAGEMENT: "AWARENESS_AND_ENGAGEMENT",
  MESSAGES: "AWARENESS_AND_ENGAGEMENT",
  TRAFFIC: "TRAFFIC",
  LEADS: "LEADS",
  SALES: "SALES",
  APP_PROMOTION: "APP_PROMOTION",
};

/** The UTC offset ("+03:00") of an IANA time zone at an instant. */
function offsetAt(timeZone: string, instant: number): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date(instant))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "-" ? -1 : 1) * minutes;
}

/** Midnight of `day` (YYYY-MM-DD) in `timeZone`, as ISO 8601 with its offset. */
export function zonedMidnight(day: string, timeZone: string | null): string {
  let offset = 0;
  try {
    if (timeZone !== null) {
      const guess = Date.parse(`${day}T00:00:00Z`);
      offset = offsetAt(timeZone, guess - offsetAt(timeZone, guess) * 60_000);
    }
  } catch {
    offset = 0;
  }
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day}T00:00:00.000${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Today in `timeZone` (YYYY-MM-DD), falling back to UTC. */
function today(timeZone: string | null, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The stats window: the last `days` full days in the account's time zone (today excluded). */
export function statsWindow(
  timeZone: string | null,
  days: number,
  now: Date = new Date(),
): { readonly start: string; readonly end: string } {
  const end = today(timeZone, now);
  return {
    start: zonedMidnight(addDays(end, -days), timeZone),
    end: zonedMidnight(end, timeZone),
  };
}

export function createSnapchatAdapter(config: SnapchatAdapterConfig): AdPlatformAdapter {
  const http = config.fetch ?? fetch;

  async function send(url: URL, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await http(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
        redirect: "error",
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
    return { status: response.status, body };
  }

  /** The OAuth token endpoint (form POST; the client secret travels in the body only). */
  async function token(params: Record<string, string>): Promise<Json> {
    const { status, body } = await send(new URL(`${AUTH_ORIGIN}/login/oauth2/access_token`), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        ...params,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });
    if (status < 200 || status >= 300 || !isRecord(body) || str(body.access_token) === null) {
      throw snapchatFailure(status, isRecord(body) ? str(body.error) : null);
    }
    return body;
  }

  async function get(url: URL, accessToken: string): Promise<Json> {
    const { status, body } = await send(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
    if (status < 200 || status >= 300) throw snapchatFailure(status);
    if (
      !isRecord(body) ||
      (body.request_status !== undefined && body.request_status !== "SUCCESS")
    ) {
      throw new AdPlatformError("provider_error", status);
    }
    return body;
  }

  /** Only Snap's own API host may be followed (a next_link elsewhere would get the token). */
  function sameApi(link: unknown): URL | null {
    const text = str(link);
    if (text === null) return null;
    try {
      const url = new URL(text);
      return url.origin === API_ORIGIN && url.pathname.startsWith("/v1/") ? url : null;
    } catch {
      return null;
    }
  }

  /** A list endpoint whose items are `{ sub_request_status, <entity>: {...} }`. */
  async function list(
    path: string,
    collection: string,
    entity: string,
    accessToken: string,
    params: Readonly<Record<string, string>> = {},
  ): Promise<{ readonly items: Json[]; readonly truncated: boolean }> {
    const items: Json[] = [];
    let url: URL | null = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries({ limit: String(PAGE_LIMIT), ...params })) {
      url.searchParams.set(key, value);
    }
    for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
      const body = await get(url, accessToken);
      for (const wrapper of records(body[collection])) {
        if (wrapper.sub_request_status !== undefined && wrapper.sub_request_status !== "SUCCESS") {
          continue;
        }
        if (isRecord(wrapper[entity])) items.push(wrapper[entity]);
      }
      const paging = isRecord(body.paging) ? body.paging : {};
      url = sameApi(paging.next_link);
    }
    return { items, truncated: url !== null };
  }

  function money(value: unknown, currency: string): Money | null {
    const micro = int(value);
    const minor = micro === null ? null : microToMinor(micro, currency);
    return minor === null || minor === 0 ? null : { minor, currency };
  }

  return {
    platform: "SNAPCHAT",
    capabilities: {
      connect: true,
      listAccounts: true,
      readCampaigns: true,
      readInsights: true,
      launchCampaign: false,
    },
    requiredScopes: SNAPCHAT_REQUIRED_SCOPES,
    credential: "refresh_token",
    // The write boundary exists but is blocked (see blocked-writers.ts).
    writer: createSnapchatWriter(),

    authorizeUrl({ state, redirectUri }) {
      const url = new URL(`${AUTH_ORIGIN}/login/oauth2/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", SNAPCHAT_SCOPE);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode({ code, redirectUri }): Promise<OAuthGrant> {
      const grant = await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).catch((error: unknown) => {
        // An unusable code (expired, reused, wrong redirect) is an OAuth failure.
        if (
          error instanceof AdPlatformError &&
          (error.kind === "invalid_request" || error.kind === "token_expired")
        ) {
          throw new AdPlatformError("oauth_invalid", error.platformCode);
        }
        throw error;
      });
      const accessToken = str(grant.access_token);
      const refreshToken = str(grant.refresh_token);
      if (accessToken === null || refreshToken === null || refreshToken.length === 0) {
        throw new AdPlatformError("oauth_invalid");
      }
      const expiresIn = int(grant.expires_in);
      // Snap returns the granted scope; when absent, the single requested scope was the
      // one consented to (the consent screen grants it or nothing).
      const scopeText = str(grant.scope) ?? SNAPCHAT_SCOPE;
      const granted = scopeText
        .split(/[\s,]+/)
        .filter((scope) => /^[a-z0-9_.:-]{1,80}$/.test(scope));
      const body = await get(new URL(`${API}/me`), accessToken);
      const me = isRecord(body.me) ? body.me : {};
      const userId = cleanId(me.id);
      if (userId === null) throw new AdPlatformError("provider_error");
      // Only the display name is kept (never the email or username).
      const name = str(me.display_name)?.slice(0, 200) ?? null;
      return {
        accessToken,
        refreshToken,
        expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
        externalUser: { id: userId, name },
        grantedScopes: [...new Set(granted)].sort(),
      };
    },

    async refreshAccessToken(refreshToken): Promise<RefreshedAccess> {
      const body = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
      const accessToken = str(body.access_token);
      if (accessToken === null) throw new AdPlatformError("token_expired");
      const rotated = str(body.refresh_token);
      return {
        accessToken,
        refreshToken:
          rotated !== null && rotated !== "" && rotated !== refreshToken ? rotated : null,
      };
    },

    async listAccounts(accessToken): Promise<UnifiedAdAccount[]> {
      const { items: organizations } = await list(
        "/me/organizations",
        "organizations",
        "organization",
        accessToken,
        { with_ad_accounts: "true" },
      );
      const seen = new Set<string>();
      return organizations.flatMap((organization) =>
        records(organization.ad_accounts).flatMap((item) => {
          const externalId = cleanId(item.id);
          const currency = str(item.currency);
          if (externalId === null || currency === null || !/^[A-Z]{3}$/.test(currency)) return [];
          if (seen.has(externalId)) return [];
          seen.add(externalId);
          return [
            {
              externalId,
              name: (str(item.name) ?? externalId).slice(0, 200),
              currency,
              timeZone: str(item.timezone)?.slice(0, 64) ?? null,
              status: snapchatAccountStatus(item.status),
            },
          ];
        }),
      );
    },

    async readAccount(accessToken, account, days): Promise<AccountSnapshot> {
      const range = days <= 7 ? 7 : days <= 14 ? 14 : 30;
      const base = `/adaccounts/${encodeURIComponent(account.externalId)}`;
      const window = statsWindow(account.timeZone ?? null, range);
      const statsUrl = new URL(`${API}${base}/stats`);
      for (const [key, value] of Object.entries({
        granularity: "TOTAL",
        breakdown: "campaign",
        fields: "impressions,swipes,spend",
        start_time: window.start,
        end_time: window.end,
      })) {
        statsUrl.searchParams.set(key, value);
      }
      const [campaigns, adSquads, ads, statsBody] = await Promise.all([
        list(`${base}/campaigns`, "campaigns", "campaign", accessToken),
        list(`${base}/adsquads`, "adsquads", "adsquad", accessToken),
        list(`${base}/ads`, "ads", "ad", accessToken),
        get(statsUrl, accessToken),
      ]);
      const stats = {
        items: records(statsBody.total_stats)
          .filter((w) => w.sub_request_status === undefined || w.sub_request_status === "SUCCESS")
          .map((w) => w.total_stat)
          .filter(isRecord),
        truncated: false,
      };
      const currency = account.currency;
      const squadCampaign = new Map<string, string>();
      const adSets = adSquads.items.flatMap((item) => {
        const externalId = cleanId(item.id);
        const campaignExternalId = cleanId(item.campaign_id);
        if (externalId === null || campaignExternalId === null) return [];
        squadCampaign.set(externalId, campaignExternalId);
        const targeting = isRecord(item.targeting) ? item.targeting : {};
        const demographics = records(targeting.demographics);
        const age = (value: unknown) => {
          const n = int(value);
          return n === null ? null : Math.min(65, Math.max(13, n));
        };
        const ages = (key: string) =>
          demographics.map((d) => age(d[key])).filter((n): n is number => n !== null);
        const minAges = ages("min_age");
        const maxAges = ages("max_age");
        return [
          {
            externalId,
            campaignExternalId,
            name: (str(item.name) ?? externalId).slice(0, 400),
            status: snapchatDeliveryStatus(item.status),
            dailyBudget: money(item.daily_budget_micro, currency),
            lifetimeBudget: money(item.lifetime_budget_micro, currency),
            optimizationGoal: str(item.optimization_goal)?.slice(0, 60) ?? null,
            countries: [
              ...new Set(
                records(targeting.geos)
                  .map((geo) => str(geo.country_code)?.toUpperCase() ?? null)
                  .filter((code): code is string => code !== null && /^[A-Z]{2}$/.test(code)),
              ),
            ].slice(0, 50),
            ageMin: minAges.length === 0 ? null : Math.min(...minAges),
            ageMax: maxAges.length === 0 ? null : Math.max(...maxAges),
          },
        ];
      });
      const breakdown = stats.items.flatMap((total) => {
        const breakdownStats = isRecord(total.breakdown_stats) ? total.breakdown_stats : {};
        return records(breakdownStats.campaign);
      });
      return {
        version: 1,
        fetchedAt: new Date().toISOString(),
        range: { days: range },
        campaigns: campaigns.items.flatMap((item) => {
          const externalId = cleanId(item.id);
          if (externalId === null) return [];
          return [
            {
              externalId,
              name: (str(item.name) ?? externalId).slice(0, 400),
              objective: snapchatObjective(item),
              status: snapchatDeliveryStatus(item.status),
              dailyBudget: money(item.daily_budget_micro, currency),
              lifetimeBudget: money(item.lifetime_spend_cap_micro, currency),
              startAt: str(item.start_time)?.slice(0, 40) ?? null,
              stopAt: str(item.end_time)?.slice(0, 40) ?? null,
            },
          ];
        }),
        adSets,
        ads: ads.items.flatMap((item) => {
          const externalId = cleanId(item.id);
          const adSetExternalId = cleanId(item.ad_squad_id);
          const campaignExternalId =
            adSetExternalId === null ? undefined : squadCampaign.get(adSetExternalId);
          if (externalId === null || adSetExternalId === null || campaignExternalId === undefined) {
            return [];
          }
          return [
            {
              externalId,
              adSetExternalId,
              campaignExternalId,
              name: (str(item.name) ?? externalId).slice(0, 400),
              status: snapchatDeliveryStatus(item.status, item.review_status),
            },
          ];
        }),
        metrics: breakdown.flatMap((item) => {
          const campaignExternalId = cleanId(item.id);
          const values = isRecord(item.stats) ? item.stats : {};
          const impressions = int(values.impressions);
          const micro = int(values.spend ?? 0);
          const spend = micro === null ? null : microToMinor(micro, currency);
          if (campaignExternalId === null || impressions === null || spend === null) return [];
          return [
            {
              campaignExternalId,
              impressions,
              reach: null,
              // Swipe-ups are Snapchat's clicks.
              clicks: int(values.swipes) ?? 0,
              spend: { minor: spend, currency },
            },
          ];
        }),
        truncated: [campaigns, adSquads, ads, stats].some((part) => part.truncated),
      };
    },

    describeLaunch(request: LaunchRequest): readonly ExternalAction[] {
      const { spec } = request;
      const account = encodeURIComponent(request.accountExternalId);
      const demographics = {
        min_age: String(spec.audience.ageMin),
        max_age: String(spec.audience.ageMax),
        ...(spec.audience.genders === "ALL" ? {} : { gender: spec.audience.genders }),
      };
      // Everything is created PAUSED: nothing delivers or spends until a person turns it
      // on in Snapchat Ads Manager (or a later, separately approved action).
      return [
        {
          method: "POST",
          endpoint: `/v1/adaccounts/${account}/campaigns`,
          params: {
            campaigns: [
              {
                name: spec.campaignName,
                ad_account_id: request.accountExternalId,
                status: "PAUSED",
                objective_v2_properties: { objective_v2_type: OBJECTIVE_TO_SNAP[spec.objective] },
                start_time: request.startDate,
              },
            ],
          },
        },
        {
          method: "POST",
          endpoint: "/v1/campaigns/{created campaign}/adsquads",
          params: {
            adsquads: [
              {
                name: `${spec.campaignName} · ${String(inclusiveDays(request.startDate, request.endDate))}d`,
                campaign_id: "{created campaign}",
                type: "SNAP_ADS",
                status: "PAUSED",
                lifetime_budget_micro: minorToMicro(request.budgetTotalMinor, request.currency),
                start_time: request.startDate,
                end_time: request.endDate,
                placement_v2: { config: "AUTOMATIC" },
                targeting: {
                  geos: spec.audience.countries.map((code) => ({
                    country_code: code.toLowerCase(),
                  })),
                  demographics: [demographics],
                },
              },
            ],
          },
        },
        {
          method: "POST",
          endpoint: `/v1/adaccounts/${account}/creatives`,
          params: {
            creatives: [
              {
                name: spec.creative.headline,
                ad_account_id: request.accountExternalId,
                type: "SNAP_AD",
                headline: spec.creative.headline,
                call_to_action: spec.creative.callToAction,
                top_snap_media:
                  request.media === null ? null : `${request.media.filename} (${request.media.id})`,
              },
            ],
          },
        },
        {
          method: "POST",
          endpoint: "/v1/adsquads/{created ad squad}/ads",
          params: {
            ads: [
              {
                name: spec.creative.headline,
                ad_squad_id: "{created ad squad}",
                creative_id: "{created creative}",
                type: "SNAP_AD",
                status: "PAUSED",
              },
            ],
          },
        },
      ];
    },
  };
}
