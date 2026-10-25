// The payment provider boundary for buying credits. Pure (no `server-only`) for tests.
//
// Two separate capabilities:
// - `PaymentProvider.charge()`: charging a saved payment method (automatic top-up).
//   STATUS: none configured — `getPaymentProvider()` returns null, so automatic top-up
//   stays off.
// - `CheckoutProvider`: a hosted checkout page the customer pays on, and the provider's
//   signed webhook events (STRIPE_SANDBOX.md). Stripe in TEST MODE only
//   (stripe-provider.ts, wired in checkout-runtime.ts). Credits are granted only from a
//   verified event (checkout-service.ts), never from the browser's return to the app.

export type ChargeResult =
  | { readonly status: "succeeded"; readonly reference: string }
  | { readonly status: "failed"; readonly code: string };

export interface PaymentProvider {
  readonly name: string;
  /** Charges the workspace's saved payment method for `credits` credits. */
  charge(input: {
    readonly workspaceId: string;
    readonly credits: number;
    readonly idempotencyKey: string;
  }): Promise<ChargeResult>;
}

/** This deployment's saved-method payment provider: none yet. */
export function getPaymentProvider(): PaymentProvider | null {
  return null;
}

// ── Hosted checkout ─────────────────────────────────────────────────────────────

export interface CheckoutRequest {
  /** Our payment intent id: the provider's idempotency key and the session's reference. */
  readonly intentId: string;
  readonly workspaceId: string;
  readonly packageId: string;
  readonly credits: number;
  readonly amountMinor: number;
  readonly currency: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface CheckoutSession {
  readonly checkoutId: string;
  /** The provider's hosted page (https). */
  readonly redirectUrl: string;
  readonly expiresAt: Date | null;
}

/**
 * A checkout session as the provider reports it (in a verified event or a server-side
 * lookup). `metadata` is what WE attached when creating it — checked against our intent,
 * never trusted on its own.
 */
export interface CheckoutSnapshot {
  readonly checkoutId: string;
  readonly paymentId: string | null;
  /** complete | open | expired */
  readonly status: string;
  /** paid | unpaid | no_payment_required */
  readonly paymentStatus: string;
  readonly amountTotal: number | null;
  readonly currency: string | null;
  readonly clientReferenceId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly livemode: boolean;
}

/** A provider event after signature verification, reduced to what we act on. */
export type ProviderEvent =
  | {
      readonly kind:
        | "checkout_completed"
        | "checkout_async_succeeded"
        | "checkout_async_failed"
        | "checkout_expired";
      readonly id: string;
      readonly type: string;
      readonly livemode: boolean;
      readonly checkout: CheckoutSnapshot;
    }
  | {
      readonly kind: "payment_failed";
      readonly id: string;
      readonly type: string;
      readonly livemode: boolean;
      readonly paymentId: string;
      readonly failureCode: string | null;
      readonly metadata: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "refund";
      readonly id: string;
      readonly type: string;
      readonly livemode: boolean;
      readonly paymentId: string;
      /** Total refunded on the payment so far (minor units), and its currency. */
      readonly amountRefunded: number;
      readonly currency: string;
    }
  | {
      readonly kind: "dispute_opened" | "dispute_closed";
      readonly id: string;
      readonly type: string;
      readonly livemode: boolean;
      readonly paymentId: string;
      /** For a closed dispute: won | lost | … (the provider's status). */
      readonly disputeStatus: string;
    }
  | {
      readonly kind: "ignored";
      readonly id: string;
      readonly type: string;
      readonly livemode: boolean;
    };

export class WebhookSignatureError extends Error {
  constructor() {
    super("Webhook signature verification failed");
    this.name = "WebhookSignatureError";
  }
}

/** A verified event whose object does not have the shape we act on. */
export class WebhookPayloadError extends Error {
  constructor() {
    super("Webhook payload not understood");
    this.name = "WebhookPayloadError";
  }
}

export interface CheckoutProvider {
  readonly name: string;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verifies the signature of the raw body exactly as received (no parsing before) and
   * maps the event. Throws WebhookSignatureError when it does not verify.
   */
  verifyWebhook(rawBody: Uint8Array, signatureHeader: string | null): ProviderEvent;
  /** Server-side status lookup (recovery when a webhook never arrives). */
  getCheckout(checkoutId: string): Promise<CheckoutSnapshot>;
}
