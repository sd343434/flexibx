import { platformCallbackRoute } from "@/server/ads/oauth-callback";

export const dynamic = "force-dynamic";

/** GET /api/integrations/whatsapp/callback — Embedded Signup (Facebook Login for Business) returns here. */
export const GET = platformCallbackRoute("WHATSAPP", "ads.whatsapp.callback");
