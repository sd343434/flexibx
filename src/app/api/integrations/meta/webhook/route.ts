import { after } from "next/server";

import { readBodyCapped } from "@/server/http/read-body";

import {
  answerSocialVerification,
  draftCreated,
  getSocialDeps,
  handleSocialNotification,
  MAX_SOCIAL_WEBHOOK_BYTES,
} from "@/server/social/social-runtime";

export const dynamic = "force-dynamic";

const reply = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/** GET /api/integrations/meta/webhook — Meta's subscription check (hub.challenge). */
export function GET(request: Request): Response {
  const answer = answerSocialVerification(new URL(request.url).searchParams);
  return reply(answer.status, answer.body);
}

/**
 * POST /api/integrations/meta/webhook — signed Page and Instagram notifications (new
 * comments and messages). Answered at once; the AI agents draft replies afterwards (the
 * scheduler tick picks up anything not drafted).
 */
export async function POST(request: Request): Promise<Response> {
  // The size cap applies while the body streams in (chunked bodies have no length header).
  const body = await readBodyCapped(request, MAX_SOCIAL_WEBHOOK_BYTES);
  if (!body.ok) {
    return body.reason === "too_large" ? reply(413, "too large") : reply(400, "unreadable body");
  }
  const result = await handleSocialNotification(
    body.bytes,
    request.headers.get("x-hub-signature-256"),
  );
  if (result.created.length > 0) {
    after(() => draftCreated(getSocialDeps(), result.created));
  }
  return reply(result.status, result.body);
}
