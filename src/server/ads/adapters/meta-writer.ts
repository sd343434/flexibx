import { createHmac } from "node:crypto";

import {
  AdPlatformError,
  type AdWriter,
  type ExecutionStepKey,
  type ExternalState,
  type LaunchRequest,
  type StepContext,
} from "../adapter";
import { currencyDigits, type AdObjective, type AdPlacement } from "../model";

import { metaDeliveryStatus, metaFailure } from "./meta";
import { zonedMidnight } from "./snapchat";

// Meta (Facebook) write path through the Marketing API — called only by the shared
// execution service inside an approved orchestration task.
//
// Creates, in order, every object PAUSED: the image (POST /act_{id}/adimages, multipart),
// the campaign (/act_{id}/campaigns), the ad set (/act_{id}/adsets: lifetime budget in the
// account currency's minor units, schedule, targeting with explicit Facebook placements,
// billing IMPRESSIONS, lowest-cost bidding), the creative (/act_{id}/adcreatives:
// object_story_spec with the chosen Page, link_data with the image hash, link, text and
// call to action) and the ad (/act_{id}/ads with the creative id). Activation (separately
// approved) sets the ad, the ad set and then the campaign to ACTIVE (POST /{id}); Meta then
// reviews the ad (PENDING_REVIEW) before it delivers. Every object's name carries the
// plan's tag, so a write whose outcome is unknown is looked up (by listing its parent's
// children) instead of repeated.
//
// Supported, and refused before any call otherwise:
// - objectives AWARENESS (REACH) and TRAFFIC (LINK_CLICKS) — the only ones whose inputs
//   Flexibx has (no pixel, lead form, app, post or messaging destination);
// - Facebook placements only, always sent explicitly: Meta's default placements include
//   Instagram, and Instagram placements need an Instagram account (`instagram_user_id`)
//   that Flexibx does not select;
// - account currencies whose minor unit is 1/100 and not on Meta's list of currencies
//   with their own offset;
// - one Facebook Page chosen by a person among the Pages the connection may advertise on.

// Permissions: ads_management (campaigns, ad sets, ads); pages_show_list (listing the
// person's Pages and their tasks); pages_manage_ads — Meta's creative guide (Click to
// WhatsApp, "Before you start") requires ads_management and pages_manage_ads and a Page
// access token from a person with the ADVERTISE task on the Page to create a Page-based
// creative. The creative is therefore created with the Page's token, read from
// GET /me/accounts (id, tasks, access_token) right before the write and never stored.
export const META_WRITE_SCOPES = ["ads_management", "pages_show_list", "pages_manage_ads"] as const;
/** Per request. A task's own timeout covers every request it can make (see ad-launch.ts). */
export const META_REQUEST_TIMEOUT_MS = 20_000;

const SUPPORTED: Readonly<Partial<Record<AdObjective, { objective: string; goal: string }>>> = {
  AWARENESS: { objective: "OUTCOME_AWARENESS", goal: "REACH" },
  TRAFFIC: { objective: "OUTCOME_TRAFFIC", goal: "LINK_CLICKS" },
};

/** Facebook placements and their `facebook_positions` value. */
const FACEBOOK_POSITIONS: Readonly<Partial<Record<AdPlacement, string>>> = {
  FACEBOOK_FEED: "feed",
  FACEBOOK_STORIES: "story",
  FACEBOOK_REELS: "facebook_reels",
};
export const META_PLACEMENTS = Object.keys(FACEBOOK_POSITIONS) as AdPlacement[];

/**
 * Currencies whose Meta amounts are NOT in 1/100 units even though ISO 4217 gives them
 * two decimals (or none): their offset differs, so a budget would be off by 100×.
 */
const OWN_OFFSET = new Set([
  "CLP",
  "COP",
  "CRC",
  "HUF",
  "IDR",
  "ISK",
  "JPY",
  "KRW",
  "PYG",
  "TWD",
  "VND",
]);

/**
 * Budgets are sent in the account currency's minor units (cents, halalas, fils of AED…
 * — Meta's budget limits table states amounts in each currency's minor unit). Only
 * two-decimal currencies without their own offset are accepted; the rest are refused
 * before any call rather than risk a budget off by a factor of 10 or 100.
 */
