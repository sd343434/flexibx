// Stripe sandbox guard rails: test mode only (live keys and modes refused, secrets never in
// error messages), webhook signatures verified with the real Stripe SDK on the raw bytes,
// event mapping, and the adapter's own checks on what Stripe returns. Synthetic values only.
import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { checkoutMismatch } from "@/server/billing/checkout-service";
import { CREDIT_PACKAGES, findCreditPackage } from "@/server/billing/packages";
import { WebhookSignatureError } from "@/server/billing/payments";
import { createStripeCheckoutProvider, mapStripeEvent } from "@/server/billing/stripe-provider";
import { EnvValidationError, parsePaymentsEnv } from "@/server/env-schema";
import { checkStartupEnv } from "@/server/startup-env";

// Fake Stripe-shaped values assembled from fragments, so no key-shaped literal is in the
// source (.gitleaks.toml). None of them is or was ever a real key.
const fakeKey = (...parts: string[]) => parts.join("_");

const TEST_KEY = fakeKey("sk", "test", "syntheticnotarealkey0123456789");
const SECRET = fakeKey("whsec", "synthetictestsecret0123456789");
const stripe = new Stripe(TEST_KEY);

const error = (source: Record<string, string>) => {
  try {
    parsePaymentsEnv(source);
    return null;
  } catch (caught) {
    return caught;
  }
};

describe("payments configuration: test mode only", () => {
  it("is off when nothing is set, and on with a complete test configuration", () => {
    expect(parsePaymentsEnv({})).toEqual({ stripe: null });
    expect(
      parsePaymentsEnv({
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: TEST_KEY,
        STRIPE_WEBHOOK_SECRET: SECRET,
      }),
    ).toEqual({ stripe: { mode: "test", secretKey: TEST_KEY, webhookSecret: SECRET } });
    expect(
      parsePaymentsEnv({
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: fakeKey("rk", "test", "syntheticrestrictedkey012345"),
        STRIPE_WEBHOOK_SECRET: SECRET,
      }).stripe,
    ).not.toBeNull();
  });

  it.each([
    [
      "a live secret key",
      { STRIPE_SECRET_KEY: fakeKey("sk", "live", "syntheticlivekeyvalue000000") },
      /live key/,
    ],
    [
      "a live restricted key",
      { STRIPE_SECRET_KEY: fakeKey("rk", "live", "syntheticlivekeyvalue000000") },
      /live key/,
    ],
    ["live mode", { STRIPE_MODE: "live" }, /must be `test`/],
    [
      "a publishable key as secret",
      { STRIPE_SECRET_KEY: fakeKey("pk", "test", "syntheticpublishable00000") },
      /test secret key/,
    ],
    ["a malformed webhook secret", { STRIPE_WEBHOOK_SECRET: "not-a-secret" }, /signing secret/],
  ])("refuses %s, naming the variable but never the value", (_name, change, message) => {
    const source = {
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: SECRET,
      ...change,
    };
    const caught = error(source);
    expect(caught).toBeInstanceOf(EnvValidationError);
    const text = (caught as Error).message;
    expect(text).toMatch(message);
    // Key-like values never appear (a short word such as `live` may be part of the rule).
    for (const value of Object.values(change)) {
      if (value.length >= 16) expect(text).not.toContain(value);
    }
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain(SECRET);
  });

  it("refuses a partial configuration (fail closed)", () => {
    expect(error({ STRIPE_SECRET_KEY: TEST_KEY })).toBeInstanceOf(EnvValidationError);
    expect(error({ STRIPE_MODE: "test", STRIPE_WEBHOOK_SECRET: SECRET })).toBeInstanceOf(
      EnvValidationError,
    );
  });

  it("an invalid payments configuration stops the server at startup", () => {
    const report = checkStartupEnv({
      ...process.env,
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: fakeKey("sk", "live", "syntheticlivekeyvalue000000"),
      STRIPE_WEBHOOK_SECRET: SECRET,
    });
    expect(report.errors.join("\n")).toMatch(/payments.*\n.*STRIPE_SECRET_KEY: is a live key/s);
    expect(report.errors.join("\n")).not.toContain(
      fakeKey("sk", "live", "syntheticlivekeyvalue000000"),
    );
  });
});

