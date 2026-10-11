import { createHash } from "node:crypto";

import {
  AdPlatformError,
  inclusiveDays,
  type AdPlatformAdapter,
  type ExternalAction,
  type LaunchRequest,
  type OAuthGrant,
} from "../adapter";
import {
  majorToMinor,
  type AccountSnapshot,
  type AdAccountStatus,
  type AdDeliveryStatus,
  type AdObjective,
  type Money,
  type UnifiedAdAccount,
} from "../model";
import { formatMajor } from "../planner-math";

import { createTikTokWriter } from "./blocked-writers";

// TikTok Ads through the official TikTok API for Business (Marketing API, v1.3).
//
// Connection (business-api.tiktok.com/portal/docs, "Obtain a long-term access token"):
// the advertiser opens the app's Advertiser authorization URL (copied from My Apps →
// Basic Information; by default built as business-api.tiktok.com/portal/auth with
// app_id, state and redirect_uri), approves, and is sent to the registered redirect URL
// with an `auth_code` (valid 1 hour, single use). The code is exchanged server-to-server
// at /open_api/v1.3/oauth2/access_token/ (JSON body: app_id, secret, auth_code) for a
// long-term access token that does not expire (it stops working when the advertiser
// cancels the authorization). Every API call sends the token in the `Access-Token`
// header, never in a URL.
//
// Read-only: authorized ad accounts (/oauth2/advertiser/get/), their details
// (/advertiser/info/), campaigns, ad groups and ads (/campaign/get/, /adgroup/get/,
// /ad/get/), and campaign totals from the synchronous basic report
// (/report/integrated/get/, data_level AUCTION_CAMPAIGN). Responses are
// `{ code, message, request_id, data }`; anything but code 0 is an error (40100 =
// throttled). Lists are paged with page/page_size (page_info.total_page).
//
// Not implemented: creating or changing campaigns. `describeLaunch` states what a launch
// would send (for review), but `capabilities.launchCampaign` is false and there is no
// `launchCampaign`: no write path has been built or tested against TikTok (its sandbox).

const API_ORIGIN = "https://business-api.tiktok.com";
const API = `${API_ORIGIN}/open_api/v1.3`;
export const TIKTOK_DEFAULT_AUTHORIZE_URL = `${API_ORIGIN}/portal/auth`;
const PAGE_SIZE = 1000;
const MAX_PAGES = 3;
const INFO_BATCH = 100;
const TIMEOUT_MS = 15_000;

export interface TikTokAdapterConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** The app's Advertiser authorization URL (state and redirect_uri are set on it). */
  readonly authorizeUrl?: string;
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

