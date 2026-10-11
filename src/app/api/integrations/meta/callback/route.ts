import { platformCallbackRoute } from "@/server/ads/oauth-callback";

export const dynamic = "force-dynamic";

/** GET /api/integrations/meta/callback — Meta's consent screen returns here. */
export const GET = platformCallbackRoute("META", "ads.meta.callback");
