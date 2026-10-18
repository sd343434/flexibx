import { z } from "zod";

import { exportDownload } from "@/server/creator/creator-files";
import { withRoute } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/**
 * GET /api/w/{slug}/studio/exports/{exportId} — a rendered clip, for members with
 * content.view: a redirect to a signed link valid for two minutes (private bucket), or
 * the bytes when storage has no links (tests). Another workspace's export is a 404.
 */
export const GET = withRoute({
  name: "studio.export_download",
  params: z.strictObject({ workspaceSlug: z.string().min(1).max(100), exportId: z.uuid() }),
  handler: async ({ params }) => {
    const file = await exportDownload(params.workspaceSlug, params.exportId);
    if ("redirect" in file) {
      return new Response(null, {
        status: 303,
        headers: {
          location: file.redirect,
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    return new Response(Buffer.from(file.body), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(file.body.byteLength),
        "content-disposition": `attachment; filename="clip-${params.exportId}.mp4"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
        vary: "Cookie",
      },
    });
  },
});
