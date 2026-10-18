import { z } from "zod";

import { receiveTestPart } from "@/server/creator/creator-files";
import { withRoute } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/**
 * PUT /api/w/{slug}/studio/uploads/{sourceId}/parts/{n} — one part of a resumable upload,
 * for the in-memory test store only (STORAGE_DRIVER=test-memory; a 404 everywhere else,
 * where the browser PUTs each part straight to object storage with a signed URL).
 */
export const PUT = withRoute({
  name: "studio.upload_part",
  params: z.strictObject({
    workspaceSlug: z.string().min(1).max(100),
    sourceId: z.uuid(),
    partNumber: z.coerce.number().int().min(1).max(10_000),
  }),
  handler: async ({ params, request }) => {
    const etag = await receiveTestPart(
      params.workspaceSlug,
      params.sourceId,
      params.partNumber,
      request,
    );
    return new Response(null, { status: 200, headers: { etag, "cache-control": "no-store" } });
  },
});
