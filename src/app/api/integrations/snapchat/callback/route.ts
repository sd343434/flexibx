import { platformCallbackRoute } from "@/server/ads/oauth-callback";

export const dynamic = "force-dynamic";

/** GET /api/integrations/snapchat/callback — Snap's consent screen returns here. */
export const GET = platformCallbackRoute("SNAPCHAT", "ads.snapchat.callback");
