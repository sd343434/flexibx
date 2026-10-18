import "server-only";

import { adTokenKey, getAdAdapters } from "../ads/registry";
import { getAdsEnv } from "../env";
import { getDb } from "../db/client";
import { metaSocialFromEnv } from "../social/social-runtime";

import type { InsightsDeps } from "./insights-sync";
import { createMetaInsightsClient, type MetaInsightsClient } from "./meta-insights";

// This deployment's Meta Insights wiring. The client exists only when the Meta app is
// configured AND META_INSIGHTS_ENABLED=true; otherwise every insights surface says
// "not configured" — nothing is simulated in its place.

export function metaInsightsClientFromEnv(): MetaInsightsClient | null {
  const env = getAdsEnv();
  if (env.META_INSIGHTS_ENABLED !== "true") return null;
  if (env.META_APP_ID === undefined || env.META_APP_SECRET === undefined) return null;
  return createMetaInsightsClient({
    appSecret: env.META_APP_SECRET,
    version: env.META_GRAPH_VERSION,
  });
}

export function getInsightsDeps(): InsightsDeps {
  const db = getDb();
  return {
    db,
    ads: { db, adapters: getAdAdapters(), tokenKey: adTokenKey() },
    meta: metaSocialFromEnv(),
    client: metaInsightsClientFromEnv(),
  };
}
