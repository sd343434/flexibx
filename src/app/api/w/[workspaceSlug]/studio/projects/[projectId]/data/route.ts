import { z } from "zod";

import { projectData } from "@/server/creator/creator-files";
import { withRoute } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/**
 * GET /api/w/{slug}/studio/projects/{projectId}/data — the project's data as a JSON file
 * (transcripts, translations, clips, exports, history), for members with content.edit.
 * Another workspace's project is a 404.
 */
export const GET = withRoute({
  name: "studio.project_data",
  params: z.strictObject({ workspaceSlug: z.string().min(1).max(100), projectId: z.uuid() }),
  handler: async ({ params }) => {
    const data = await projectData(params.workspaceSlug, params.projectId);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="creator-project-${params.projectId}.json"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        vary: "Cookie",
      },
    });
  },
});
