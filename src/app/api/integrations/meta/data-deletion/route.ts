import { handleMetaUserCallback } from "@/server/ads/meta-deauthorization";

export const dynamic = "force-dynamic";

/** A signed_request is well under 4 KB; anything larger is refused before parsing. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * POST /api/integrations/meta/data-deletion — Meta calls this when a person asks for their data to be deleted ("Data deletion request URL"). Answers with the status page URL and a confirmation code.
 * The form field `signed_request` is verified with the app secret before anything is read.
 */
export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const reply = await handleMetaUserCallback(
    "data_deletion",
    new URLSearchParams(text).get("signed_request"),
  );
  const headers = { "cache-control": "no-store" };
  return reply.body === null
    ? new Response(null, { status: reply.status, headers })
    : Response.json(reply.body, { status: reply.status, headers });
}