export const metaSupportsCurrency = (currency: string) =>
  currencyDigits(currency) === 2 && !OWN_OFFSET.has(currency.toUpperCase());

/** Explicit Facebook placements only (not AUTOMATIC, not Instagram). */
export const metaSupportsPlacements = (placements: readonly AdPlacement[]) =>
  placements.length > 0 &&
  placements.every((placement) => FACEBOOK_POSITIONS[placement] !== undefined);

/** Whether the Meta write path supports a plan's objective. */
export const metaSupportsObjective = (objective: AdObjective) => SUPPORTED[objective] !== undefined;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const cleanId = (value: unknown): string | null => {
  const id = str(value);
  return id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
};

const addDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The object names carry the plan's tag (≤ 400 characters in total). */
const tagged = (name: string, tag: string) => `${name.slice(0, 360)} [${tag}]`;

export function metaTargeting(request: LaunchRequest): Json {
  const { audience, placements } = request.spec;
  return {
    geo_locations: { countries: [...audience.countries] },
    age_min: audience.ageMin,
    age_max: audience.ageMax,
    ...(audience.genders === "ALL" ? {} : { genders: [audience.genders === "MALE" ? 1 : 2] }),
    // Always explicit: without publisher_platforms Meta uses its defaults, which include
    // Instagram.
    publisher_platforms: ["facebook"],
    facebook_positions: placements.flatMap((placement) => {
      const position = FACEBOOK_POSITIONS[placement];
      return position === undefined ? [] : [position];
    }),
  };
}

/** The exact parameters of each creation step (also shown for approval). */
export function metaStepParams(step: ExecutionStepKey, context: StepContext): Json {
  const { request, tag } = context;
  const { spec } = request;
  const mapping = SUPPORTED[spec.objective];
  if (
    mapping === undefined ||
    !metaSupportsCurrency(request.currency) ||
    !metaSupportsPlacements(spec.placements)
  ) {
    throw new AdPlatformError("invalid_request");
  }
  const zone = request.timeZone ?? null;
  switch (step) {
    case "media":
      return { filename: context.media?.filename ?? null };
    case "campaign":
      return {
        name: tagged(spec.campaignName, tag),
        objective: mapping.objective,
        status: "PAUSED",
        special_ad_categories: [],
        buying_type: "AUCTION",
        // The budget is set on the ad set; ad sets must not borrow from each other, so the
        // approved amount is the most that can be spent. ASSUMPTION: required in v26.0
        // when there is no campaign budget (reported, not in the official reference).
        is_adset_budget_sharing_enabled: false,
      };
    case "adset":
      return {
        name: tagged(spec.campaignName, tag),
        campaign_id: context.ids.campaign ?? "{created campaign}",
        lifetime_budget: request.budgetTotalMinor,
        start_time: zonedMidnight(request.startDate, zone),
        end_time: zonedMidnight(addDay(request.endDate), zone),
        billing_event: "IMPRESSIONS",
        optimization_goal: mapping.goal,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        targeting: {
          ...metaTargeting(request),
          // Deliver to the approved audience only (Advantage+ audience off). ASSUMPTION:
          // the flag's name and values come from Meta's Advantage+ material, not from the
          // ad set reference.
          targeting_automation: { advantage_audience: 0 },
        },
        status: "PAUSED",
      };
    case "creative":
      return {
        name: tagged(spec.creative.headline, tag),
        object_story_spec: {
          page_id: context.identityId,
          link_data: {
            link: spec.creative.destinationUrl ?? null,
            message: spec.creative.primaryText,
            name: spec.creative.headline,
            ...(context.ids.media === undefined ? {} : { image_hash: context.ids.media }),
            call_to_action: {
              type: spec.creative.callToAction,
              value: { link: spec.creative.destinationUrl ?? null },
            },
          },
        },
      };
    case "ad":
      return {
        name: tagged(spec.creative.headline, tag),
        adset_id: context.ids.adset ?? "{created ad set}",
        creative: { creative_id: context.ids.creative ?? "{created creative}" },
        status: "PAUSED",
      };
  }
}