/** TikTok ids are numeric strings in v1.3 (numbers in older versions). */
function cleanId(value: unknown): string | null {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : str(value);
  return id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/**
 * A response's `code` (and HTTP status) → normalized failure. Verified: 0 = OK, 40100 =
 * throttled. The others follow TikTok's return-code families and are assumptions.
 */
export function tiktokFailure(code: number | null, httpStatus: number): AdPlatformError {
  if (code === 40100 || httpStatus === 429) return new AdPlatformError("rate_limited", code);
  if (code === 40102 || code === 40104 || code === 40105 || httpStatus === 401) {
    return new AdPlatformError("token_expired", code);
  }
  if (code === 40001 || code === 40003 || httpStatus === 403) {
    return new AdPlatformError("permission_missing", code);
  }
  if (code === 40002 || code === 40006 || httpStatus === 400 || httpStatus === 404) {
    return new AdPlatformError("invalid_request", code);
  }
  return new AdPlatformError("provider_error", code);
}

export function tiktokAccountStatus(value: unknown): AdAccountStatus {
  switch (value) {
    case "STATUS_ENABLE":
      return "ACTIVE";
    case "STATUS_DISABLE":
    case "STATUS_LIMIT":
    case "STATUS_SELF_SERVICE_UNAUDITED":
      return "DISABLED";
    case "STATUS_PENDING_CONFIRM":
    case "STATUS_PENDING_VERIFIED":
    case "STATUS_PENDING_CONFIRM_MODIFY":
    case "STATUS_WAIT_FOR_BPM_AUDIT":
      return "PENDING";
    case "STATUS_CONFIRM_FAIL":
    case "STATUS_CONFIRM_FAIL_END":
      return "CLOSED";
    default:
      return "OTHER";
  }
}

/** operation_status (ENABLE/DISABLE), refined by secondary_status when it says more. */
export function tiktokDeliveryStatus(operation: unknown, secondary: unknown): AdDeliveryStatus {
  const detail = str(secondary) ?? "";
  if (detail.includes("DELETE")) return "DELETED";
  if (detail.includes("NOT_APPROVE") || detail.includes("REJECT")) return "REJECTED";
  if (detail.includes("AUDIT") || detail.includes("REVIEW")) return "IN_REVIEW";
  if (operation === "ENABLE") return "ACTIVE";
  if (operation === "DISABLE") return "PAUSED";
  return "OTHER";
}

export function tiktokObjective(value: unknown): AdObjective | null {
  switch (value) {
    case "REACH":
    case "RF_REACH":
      return "AWARENESS";
    case "TRAFFIC":
      return "TRAFFIC";
    case "VIDEO_VIEWS":
    case "ENGAGEMENT":
    case "COMMUNITY_INTERACTION":
      return "ENGAGEMENT";
    case "LEAD_GENERATION":
      return "LEADS";
    case "WEB_CONVERSIONS":
    case "CONVERSIONS":
    case "PRODUCT_SALES":
    case "CATALOG_SALES":
    case "SHOP_PURCHASES":
      return "SALES";
    case "APP_PROMOTION":
    case "APP_INSTALL":
      return "APP_PROMOTION";
    default:
      return null;
  }
}

const OBJECTIVE_TO_TIKTOK: Readonly<Record<AdObjective, string>> = {
  AWARENESS: "REACH",
  TRAFFIC: "TRAFFIC",
  ENGAGEMENT: "VIDEO_VIEWS",
  MESSAGES: "TRAFFIC",
  LEADS: "LEAD_GENERATION",
  SALES: "WEB_CONVERSIONS",
  APP_PROMOTION: "APP_PROMOTION",
};

/** TikTok age groups (AGE_18_24, AGE_55_100, …) → the youngest and oldest ages covered. */
export function tiktokAges(groups: unknown): { min: number | null; max: number | null } {
  const bounds = (Array.isArray(groups) ? groups : [])
    .map((group) => /^AGE_(\d{2})_(\d{2,3})$/.exec(str(group) ?? ""))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), Number(match[2])] as const);
  if (bounds.length === 0) return { min: null, max: null };
  const clamp = (n: number) => Math.min(65, Math.max(13, n));
  return {
    min: clamp(Math.min(...bounds.map(([low]) => low))),
    max: clamp(Math.max(...bounds.map(([, high]) => high))),
  };
}

