import { z } from "zod";

import { transcriptSubtitles } from "@/server/creator/creator-files";
import { withRoute } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/** GET /api/w/{slug}/studio/transcripts/{id}?format=srt|vtt — a subtitle file. */
export const GET = withRoute({
  name: "studio.subtitles",
  params: z.strictObject({ workspaceSlug: z.string().min(1).max(100), transcriptId: z.uuid() }),
  query: z.strictObject({ format: z.enum(["srt", "vtt"]).default("vtt") }),
  handler: async ({ params, query }) => {
    const file = await transcriptSubtitles(params.workspaceSlug, params.transcriptId, query.format);
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type":
          query.format === "vtt"
            ? "text/vtt; charset=utf-8"
            : "application/x-subrip; charset=utf-8",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        vary: "Cookie",
      },
    });
  },
});
