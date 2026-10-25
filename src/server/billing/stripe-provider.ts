import "server-only";

import Stripe from "stripe";
import { z } from "zod";

import {
  WebhookPayloadError,
  WebhookSignatureError,
  type CheckoutProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type CheckoutSnapshot,
  type ProviderEvent,
} from "./payments";

// The Stripe Checkout adapter — TEST MODE ONLY (STRIPE_SANDBOX.md). The configuration is
// validated before this is constructed (env-schema.ts: sk_test_/rk_test_ keys only), and
// every object Stripe returns is checked again here: anything in live mode is refused.
// Nothing here logs; errors carry no key, signature or card data.

/** Webhook signatures older than this (seconds) are refused (replay window). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
}

// Only the fields Flexibx reads, validated at runtime (the SDK's types describe every Stripe
// object; we trust none of them beyond what is checked here).
const metadataSchema = z.record(z.string(), z.string()).nullish();
const idOf = z.union([z.string(), z.object({ id: z.string() }).transform((value) => value.id)]);

const sessionSchema = z.object({
  id: z.string().min(1).max(255),
  payment_intent: idOf.nullish(),
  status: z.string().nullish(),
  payment_status: z.string(),
  amount_total: z.number().int().nullish(),
  currency: z.string().nullish(),
  client_reference_id: z.string().nullish(),
  metadata: metadataSchema,
  livemode: z.boolean(),
});

const paymentIntentSchema = z.object({
  id: z.string().min(1).max(255),
  metadata: metadataSchema,
  last_payment_error: z
    .object({ code: z.string().nullish(), decline_code: z.string().nullish() })
    .nullish(),
});

const chargeSchema = z.object({
  payment_intent: idOf.nullish(),
  amount_refunded: z.number().int().nonnegative(),
  currency: z.string(),
});

const disputeSchema = z.object({ payment_intent: idOf.nullish(), status: z.string() });

/** A verified event, as far as we read it. */
export interface VerifiedStripeEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly data: { readonly object: unknown };
}

export function snapshotOf(raw: unknown): CheckoutSnapshot {
  const session = sessionSchema.parse(raw);
  return {
    checkoutId: session.id,
    paymentId: session.payment_intent ?? null,
    status: session.status ?? "unknown",
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
    clientReferenceId: session.client_reference_id ?? null,
    metadata: { ...(session.metadata ?? {}) },
    livemode: session.livemode,
  };
}

const CHECKOUT_KINDS: Readonly<
  Record<
    string,
    "checkout_completed" | "checkout_async_succeeded" | "checkout_async_failed" | "checkout_expired"
  >
> = {
  "checkout.session.completed": "checkout_completed",
  "checkout.session.async_payment_succeeded": "checkout_async_succeeded",
  "checkout.session.async_payment_failed": "checkout_async_failed",
  "checkout.session.expired": "checkout_expired",
};

/**
 * Reduces a verified Stripe event to what Flexibx acts on. An event of a type we act on
 * whose object does not have the expected shape throws (the webhook answers 400).
 */
export function mapStripeEvent(event: VerifiedStripeEvent): ProviderEvent {
  const base = { id: event.id, type: event.type, livemode: event.livemode };
  const object = event.data.object;
  const checkoutKind = CHECKOUT_KINDS[event.type];
  if (checkoutKind !== undefined) {
    return { ...base, kind: checkoutKind, checkout: snapshotOf(object) };
  }
  if (event.type === "payment_intent.payment_failed") {
    const intent = paymentIntentSchema.parse(object);
    const error = intent.last_payment_error;
    return {
      ...base,
      kind: "payment_failed",
      paymentId: intent.id,
      failureCode: error?.decline_code ?? error?.code ?? null,
      metadata: { ...(intent.metadata ?? {}) },
    };
  }
  if (event.type === "charge.refunded") {
    const charge = chargeSchema.parse(object);
    if (charge.payment_intent === null || charge.payment_intent === undefined) {
      return { ...base, kind: "ignored" };
    }
    return {
      ...base,
      kind: "refund",
      paymentId: charge.payment_intent,
      amountRefunded: charge.amount_refunded,
      currency: charge.currency,
    };
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    const dispute = disputeSchema.parse(object);
    if (dispute.payment_intent === null || dispute.payment_intent === undefined) {
      return { ...base, kind: "ignored" };
    }
    return {
      ...base,
      kind: event.type === "charge.dispute.created" ? "dispute_opened" : "dispute_closed",
      paymentId: dispute.payment_intent,
      disputeStatus: dispute.status,
    };
  }
  return { ...base, kind: "ignored" };
}

/** Builds the adapter. `client` is injectable for tests (no network). */
export function createStripeCheckoutProvider(
  config: StripeConfig,
  client: Stripe = new Stripe(config.secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: "flexibx" },
  }),
): CheckoutProvider {
  return {
    name: "stripe",

    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const metadata = {
        intent_id: request.intentId,
        workspace_id: request.workspaceId,
        package_id: request.packageId,
      };
      const session = await client.checkout.sessions.create(
        {
          mode: "payment",
          client_reference_id: request.intentId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: request.currency,
                unit_amount: request.amountMinor,
                product_data: { name: `${String(request.credits)} Flexibx credits` },
              },
            },
          ],
          metadata,
          payment_intent_data: { metadata },
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
        },
        // One checkout per intent, even if this call is retried after a lost answer.
        { idempotencyKey: `flexibx-checkout:${request.intentId}` },
      );
      if (session.livemode) throw new Error("Stripe returned a live-mode checkout session");
      if (session.amount_total !== request.amountMinor || session.currency !== request.currency) {
        throw new Error("Stripe checkout session does not match the requested amount");
      }
      const url = session.url ?? "";
      if (!/^https:\/\/[a-z0-9.-]+\.stripe\.com\//.test(url)) {
        throw new Error("Stripe checkout session has no hosted page URL");
      }
      return {
        checkoutId: session.id,
        redirectUrl: url,
        expiresAt: new Date(session.expires_at * 1000),
      };
    },

    verifyWebhook(rawBody: Uint8Array, signatureHeader: string | null): ProviderEvent {
      if (signatureHeader === null || signatureHeader === "") throw new WebhookSignatureError();
      let event: VerifiedStripeEvent;
      try {
        // The exact bytes received: nothing is parsed or re-serialized before this check.
        event = client.webhooks.constructEvent(
          rawBody,
          signatureHeader,
          config.webhookSecret,
          WEBHOOK_TOLERANCE_SECONDS,
        );
      } catch {
        throw new WebhookSignatureError();
      }
      try {
        return mapStripeEvent(event);
      } catch {
        // Verified, but not the shape we expect for a type we act on.
        throw new WebhookPayloadError();
      }
    },

    async getCheckout(checkoutId: string): Promise<CheckoutSnapshot> {
      return snapshotOf(await client.checkout.sessions.retrieve(checkoutId));
    },
  };
}
