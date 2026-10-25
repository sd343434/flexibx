import { handleStripeWebhook, MAX_STRIPE_WEBHOOK_BYTES } from "@/server/billing/checkout-runtime";
import { readBodyCapped } from "@/server/http/read-body";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/webhook/stripe — Stripe events (test mode only). The body is read as
 * raw bytes (never parsed before the signature check) under a size cap.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readBodyCapped(request, MAX_STRIPE_WEBHOOK_BYTES);
  const reply = !body.ok
    ? body.reason === "too_large"
      ? { status: 413, body: "too large" }
      : { status: 400, body: "unreadable body" }
    : await handleStripeWebhook(body.bytes, request.headers.get("stripe-signature"));
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
