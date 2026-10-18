import { z } from "zod";

import { receiveTestUpload } from "@/server/creator/creator-files";
import { withRoute } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/**
 * PUT /api/w/{slug}/studio/uploads/{sourceId} — the upload transport of the in-memory
 * test store only (STORAGE_DRIVER=test-memory; a 404 everywhere else, where the browser
 * uploads straight to object storage with a signed URL).
 */
export const PUT = withRoute({
  name: "studio.upload",
  params: z.strictObject({ workspaceSlug: z.string().min(1).max(100), sourceId: z.uuid() }),
  handler: async ({ params, request }) => {
    await receiveTestUpload(params.workspaceSlug, params.sourceId, request);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
});