describe("Stripe webhook signature (real SDK, raw bytes)", () => {
  const provider = createStripeCheckoutProvider(
    { secretKey: TEST_KEY, webhookSecret: SECRET },
    stripe,
  );
  const body = JSON.stringify({
    id: "evt_test_1",
    object: "event",
    livemode: false,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_intent: "pi_test_1",
        status: "complete",
        payment_status: "paid",
        amount_total: 1000,
        currency: "usd",
        client_reference_id: "11111111-1111-1111-1111-111111111111",
        livemode: false,
        metadata: { intent_id: "11111111-1111-1111-1111-111111111111" },
      },
    },
  });
  const bytes = (text: string) => new TextEncoder().encode(text);
  const sign = (payload: string, options: { secret?: string; timestamp?: number } = {}) =>
    stripe.webhooks.generateTestHeaderString({
      payload,
      secret: options.secret ?? SECRET,
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    });

  it("accepts the exact signed bytes and maps the event", () => {
    const event = provider.verifyWebhook(bytes(body), sign(body));
    expect(event).toMatchObject({
      kind: "checkout_completed",
      id: "evt_test_1",
      checkout: { checkoutId: "cs_test_1", paymentId: "pi_test_1", amountTotal: 1000 },
    });
  });

  it.each([
    ["a changed body", () => [bytes(body.replace("1000", "1001")), sign(body)] as const],
    [
      "re-serialized JSON (whitespace)",
      () => [bytes(JSON.stringify(JSON.parse(body), null, 2)), sign(body)] as const,
    ],
    [
      "another secret",
      () =>
        [bytes(body), sign(body, { secret: fakeKey("whsec", "other00000000000000000") })] as const,
    ],
    [
      "an expired timestamp",
      () => [bytes(body), sign(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 })] as const,
    ],
    ["no header", () => [bytes(body), null] as const],
    ["a garbage header", () => [bytes(body), "v1=abc"] as const],
  ])("rejects %s", (_name, build) => {
    const [raw, header] = build();
    expect(() => provider.verifyWebhook(raw, header)).toThrow(WebhookSignatureError);
  });
});

describe("Stripe event mapping", () => {
  const evt = (type: string, object: Record<string, unknown>, livemode = false) => ({
    id: "evt_x",
    type,
    livemode,
    data: { object },
  });

  it("maps refunds, disputes and failures to the payment they concern", () => {
    expect(
      mapStripeEvent(
        evt("charge.refunded", { payment_intent: "pi_1", amount_refunded: 300, currency: "usd" }),
      ),
    ).toMatchObject({ kind: "refund", paymentId: "pi_1", amountRefunded: 300 });
    expect(
      mapStripeEvent(evt("charge.dispute.closed", { payment_intent: "pi_1", status: "lost" })),
    ).toMatchObject({ kind: "dispute_closed", disputeStatus: "lost" });
    expect(
      mapStripeEvent(
        evt("payment_intent.payment_failed", {
          id: "pi_1",
          metadata: {},
          last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" },
        }),
      ),
    ).toMatchObject({ kind: "payment_failed", failureCode: "insufficient_funds" });
    expect(mapStripeEvent(evt("customer.created", {}))).toMatchObject({ kind: "ignored" });
    expect(
      mapStripeEvent(
        evt("charge.refunded", { payment_intent: null, amount_refunded: 0, currency: "usd" }),
      ),
    ).toMatchObject({ kind: "ignored" });
    // A type we act on, with an object of the wrong shape, is refused.
    expect(() => mapStripeEvent(evt("charge.refunded", { amount_refunded: "lots" }))).toThrow();
  });
});