const EDGES: Readonly<Record<Exclude<ExecutionStepKey, "media">, string>> = {
  campaign: "campaigns",
  adset: "adsets",
  creative: "adcreatives",
  ad: "ads",
};

/** Lists are read 100 at a time, up to this many pages (a lookup must see everything). */
const LIST_PAGES = 20;

export function createMetaWriter(config: {
  readonly appSecret: string;
  readonly version: string;
  readonly fetch?: typeof fetch;
}): AdWriter {
  const http = config.fetch ?? fetch;
  const graph = `https://graph.facebook.com/${config.version}`;
  const proof = (token: string) =>
    createHmac("sha256", config.appSecret).update(token).digest("hex");

  async function request(
    method: "GET" | "POST",
    path: string,
    token: string,
    params: Json = {},
    file?: { readonly body: Uint8Array; readonly contentType: string; readonly filename: string },
    signal?: AbortSignal,
  ): Promise<Json> {
    const url = new URL(`${graph}${path}`);
    url.searchParams.set("access_token", token);
    url.searchParams.set("appsecret_proof", proof(token));
    let body: BodyInit | undefined;
    if (method === "GET") {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    } else if (file !== undefined) {
      const form = new FormData();
      form.set(
        "filename",
        new Blob([new Uint8Array(file.body)], { type: file.contentType }),
        file.filename,
      );
      body = form;
    } else {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      body = form;
    }
    let response: Response;
    try {
      response = await http(url, {
        method,
        headers: { accept: "application/json" },
        ...(body === undefined ? {} : { body }),
        signal:
          signal === undefined
            ? AbortSignal.timeout(META_REQUEST_TIMEOUT_MS)
            : AbortSignal.any([AbortSignal.timeout(META_REQUEST_TIMEOUT_MS), signal]),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      // The request may have reached Meta: a write's outcome is unknown.
      throw new AdPlatformError("provider_error", null, method === "POST");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok || (isRecord(json) && isRecord(json.error))) {
      const error = isRecord(json) && isRecord(json.error) ? json.error : {};
      const failure = metaFailure(int(error.code), response.status);
      // A 5xx, an unreadable answer, or Meta's "unknown"/"temporarily unavailable"
      // errors (codes 1 and 2) to a write may still have taken effect.
      const code = int(error.code);
      const uncertain =
        method === "POST" && (response.status >= 500 || json === null || code === 1 || code === 2);
      throw new AdPlatformError(failure.kind, failure.platformCode, uncertain);
    }
    if (!isRecord(json)) throw new AdPlatformError("provider_error", null, method === "POST");
    return json;
  }

  const account = (context: StepContext) => `/act_${context.request.accountExternalId}`;

  /**
   * The chosen Page's access token (transient: used for one write, never stored or logged).
   * Unavailable (no ADVERTISE task, Page gone) → refused before any write.
   */
  async function pageToken(token: string, context: StepContext): Promise<string> {
    const page = cleanId(context.identityId);
    if (page === null) throw new AdPlatformError("invalid_request");
    // /me/accounts returns each Page's id, tasks and Page access token (documented).
    const { items } = await list(
      "/me/accounts",
      token,
      { fields: "id,tasks,access_token" },
      context.signal,
    );
    const found = items.find((item) => item.id === page);
    const tasks = Array.isArray(found?.tasks) ? found.tasks : [];
    const value = str(found?.access_token);
    if (value === null || value === "" || !tasks.includes("ADVERTISE")) {
      throw new AdPlatformError("permission_missing");
    }
    return value;
  }

  /** Every item of a list edge (cursor paging), and whether the end was reached. */
  async function list(
    path: string,
    token: string,
    params: Json,
    signal?: AbortSignal,
  ): Promise<{ items: Json[]; complete: boolean }> {
    const items: Json[] = [];
    let after: string | null = null;
    for (let page = 0; page < LIST_PAGES; page += 1) {
      const body = await request(
        "GET",
        path,
        token,
        { ...params, limit: "100", ...(after === null ? {} : { after }) },
        undefined,
        signal,
      );
      items.push(...(Array.isArray(body.data) ? body.data.filter(isRecord) : []));
      const paging = isRecord(body.paging) ? body.paging : {};
      const cursors = isRecord(paging.cursors) ? paging.cursors : {};
      after = typeof paging.next === "string" ? str(cursors.after) : null;
      if (after === null) return { items, complete: typeof paging.next !== "string" };
    }
    return { items, complete: false };
  }

  return {
    ready: true,
    blocker: null,
    writeScopes: META_WRITE_SCOPES,
    supportsObjective: metaSupportsObjective,
    supportsCurrency: metaSupportsCurrency,
    supportsPlacements: metaSupportsPlacements,
    steps: ["media", "campaign", "adset", "creative", "ad"],

    async listIdentities(token) {
      // The Pages on which the person may advertise (`tasks` contains ADVERTISE). A person
      // chooses one; Flexibx never picks between several.
      const { items, complete } = await list("/me/accounts", token, { fields: "id,name,tasks" });
      const identities = items
        .filter((page) => Array.isArray(page.tasks) && page.tasks.includes("ADVERTISE"))
        .flatMap((page) => {
          const id = cleanId(page.id);
          return id === null ? [] : [{ id, name: (str(page.name) ?? id).slice(0, 200) }];
        });
      return { identities, complete };
    },

    async runStep(token, step, context) {
      if (SUPPORTED[context.request.spec.objective] === undefined) {
        throw new AdPlatformError("invalid_request");
      }
      if (step === "media") {
        if (context.media === null) throw new AdPlatformError("invalid_request");
        const body = await request(
          "POST",
          `${account(context)}/adimages`,
          token,
          {},
          context.media,
          context.signal,
        );
        const images = isRecord(body.images) ? Object.values(body.images).filter(isRecord) : [];
        const hash = cleanId(images[0]?.hash);
        if (hash === null) throw new AdPlatformError("provider_error", null, true);
        return hash;
      }
      // The creative is created with the Page's own token (documented prerequisite); a
      // Page token that cannot be read means nothing was sent.
      const writeToken = step === "creative" ? await pageToken(token, context) : token;
      const body = await request(
        "POST",
        `${account(context)}/${EDGES[step]}`,
        writeToken,
        metaStepParams(step, context),
        undefined,
        context.signal,
      );
      const id = cleanId(body.id);
      if (id === null) throw new AdPlatformError("provider_error", null, true);
      return id;
    },

    async findStep(token, step, context) {
      // Re-uploading the same image is harmless (same hash): never "found".
      if (step === "media") return null;
      // The object's parent lists its children (documented edges): the campaign's ad sets,
      // the ad set's ads; campaigns and creatives are listed on the ad account. The whole
      // list is read and names are matched here; "not found" is returned only after every
      // page was seen — otherwise the lookup fails and the executor stops with "outcome
      // unknown" instead of writing again.
      const parent =
        step === "adset"
          ? context.ids.campaign
          : step === "ad"
            ? context.ids.adset
            : `act_${context.request.accountExternalId}`;
      if (parent === undefined) throw new AdPlatformError("invalid_request");
      const { items, complete } = await list(
        `/${parent}/${EDGES[step]}`,
        token,
        { fields: "id,name" },
        context.signal,
      );
      const match = items.find((item) => (str(item.name) ?? "").includes(`[${context.tag}]`));
      if (match !== undefined) return cleanId(match.id);
      if (!complete) throw new AdPlatformError("provider_error");
      return null;
    },

    async activate(token, _request, ids, signal) {
      // Children first: nothing delivers until the campaign itself is on.
      for (const id of [ids.ad, ids.adset, ids.campaign]) {
        if (id === undefined) throw new AdPlatformError("invalid_request");
        await request("POST", `/${id}`, token, { status: "ACTIVE" }, undefined, signal);
      }
    },

    async readState(token, ids, signal): Promise<ExternalState> {
      const status = async (id: string | undefined) =>
        id === undefined
          ? null
          : metaDeliveryStatus(
              (
                await request(
                  "GET",
                  `/${id}`,
                  token,
                  { fields: "effective_status" },
                  undefined,
                  signal,
                )
              ).effective_status,
            );
      return {
        campaign: (await status(ids.campaign)) ?? "OTHER",
        adSet: await status(ids.adset),
        ad: await status(ids.ad),
      };
    },
  };
}
