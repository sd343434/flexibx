import { AdPlatformError, inclusiveDays, type AdWriter, type StepContext } from "../adapter";
import { minorToMicro, type AdObjective } from "../model";
import { formatMajor } from "../planner-math";

// Snapchat and TikTok write boundaries. They are deliberately NOT ready: the shared
// execution service refuses a writer that is not ready before making any call, and the
// review shows the blocker. What is known (verified against official documentation) is
// written down as request builders so the remaining work is precise:
//
// Snapchat (developers.snap.com): campaigns POST /v1/adaccounts/{id}/campaigns; ad squads
// POST /v1/campaigns/{id}/adsquads (required: campaign_id, name, type, status, targeting,
// placement_v2, billing_event IMPRESSION, optimization_goal, bid_micro / bid_strategy);
// media: create the entity, then upload the file; creatives (SNAP_AD with
// top_snap_media_id, headline, profile_properties.profile_id); ads POST
// /v1/adsquads/{id}/ads with ad_squad_id, creative_id, status. Blocked on: resolving the
// advertiser's Public Profile id (required by creatives) and the exact update (PUT)
// semantics for activation — neither could be verified.
//
// TikTok (business-api.tiktok.com): /campaign/create/, /adgroup/create/ (advertiser_id,
// campaign_id, adgroup_name, placement_type, …), image upload /file/image/ad/upload/
// (image_signature = MD5 when uploading a file). Blocked on: the identity (identity_id /
// identity_type) an ad must be published with, the /ad/create/ creative fields and the
// operation-status update endpoint — not verified.

const blocked = (): never => {
  throw new AdPlatformError("unavailable");
};

const SNAP_OBJECTIVE: Readonly<Record<AdObjective, string>> = {
  AWARENESS: "AWARENESS_AND_ENGAGEMENT",
  ENGAGEMENT: "AWARENESS_AND_ENGAGEMENT",
  MESSAGES: "AWARENESS_AND_ENGAGEMENT",
  TRAFFIC: "TRAFFIC",
  LEADS: "LEADS",
  SALES: "SALES",
  APP_PROMOTION: "APP_PROMOTION",
};

/** The verified part of a Snapchat paused campaign (campaign + ad squad bodies). */
export function snapchatCreationBodies(context: StepContext) {
  const { request, tag } = context;
  const { spec } = request;
  return {
    campaign: {
      campaigns: [
        {
          name: `${spec.campaignName.slice(0, 360)} [${tag}]`,
          ad_account_id: request.accountExternalId,
          status: "PAUSED",
          objective_v2_properties: { objective_v2_type: SNAP_OBJECTIVE[spec.objective] },
          start_time: request.startDate,
        },
      ],
    },
    adsquad: {
      adsquads: [
        {
          name: `${spec.campaignName.slice(0, 340)} · ${String(inclusiveDays(request.startDate, request.endDate))}d [${tag}]`,
          campaign_id: context.ids.campaign ?? "{created campaign}",
          type: "SNAP_ADS",
          status: "PAUSED",
          billing_event: "IMPRESSION",
          placement_v2: { config: "AUTOMATIC" },
          lifetime_budget_micro: minorToMicro(request.budgetTotalMinor, request.currency),
          targeting: {
            geos: spec.audience.countries.map((code) => ({ country_code: code.toLowerCase() })),
            demographics: [
              {
                min_age: String(spec.audience.ageMin),
                max_age: String(spec.audience.ageMax),
                ...(spec.audience.genders === "ALL" ? {} : { gender: spec.audience.genders }),
              },
            ],
          },
        },
      ],
    },
  };
}

/** The verified part of a TikTok paused campaign (campaign + ad group bodies). */
export function tiktokCreationBodies(context: StepContext) {
  const { request, tag } = context;
  return {
    campaign: {
      advertiser_id: request.accountExternalId,
      campaign_name: `${request.spec.campaignName.slice(0, 340)} [${tag}]`,
      budget_mode: "BUDGET_MODE_INFINITE",
      operation_status: "DISABLE",
    },
    adgroup: {
      advertiser_id: request.accountExternalId,
      campaign_id: context.ids.campaign ?? "{created campaign}",
      adgroup_name: `${request.spec.campaignName.slice(0, 340)} [${tag}]`,
      placement_type: "PLACEMENT_TYPE_AUTOMATIC",
      budget_mode: "BUDGET_MODE_TOTAL",
      budget: Number(formatMajor({ minor: request.budgetTotalMinor, currency: request.currency })),
      operation_status: "DISABLE",
    },
  };
}

function blockedWriter(
  blocker: string,
  steps: AdWriter["steps"],
  writeScopes: readonly string[],
): AdWriter {
  return {
    ready: false,
    blocker,
    writeScopes,
    supportsObjective: () => false,
    supportsCurrency: () => false,
    supportsPlacements: () => false,
    steps,
    listIdentities: () => Promise.reject(new AdPlatformError("unavailable")),
    runStep: () => Promise.resolve(blocked()),
    findStep: () => Promise.resolve(blocked()),
    activate: () => Promise.resolve(blocked()),
    readState: () => Promise.resolve(blocked()),
  };
}

export const createSnapchatWriter = () =>
  blockedWriter(
    "snapchat_profile_and_update_unverified",
    ["media", "campaign", "adset", "creative", "ad"],
    ["snapchat-marketing-api"],
  );

export const createTikTokWriter = () =>
  blockedWriter(
    "tiktok_identity_and_ad_fields_unverified",
    ["media", "campaign", "adset", "creative", "ad"],
    [],
  );