describe("checkout creation checks what Stripe returns", () => {
  const request = {
    intentId: "11111111-1111-1111-1111-111111111111",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    packageId: "credits_500",
    credits: 500,
    amountMinor: 1000,
    currency: "usd",
    successUrl: "http://localhost:3000/en/w/a/billing?checkout=success",
    cancelUrl: "http://localhost:3000/en/w/a/billing?checkout=cancelled",
  };
  const clientReturning = (session: Record<string, unknown>) => {
    const calls: { params: Record<string, unknown>; options: Record<string, unknown> }[] = [];
    const client = {
      checkout: {
        sessions: {
          create: (params: Record<string, unknown>, options: Record<string, unknown>) => {
            calls.push({ params, options });
            return Promise.resolve(session);
          },
        },
      },
    } as unknown as Stripe;
    return { client, calls };
  };
  const good = {
    id: "cs_test_1",
    livemode: false,
    amount_total: 1000,
    currency: "usd",
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
    expires_at: 1_900_000_000,
  };

  it("sends server amounts, our metadata and an idempotency key per intent", async () => {
    const { client, calls } = clientReturning(good);
    const provider = createStripeCheckoutProvider(
      { secretKey: TEST_KEY, webhookSecret: SECRET },
      client,
    );
    const session = await provider.createCheckout(request);
    expect(session.redirectUrl).toBe(good.url);
    expect(calls[0]?.options).toEqual({
      idempotencyKey: `flexibx-checkout:${request.intentId}`,
    });
    expect(calls[0]?.params).toMatchObject({
      mode: "payment",
      client_reference_id: request.intentId,
      metadata: { intent_id: request.intentId, workspace_id: request.workspaceId },
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1000 } }],
    });
  });

  it.each([
    ["a live-mode session", { ...good, livemode: true }],
    ["another amount", { ...good, amount_total: 1 }],
    ["a page outside stripe.com", { ...good, url: "https://evil.example/pay" }],
  ])("refuses %s", async (_name, session) => {
    const { client } = clientReturning(session);
    const provider = createStripeCheckoutProvider(
      { secretKey: TEST_KEY, webhookSecret: SECRET },
      client,
    );
    await expect(provider.createCheckout(request)).rejects.toThrow();
  });
});

describe("credit packages and the match rule", () => {
  it("prices in integer USD cents and resolves only known ids", () => {
    for (const pack of CREDIT_PACKAGES) {
      expect(Number.isSafeInteger(pack.amountMinor) && pack.amountMinor > 0).toBe(true);
      expect(pack.currency).toBe("usd");
    }
    expect(findCreditPackage("credits_500")?.amountMinor).toBe(1000);
    expect(findCreditPackage("__proto__")).toBeNull();
  });

  it("names the first field that does not match", () => {
    const intent = {
      id: "i1",
      workspaceId: "w1",
      packageId: "credits_500",
      credits: 500,
      amountMinor: 1000,
      currency: "usd",
      status: "OPEN" as const,
      providerCheckoutId: "cs_1",
      providerPaymentId: null,
      creditedAt: null,
      refundedMinor: 0,
      creditsRemoved: 0,
      refundShortfall: 0,
      disputeStatus: null,
    };
    const checkout = {
      checkoutId: "cs_1",
      paymentId: "pi_1",
      status: "complete",
      paymentStatus: "paid",
      amountTotal: 1000,
      currency: "usd",
      clientReferenceId: "i1",
      metadata: { intent_id: "i1", workspace_id: "w1", package_id: "credits_500" },
      livemode: false,
    };
    expect(checkoutMismatch(intent, checkout)).toBeNull();
    expect(checkoutMismatch(intent, { ...checkout, checkoutId: "cs_2" })).toBe("checkout");
    expect(checkoutMismatch(intent, { ...checkout, paymentId: null })).toBe("payment");
    expect(checkoutMismatch(intent, { ...checkout, livemode: true })).toBe("livemode");
    expect(checkoutMismatch(intent, { ...checkout, clientReferenceId: "i2" })).toBe("reference");
  });
});
