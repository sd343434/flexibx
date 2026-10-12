import { handleMetaUserCallback } from "@/server/ads/meta-deauthorization";

export const dynamic = "force-dynamic";

/** A signed_request is well under 4 KB; anything larger is refused before parsing. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * POST /api/integrations/meta/deauthorize — Meta calls this when a person removes the app in their Facebook settings ("Deauthorize callback URL" in the Meta app dashboard).
 * The form field `signed_request` is verified with the app secret before anything is read.
 */
export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const reply = await handleMetaUserCallback(
    "deauthorize",
    new URLSearchParams(text).get("signed_request"),
  );
  const headers = { "cache-control": "no-store" };
  return reply.body === null
    ? new Response(null, { status: reply.status, headers })
    : Response.json(reply.body, { status: reply.status, headers });
}
