import { readBodyCapped } from "@/server/http/read-body";
import { MAX_WEBHOOK_BYTES } from "@/server/whatsapp/webhook";
import {
  answerVerification,
  handleNotification,
  type WebhookReply,
} from "@/server/whatsapp/webhook-handler";

export const dynamic = "force-dynamic";

const reply = ({ status, body }: WebhookReply) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/** GET /api/integrations/whatsapp/webhook — Meta's subscription check (hub.challenge). */
export function GET(request: Request): Response {
  return reply(answerVerification(new URL(request.url).searchParams));
}

/** POST /api/integrations/whatsapp/webhook — signed WhatsApp notifications. */
export async function POST(request: Request): Promise<Response> {
  // The size cap applies while the body streams in (chunked bodies have no length header).
  const body = await readBodyCapped(request, MAX_WEBHOOK_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? reply({ status: 413, body: "too large" })
      : reply({ status: 400, body: "unreadable body" });
  }
  return reply(await handleNotification(body.bytes, request.headers.get("x-hub-signature-256")));
}
