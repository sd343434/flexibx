import "server-only";

import { z } from "zod";

import { getCurrentUser } from "../auth/session";
import { getEnv } from "../env";
import { withRoute } from "../http/route-handler";

import { completePlatformCallback } from "./connections";
import type { AdPlatform } from "./model";

const param = z.string().max(4096).optional();

/**
 * A plain 303 (mutable headers, unlike Response.redirect, so the route wrapper can add its
 * own); the callback URL carries a code and state, so it is never sent on as a referrer.
 */
function seeOther(location: URL): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: location.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * GET /api/integrations/{platform}/callback — where a platform's consent screen returns.
 * The `state` must be one this person started for this platform in this workspace
 * (single use, 10 minutes); only then is the `code` exchanged server-to-server and the
 * credential stored encrypted. The person is sent back to the workspace's Integrations
 * page with an outcome code (never the code, state or token in the URL).
 */
export function platformCallbackRoute(platform: AdPlatform, name: string) {
  return withRoute({
    name,
    // TikTok returns the code as `auth_code`; the others as `code`.
    query: z.object({ code: param, auth_code: param, state: param, error: param }),
    handler: async ({ query }) => {
      const appUrl = getEnv().APP_URL;
      const user = await getCurrentUser();
      if (user === null) return seeOther(new URL("/ar/sign-in", appUrl));
      const result = await completePlatformCallback(platform, {
        sessionUserId: user.id,
        state: query.state ?? null,
        code: query.auth_code ?? query.code ?? null,
        error: query.error ?? null,
      });
      const target =
        result.slug === null
          ? new URL(`/${result.locale}/workspaces`, appUrl)
          : new URL(`/${result.locale}/w/${encodeURIComponent(result.slug)}/integrations`, appUrl);
      target.searchParams.set("connect", result.outcome);
      return seeOther(target);
    },
  });
}
