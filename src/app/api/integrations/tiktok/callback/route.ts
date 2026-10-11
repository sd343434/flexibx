import { platformCallbackRoute } from "@/server/ads/oauth-callback";

export const dynamic = "force-dynamic";

/** GET /api/integrations/tiktok/callback — TikTok's advertiser authorization returns here. */
export const GET = platformCallbackRoute("TIKTOK", "ads.tiktok.callback");
