import { z } from "zod";

import { withRoute } from "@/server/http/route-handler";
import { getVideoFile } from "@/server/videos/video-queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/w/{slug}/videos/{videoId}?file=video|thumbnail — download a generated video
 * (or its thumbnail) for members with content.view, only until it expires: after the
 * 7-day retention period it is a 404 even before the retention job deletes the file.
 */
export const GET = withRoute({
  name: "videos.download",
  params: z.strictObject({ workspaceSlug: z.string().min(1).max(100), videoId: z.uuid() }),
  query: z.strictObject({ file: z.enum(["video", "thumbnail"]).default("video") }),
  handler: async ({ params, query }) => {
    const kind = query.file === "thumbnail" ? "THUMBNAIL" : "VIDEO";
    const file = await getVideoFile(params.workspaceSlug, params.videoId, kind);
    return new Response(Buffer.from(file.body), {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.body.byteLength),
        "content-disposition": `${kind === "VIDEO" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
        vary: "Cookie",
      },
    });
  },
});
