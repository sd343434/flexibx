import "server-only";

import { getDb } from "../db/client";
import { EnvValidationError } from "../env-schema";
import { getPaymentsEnv } from "../env";
import { logger } from "../logger";
import { alert } from "../monitoring/alerts";

import { processProviderEvent, sha256Hex } from "./checkout-service";
import { creditsSettingsFromEnv } from "./config";
import { WebhookSignatureError, type CheckoutProvider } from "./payments";
import { createStripeCheckoutProvider } from "./stripe-provider";

// This deployment's card checkout (Stripe, TEST MODE ONLY) and its webhook endpoint logic.
// Fails closed: with no configuration checkout is off; with an invalid one (a live key,
// STRIPE_MODE other than test, a missing secret) nothing payment-related runs.

/** Raw webhook bodies above this are refused before verification (Stripe events are small). */
export const MAX_STRIPE_WEBHOOK_BYTES = 256 * 1024;

let cached: { readonly provider: CheckoutProvider | null } | undefined;

/**
 * The checkout provider, or null when card payments are not configured. Throws
 * EnvValidationError when the configuration is invalid (e.g. a live key).
 */
export function getCheckoutProvider(): CheckoutProvider | null {
  if (cached === undefined) {
    const { stripe } = getPaymentsEnv();
    cached = { provider: stripe === null ? null : createStripeCheckoutProvider(stripe) };
  }
  return cached.provider;
}

export interface WebhookReply {
  readonly status: number;
  readonly body: string;
}

/**
 * POST /api/payments/webhook/stripe. The signature is checked on the exact bytes received
 * before anything is parsed. 200 only after the event's transaction committed; 5xx when
 * it did not (Stripe retries); 400 for a body that does not verify. Bodies, signatures
 * and keys are never logged.
 */
export async function handleStripeWebhook(
  raw: Uint8Array,
  signature: string | null,
): Promise<WebhookReply> {
  let provider: CheckoutProvider | null;
  try {
    provider = getCheckoutProvider();
  } catch (error) {
    logger.error(
      { route: "payments.webhook", invalidConfig: error instanceof EnvValidationError },
      "Stripe webhook refused: payment configuration invalid",
    );
    return { status: 503, body: "not configured" };
  }
  if (provider === null) return { status: 503, body: "not configured" };
  if (raw.byteLength > MAX_STRIPE_WEBHOOK_BYTES) return { status: 413, body: "too large" };

  let event;
  try {
    event = provider.verifyWebhook(raw, signature);
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      logger.warn({ route: "payments.webhook" }, "Stripe webhook signature rejected");
      return { status: 400, body: "invalid signature" };
    }
    logger.warn({ route: "payments.webhook" }, "Stripe webhook payload rejected");
    return { status: 400, body: "invalid payload" };
  }

  let result;
  try {
    result = await processProviderEvent(getDb(), event, sha256Hex(raw), creditsSettingsFromEnv());
  } catch (error) {
    logger.error(
      { route: "payments.webhook", err: error, eventType: event.type },
      "Stripe webhook processing failed; the event will be retried",
    );
    return { status: 500, body: "retry" };
  }
  logger.info(
    { route: "payments.webhook", eventType: event.type, outcome: result.outcome },
    "Stripe webhook processed",
  );
  if (result.alert) {
    await alert({
      key: `payments_${result.outcome}`,
      severity: "critical",
      title: "Card payment needs review",
      details: { outcome: result.outcome, eventType: event.type },
    });
  }
  return { status: 200, body: "ok" };
}