/** A money amount in major units (TikTok sends numbers or numeric strings). */
function majorMoney(value: unknown, currency: string): Money | null {
  const text =
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value.toFixed(6)
      : str(value);
  if (text === null) return null;
  const minor = majorToMinor(text, currency);
  return minor === null || minor === 0 ? null : { minor, currency };
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

/** The report window: the last `days` full days in the account's time zone (today excluded). */
export function reportWindow(
  timeZone: string | null,
  days: number,
  now: Date = new Date(),
): { readonly startDate: string; readonly endDate: string } {
  const endDate = addDays(today(timeZone, now), -1);
  return { startDate: addDays(endDate, -(days - 1)), endDate };
}

export function createTikTokAdapter(config: TikTokAdapterConfig): AdPlatformAdapter {
  const http = config.fetch ?? fetch;

  async function send(url: URL, init: RequestInit): Promise<Json> {
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
    const code = isRecord(body) ? int(body.code) : null;
    if (!response.ok || code !== 0 || !isRecord(body)) {
      throw tiktokFailure(code, response.ok ? 200 : response.status);
    }
    return isRecord(body.data) ? body.data : {};
  }

  /** A GET with the token in the Access-Token header; list/object params JSON-encoded. */
  function get(path: string, params: Record<string, unknown>, accessToken: string) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return send(url, {
      method: "GET",
      headers: { accept: "application/json", "Access-Token": accessToken },
    });
  }

  /** A page-numbered list (page/page_size, page_info.total_page), up to MAX_PAGES. */
  async function list(
    path: string,
    params: Record<string, unknown>,
    accessToken: string,
  ): Promise<{ readonly items: Json[]; readonly truncated: boolean }> {
    const items: Json[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await get(
        path,
        { ...params, page: String(page), page_size: String(PAGE_SIZE) },
        accessToken,
      );
      items.push(...records(data.list));
      const info = isRecord(data.page_info) ? data.page_info : {};
      const totalPages = int(info.total_page) ?? 1;
      if (page >= totalPages) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  return {
    platform: "TIKTOK",
    capabilities: {
      connect: true,
      listAccounts: true,
      readCampaigns: true,
      readInsights: true,
      launchCampaign: false,
    },
    // TikTok's token response states its scope as permission ids; read access is checked
    // by the reads themselves (a missing permission surfaces as permission_missing).
    requiredScopes: [],
    credential: "access_token",
    // The write boundary exists but is blocked (see blocked-writers.ts).
    writer: createTikTokWriter(),

    authorizeUrl({ state, redirectUri }) {
      const url = new URL(config.authorizeUrl ?? TIKTOK_DEFAULT_AUTHORIZE_URL);
      url.searchParams.set("app_id", config.appId);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      return url.toString();
    },

    async exchangeCode({ code }): Promise<OAuthGrant> {
      const data = await send(new URL(`${API}/oauth2/access_token/`), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ app_id: config.appId, secret: config.appSecret, auth_code: code }),
      }).catch((error: unknown) => {
        // An unusable code (expired after an hour, reused, foreign) is an OAuth failure.
        if (
          error instanceof AdPlatformError &&
          (error.kind === "invalid_request" || error.kind === "token_expired")
        ) {
          throw new AdPlatformError("oauth_invalid", error.platformCode);
        }
        throw error;
      });
      const accessToken = str(data.access_token);
      if (accessToken === null || accessToken === "") throw new AdPlatformError("oauth_invalid");
      const advertisers = (Array.isArray(data.advertiser_ids) ? data.advertiser_ids : [])
        .map(cleanId)
        .filter((id): id is string => id !== null)
        .sort();
      // The token response names no person: the connection is identified by a digest of
      // the authorized ad accounts (stable for the same authorization, reveals nothing).
      const digest = createHash("sha256").update(advertisers.join(",")).digest("hex");
      const scopes = (Array.isArray(data.scope) ? data.scope : [])
        .map((scope) => (typeof scope === "number" ? String(scope) : str(scope)))
        .filter(
          (scope): scope is string => scope !== null && /^[A-Za-z0-9_.:-]{1,60}$/.test(scope),
        );
      return {
        accessToken,
        expiresAt: null,
        externalUser: { id: `authorization-${digest.slice(0, 24)}`, name: null },
        grantedScopes: [...new Set(scopes)].sort(),
      };
    },

    async listAccounts(accessToken): Promise<UnifiedAdAccount[]> {
      const authorized = await get(
        "/oauth2/advertiser/get/",
        { app_id: config.appId, secret: config.appSecret },
        accessToken,
      );
      const ids = [
        ...new Set(
          records(authorized.list)
            .map((item) => cleanId(item.advertiser_id))
            .filter((id): id is string => id !== null),
        ),
      ];
      const accounts: UnifiedAdAccount[] = [];
      for (let start = 0; start < ids.length; start += INFO_BATCH) {
        const info = await get(
          "/advertiser/info/",
          { advertiser_ids: ids.slice(start, start + INFO_BATCH) },
          accessToken,
        );
        for (const item of records(info.list)) {
          const externalId = cleanId(item.advertiser_id);
          const currency = str(item.currency);
          if (externalId === null || currency === null || !/^[A-Z]{3}$/.test(currency)) continue;
          // display_timezone is a TZ database name; timezone may be an offset.
          const zone = str(item.display_timezone) ?? str(item.timezone);
          accounts.push({
            externalId,
            name: (str(item.name) ?? externalId).slice(0, 200),
            currency,
            timeZone: zone?.includes("/") ? zone.slice(0, 64) : null,
            status: tiktokAccountStatus(item.status),
          });
        }
      }
      return accounts;
    },

    async readAccount(accessToken, account, days): Promise<AccountSnapshot> {
      const range = days <= 7 ? 7 : days <= 14 ? 14 : 30;
      const advertiser = { advertiser_id: account.externalId };
      const window = reportWindow(account.timeZone ?? null, range);
      const [campaigns, adGroups, ads, report] = await Promise.all([
        list("/campaign/get/", advertiser, accessToken),
        list("/adgroup/get/", advertiser, accessToken),
        list("/ad/get/", advertiser, accessToken),
        list(
          "/report/integrated/get/",
          {
            ...advertiser,
            report_type: "BASIC",
            service_type: "AUCTION",
            data_level: "AUCTION_CAMPAIGN",
            dimensions: ["campaign_id"],
            metrics: ["spend", "impressions", "clicks", "reach"],
            start_date: window.startDate,
            end_date: window.endDate,
          },
          accessToken,
        ),
      ]);
      const currency = account.currency;
      const budgets = (item: Json) => {
        const amount = majorMoney(item.budget, currency);
        return {
          dailyBudget: item.budget_mode === "BUDGET_MODE_DAY" ? amount : null,
          lifetimeBudget: item.budget_mode === "BUDGET_MODE_TOTAL" ? amount : null,
        };
      };
      return {
        version: 1,
        fetchedAt: new Date().toISOString(),
        range: { days: range },
        campaigns: campaigns.items.flatMap((item) => {
          const externalId = cleanId(item.campaign_id);
          if (externalId === null) return [];
          return [
            {
              externalId,
              name: (str(item.campaign_name) ?? externalId).slice(0, 400),
              objective: tiktokObjective(item.objective_type),
              status: tiktokDeliveryStatus(item.operation_status, item.secondary_status),
              ...budgets(item),
              startAt: null,
              stopAt: null,
            },
          ];
        }),
        adSets: adGroups.items.flatMap((item) => {
          const externalId = cleanId(item.adgroup_id);
          const campaignExternalId = cleanId(item.campaign_id);
          if (externalId === null || campaignExternalId === null) return [];
          const ages = tiktokAges(item.age_groups);
          return [
            {
              externalId,
              campaignExternalId,
              name: (str(item.adgroup_name) ?? externalId).slice(0, 400),
              status: tiktokDeliveryStatus(item.operation_status, item.secondary_status),
              ...budgets(item),
              optimizationGoal: str(item.optimization_goal)?.slice(0, 60) ?? null,
              // TikTok targets numeric location ids, not country codes: not mapped.
              countries: [],
              ageMin: ages.min,
              ageMax: ages.max,
            },
          ];
        }),
        ads: ads.items.flatMap((item) => {
          const externalId = cleanId(item.ad_id);
          const adSetExternalId = cleanId(item.adgroup_id);
          const campaignExternalId = cleanId(item.campaign_id);
          if (externalId === null || adSetExternalId === null || campaignExternalId === null) {
            return [];
          }
          return [
            {
              externalId,
              adSetExternalId,
              campaignExternalId,
              name: (str(item.ad_name) ?? externalId).slice(0, 400),
              status: tiktokDeliveryStatus(item.operation_status, item.secondary_status),
            },
          ];
        }),
        metrics: report.items.flatMap((row) => {
          const dimensions = isRecord(row.dimensions) ? row.dimensions : {};
          const values = isRecord(row.metrics) ? row.metrics : {};
          const campaignExternalId = cleanId(dimensions.campaign_id);
          const impressions = int(values.impressions);
          const spendText =
            typeof values.spend === "number" ? values.spend.toFixed(6) : (str(values.spend) ?? "0");
          const spend = majorToMinor(spendText, currency);
          if (campaignExternalId === null || impressions === null || spend === null) return [];
          return [
            {
              campaignExternalId,
              impressions,
              reach: int(values.reach),
              clicks: int(values.clicks) ?? 0,
              spend: { minor: spend, currency },
            },
          ];
        }),
        truncated: [campaigns, adGroups, ads, report].some((part) => part.truncated),
      };
    },

    describeLaunch(request: LaunchRequest): readonly ExternalAction[] {
      const { spec } = request;
      const budget = Number(
        formatMajor({ minor: request.budgetTotalMinor, currency: request.currency }),
      );
      // Everything is created disabled: nothing delivers or spends until a person turns it
      // on in TikTok Ads Manager (or a later, separately approved action).
      return [
        {
          method: "POST",
          endpoint: "/open_api/v1.3/campaign/create/",
          params: {
            advertiser_id: request.accountExternalId,
            campaign_name: spec.campaignName,
            objective_type: OBJECTIVE_TO_TIKTOK[spec.objective],
            budget_mode: "BUDGET_MODE_INFINITE",
            operation_status: "DISABLE",
          },
        },
        {
          method: "POST",
          endpoint: "/open_api/v1.3/adgroup/create/",
          params: {
            advertiser_id: request.accountExternalId,
            campaign_id: "{created campaign}",
            adgroup_name: `${spec.campaignName} · ${String(inclusiveDays(request.startDate, request.endDate))}d`,
            placement_type: "PLACEMENT_TYPE_AUTOMATIC",
            budget_mode: "BUDGET_MODE_TOTAL",
            budget,
            schedule_type: "SCHEDULE_START_END",
            schedule_start_time: `${request.startDate} 00:00:00`,
            schedule_end_time: `${request.endDate} 23:59:59`,
            location_ids: spec.audience.countries.map((code) => `{location id of ${code}}`),
            ...(spec.audience.genders === "ALL"
              ? {}
              : { gender: spec.audience.genders === "MALE" ? "GENDER_MALE" : "GENDER_FEMALE" }),
            operation_status: "DISABLE",
          },
        },
        {
          method: "POST",
          endpoint: "/open_api/v1.3/ad/create/",
          params: {
            advertiser_id: request.accountExternalId,
            adgroup_id: "{created ad group}",
            creatives: [
              {
                ad_name: spec.creative.headline,
                ad_text: spec.creative.primaryText,
                call_to_action: spec.creative.callToAction,
                video_or_image:
                  request.media === null ? null : `${request.media.filename} (${request.media.id})`,
              },
            ],
            operation_status: "DISABLE",
          },
        },
      ];
    },
  };
}
