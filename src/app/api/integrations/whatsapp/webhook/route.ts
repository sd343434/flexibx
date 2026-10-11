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
  if (Number(request.headers.get("content-length") ?? "0") > MAX_WEBHOOK_BYTES) {
    return reply({ status: 413, body: "too large" });
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  return reply(await handleNotification(raw, request.headers.get("x-hub-signature-256")));
}
