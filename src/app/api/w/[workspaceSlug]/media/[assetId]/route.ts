import { z } from "zod";

import { withRoute } from "@/server/http/route-handler";
import { getMediaObject } from "@/server/marketing/marketing-queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/w/{slug}/media/{assetId} — the bytes of one workspace image, for members with
 * content.view. The asset is looked up inside the workspace resolved from the session's
 * membership (another workspace's asset id is a 404), and served with its stored, sniffed
 * content type, `nosniff`, a sandboxing CSP and private caching only.
 */
export const GET = withRoute({
  name: "media.get",
  params: z.strictObject({ workspaceSlug: z.string().min(1).max(100), assetId: z.uuid() }),
  handler: async ({ params }) => {
    const media = await getMediaObject(params.workspaceSlug, params.assetId);
    return new Response(Buffer.from(media.body), {
      status: 200,
      headers: {
        "content-type": media.contentType,
        "content-length": String(media.body.byteLength),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
        vary: "Cookie",
      },
    });
  },
});
