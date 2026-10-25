// Card payments for credits (Stripe Checkout, TEST MODE) against the real database and the
// real webhook route: events are signed with Stripe's own SDK helper and a synthetic test
// webhook secret, and verified by the production code on the exact bytes posted. No
// network call to Stripe is made (the checkout provider for creation and status lookup is
// a local fake); no real key, card or money is involved.
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import {
  getCheckoutStatus,
  processProviderEvent,
  reconcileOpenCheckouts,
  RECONCILE_AFTER_MS,
  startCreditCheckout,
} from "@/server/billing/checkout-service";
import type { CreditsConfig } from "@/server/billing/credits";
import type {
  CheckoutProvider,
  CheckoutRequest,
  CheckoutSnapshot,
} from "@/server/billing/payments";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

// Fake Stripe-shaped values assembled from fragments, so no key-shaped literal is in the
// source (.gitleaks.toml). None of them is or was ever a real key.
const fakeKey = (...parts: string[]) => parts.join("_");

// Synthetic test-mode configuration: the route reads it on its first request.
const WEBHOOK_SECRET = fakeKey("whsec", "synthetictestsecret0123456789");
process.env.STRIPE_MODE = "test";
process.env.STRIPE_SECRET_KEY = fakeKey("sk", "test", "syntheticnotarealkey0123456789");
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { POST } = await import("@/app/api/payments/webhook/stripe/route");

const { system, db } = createTestDb();
const config: CreditsConfig = { trialPeriodCredits: 0 };
const stripe = new Stripe(fakeKey("sk", "test", "syntheticnotarealkey0123456789"));

/** A local stand-in for Stripe's API (creation, status lookup); never the network. */
function fakeProvider() {
  const created: CheckoutRequest[] = [];
  const sessions = new Map<string, CheckoutSnapshot>();
  let n = 0;
  const provider: CheckoutProvider = {
    name: "stripe",
    createCheckout: (request) => {
      created.push(request);
      n += 1;
      // Like Stripe's idempotency key: the same intent always gets the same session.
      const checkoutId = `cs_test_${request.intentId.replaceAll("-", "")}`;
      sessions.set(checkoutId, {
        checkoutId,
        paymentId: null,
        status: "open",
        paymentStatus: "unpaid",
        amountTotal: request.amountMinor,
        currency: request.currency,
        clientReferenceId: request.intentId,
        metadata: {
          intent_id: request.intentId,
          workspace_id: request.workspaceId,
          package_id: request.packageId,
        },
        livemode: false,
      });
      return Promise.resolve({
        checkoutId,
        redirectUrl: `https://checkout.stripe.com/c/pay/${checkoutId}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    },
    verifyWebhook: () => {
      throw new Error("not used: the real route verifies");
    },
    getCheckout: (checkoutId) => {
      const session = sessions.get(checkoutId);
      return session === undefined
        ? Promise.reject(new Error("no such checkout"))
        : Promise.resolve(session);
    },
  };
  return { provider, created, sessions, calls: () => n };
}

let owner: TenantContext & { slug: string };
let other: TenantContext & { slug: string };

beforeAll(async () => {
  await resetDatabase(system);
});
beforeEach(async () => {
  await resetDatabase(system);
  owner = await createTenant(system);
  other = await createTenant(system);
});
afterAll(async () => {
  await system.$disconnect();
});

let eventCounter = 0;

/** A Stripe event body, as Stripe would send it (only the fields we read are filled). */
function event(type: string, object: Record<string, unknown>, extra: { livemode?: boolean } = {}) {
  eventCounter += 1;
  return JSON.stringify({
    id: `evt_test_${String(Date.now())}_${String(eventCounter)}`,
    object: "event",
    api_version: "2026-09-30.endive",
    created: Math.floor(Date.now() / 1000),
    livemode: extra.livemode ?? false,
    type,
    data: { object },
  });
}

function checkoutObject(
  intentId: string,
  checkoutId: string,
  overrides: Record<string, unknown> = {},
  metadata: Record<string, string> = {},
  base: { workspaceId: string; packageId?: string } = { workspaceId: "" },
) {
  return {
    id: checkoutId,
    object: "checkout.session",
    payment_intent: `pi_test_${intentId.slice(0, 12)}`,
    status: "complete",
    payment_status: "paid",
    amount_total: 1000,
    currency: "usd",
    client_reference_id: intentId,
    livemode: false,
    metadata: {
      intent_id: intentId,
      workspace_id: base.workspaceId,
      package_id: base.packageId ?? "credits_500",
      ...metadata,
    },
    ...overrides,
  };
}

/** Posts a body to the real route, signed with `secret` (the test secret by default). */
async function deliver(
  body: string,
  options: { secret?: string; header?: string | null; timestamp?: number; tamper?: string } = {},
) {
  const header =
    options.header === undefined
      ? stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: options.secret ?? WEBHOOK_SECRET,
          ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
        })
      : options.header;
  const response = await POST(
    new Request("http://localhost:3000/api/payments/webhook/stripe", {
      method: "POST",
      body: options.tamper ?? body,
      headers: header === null ? {} : { "stripe-signature": header },
    }),
  );
  return { status: response.status, text: await response.text() };
}

async function startCheckout(
  ctx: TenantContext & { slug: string },
  provider: CheckoutProvider,
  packageId = "credits_500",
) {
  return startCreditCheckout(
    db,
    ctx,
    { packageId, requestKey: crypto.randomUUID(), locale: "en", slug: ctx.slug },
    { provider, credits: config, appUrl: "http://localhost:3000" },
  );
}

async function intentOf(id: string) {
  return system.paymentIntent.findUniqueOrThrow({ where: { id } });
}

async function purchased(workspaceId: string) {
  const account = await system.creditAccount.findUnique({ where: { workspaceId } });
  return account?.purchasedCredits ?? 0;
}

/** Starts a checkout and returns what a paid checkout.session.completed would carry. */
async function paidCheckout(ctx: TenantContext & { slug: string }) {
  const fake = fakeProvider();
  const { intentId } = await startCheckout(ctx, fake.provider);
  const intent = await intentOf(intentId);
  const session = checkoutObject(
    intentId,
    intent.providerCheckoutId ?? "",
    {},
    {},
    {
      workspaceId: ctx.workspaceId,
    },
  );
  return { fake, intentId, session, paymentId: session.payment_intent };
}

describe("starting a checkout (Pass: Stripe sandbox)", () => {
  it("prices from the server catalog, saves the intent first, and returns the hosted page", async () => {
    const fake = fakeProvider();
    const { intentId, redirectUrl } = await startCheckout(owner, fake.provider, "credits_2000");
    expect(redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      intentId,
      workspaceId: owner.workspaceId,
      packageId: "credits_2000",
      credits: 2000,
      amountMinor: 3500,
      currency: "usd",
    });
    expect(await intentOf(intentId)).toMatchObject({
      status: "OPEN",
      amountMinor: 3500,
      workspaceId: owner.workspaceId,
    });
    // Nothing is credited by starting a checkout.
    expect(await purchased(owner.workspaceId)).toBe(0);
  });

  it("refuses an unknown package, a non-owner, and reuses one intent for a double submit", async () => {
    const fake = fakeProvider();
    await expect(startCheckout(owner, fake.provider, "credits_999999")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const admin = await createTenant(system, { role: WorkspaceRole.ADMIN });
    await expect(startCheckout(admin, fake.provider)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const requestKey = crypto.randomUUID();
    const input = { packageId: "credits_500", requestKey, locale: "en", slug: owner.slug };
    const deps = { provider: fake.provider, credits: config, appUrl: "http://localhost:3000" };
    const first = await startCreditCheckout(db, owner, input, deps);
    const second = await startCreditCheckout(db, owner, input, deps);
    expect(second.intentId).toBe(first.intentId);
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(await system.paymentIntent.count({ where: { workspaceId: owner.workspaceId } })).toBe(1);
  });

  it("marks the intent failed when the provider cannot create the page (nothing charged)", async () => {
    const failing: CheckoutProvider = {
      ...fakeProvider().provider,
      createCheckout: () => Promise.reject(new Error("network")),
    };
    await expect(startCheckout(owner, failing)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    const intent = await system.paymentIntent.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
    });
    expect(intent).toMatchObject({ status: "FAILED", failureCode: "checkout_create_failed" });
  });
});

describe("the Stripe webhook (signed, raw body)", () => {
  it("credits a verified, matching, paid checkout exactly once", async () => {
    const { intentId, session, paymentId } = await paidCheckout(owner);
    const body = event("checkout.session.completed", session);
    expect(await deliver(body)).toEqual({ status: 200, text: "ok" });
    expect(await purchased(owner.workspaceId)).toBe(500);
    expect(await intentOf(intentId)).toMatchObject({
      status: "SUCCEEDED",
      providerPaymentId: paymentId,
    });
    const entries = await system.creditLedgerEntry.findMany({
      where: { workspaceId: owner.workspaceId, kind: "PURCHASE" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amount: 500, actorUserId: null });
    expect(await system.paymentEvent.count()).toBe(1);
  });

  it("rejects an invalid signature, a tampered body, another secret, a missing header and an old timestamp", async () => {
    const { session } = await paidCheckout(owner);
    const body = event("checkout.session.completed", session);
    expect(
      await deliver(body, { secret: fakeKey("whsec", "anothersecretthatisnotours0000") }),
    ).toMatchObject({
      status: 400,
    });
    const tampered = body.replace('"amount_total":1000', '"amount_total":1');
    expect(await deliver(body, { tamper: tampered })).toMatchObject({ status: 400 });
    expect(await deliver(body, { header: null })).toMatchObject({ status: 400 });
    expect(await deliver(body, { header: "t=1,v1=deadbeef" })).toMatchObject({ status: 400 });
    expect(await deliver(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).toMatchObject({
      status: 400,
    });
    expect(await purchased(owner.workspaceId)).toBe(0);
    expect(await system.paymentEvent.count()).toBe(0);
  });

  it("a replayed event changes nothing", async () => {
    const { session } = await paidCheckout(owner);
    const body = event("checkout.session.completed", session);
    const header = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: WEBHOOK_SECRET,
    });
    expect((await deliver(body, { header })).status).toBe(200);
    expect((await deliver(body, { header })).status).toBe(200);
    expect(await purchased(owner.workspaceId)).toBe(500);
    expect(await system.paymentEvent.count()).toBe(1);
  });

  it("one payment reported by two different events is credited once", async () => {
    const { session } = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", session));
    await deliver(event("checkout.session.async_payment_succeeded", session));
    expect(await purchased(owner.workspaceId)).toBe(500);
    const outcomes = await system.paymentEvent.findMany({ select: { outcome: true } });
    expect(outcomes.map((row) => row.outcome).sort()).toEqual(["already_credited", "credited"]);
  });

  it("a payment id already credited on another intent is never credited again", async () => {
    const first = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", first.session));
    const second = await paidCheckout(owner);
    const reused = { ...second.session, payment_intent: first.paymentId };
    expect((await deliver(event("checkout.session.completed", reused))).status).toBe(200);
    expect(await purchased(owner.workspaceId)).toBe(500);
    expect(await intentOf(second.intentId)).toMatchObject({
      status: "NEEDS_REVIEW",
      failureCode: "duplicate_payment",
    });
  });

  it("an amount or currency that differs from the intent grants nothing and asks for review", async () => {
    const low = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", { ...low.session, amount_total: 1 }));
    expect(await intentOf(low.intentId)).toMatchObject({
      status: "NEEDS_REVIEW",
      failureCode: "mismatch_amount",
    });
    const eur = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", { ...eur.session, currency: "eur" }));
    expect(await intentOf(eur.intentId)).toMatchObject({ failureCode: "mismatch_currency" });
    expect(await purchased(owner.workspaceId)).toBe(0);
  });

  it("metadata naming another workspace or package grants nothing to anyone", async () => {
    const tampered = await paidCheckout(owner);
    const forOther = {
      ...tampered.session,
      metadata: { ...tampered.session.metadata, workspace_id: other.workspaceId },
    };
    await deliver(event("checkout.session.completed", forOther));
    expect(await intentOf(tampered.intentId)).toMatchObject({
      status: "NEEDS_REVIEW",
      failureCode: "mismatch_workspace",
    });
    const bigger = await paidCheckout(owner);
    const repackaged = {
      ...bigger.session,
      metadata: { ...bigger.session.metadata, package_id: "credits_5000" },
    };
    await deliver(event("checkout.session.completed", repackaged));
    expect(await intentOf(bigger.intentId)).toMatchObject({ failureCode: "mismatch_package" });
    expect(await purchased(owner.workspaceId)).toBe(0);
    expect(await purchased(other.workspaceId)).toBe(0);
  });

  it("a failed payment grants nothing; the checkout ends failed", async () => {
    const { intentId, session, paymentId } = await paidCheckout(owner);
    await deliver(
      event("payment_intent.payment_failed", {
        id: paymentId,
        object: "payment_intent",
        metadata: session.metadata,
        last_payment_error: { code: "card_declined", decline_code: "generic_decline" },
      }),
    );
    expect(await intentOf(intentId)).toMatchObject({
      status: "OPEN",
      failureCode: "payment_failed_generic_decline",
    });
    await deliver(
      event("checkout.session.async_payment_failed", { ...session, payment_status: "unpaid" }),
    );
    expect(await intentOf(intentId)).toMatchObject({ status: "FAILED" });
    expect(await purchased(owner.workspaceId)).toBe(0);
  });

  it("an incomplete payment waits (processing) and is credited when it succeeds", async () => {
    const { intentId, session } = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", { ...session, payment_status: "unpaid" }));
    expect(await intentOf(intentId)).toMatchObject({ status: "PROCESSING" });
    expect(await purchased(owner.workspaceId)).toBe(0);
    await deliver(event("checkout.session.async_payment_succeeded", session));
    expect(await purchased(owner.workspaceId)).toBe(500);
  });

  it("out of order: expiry after success changes nothing; a refund before success is applied on credit", async () => {
    const paid = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", paid.session));
    await deliver(event("checkout.session.expired", { ...paid.session, status: "expired" }));
    expect(await intentOf(paid.intentId)).toMatchObject({ status: "SUCCEEDED" });

    const early = await paidCheckout(owner);
    // The intent learns its payment id only from the success event: a refund that comes
    // first matches no intent and is recorded, not applied.
    await deliver(
      event("charge.refunded", {
        id: "ch_test_early",
        object: "charge",
        payment_intent: early.paymentId,
        amount_refunded: 1000,
        currency: "usd",
      }),
    );
    expect(await purchased(owner.workspaceId)).toBe(500);
    await deliver(event("checkout.session.completed", early.session));
    expect(await purchased(owner.workspaceId)).toBe(1000);
    // The provider re-sends the refund (it retries): now it applies, once.
    await deliver(
      event("charge.refunded", {
        id: "ch_test_early",
        object: "charge",
        payment_intent: early.paymentId,
        amount_refunded: 1000,
        currency: "usd",
      }),
    );
    expect(await purchased(owner.workspaceId)).toBe(500);
  });

  it("the event can arrive before the checkout id was saved", async () => {
    const fake = fakeProvider();
    const { intentId } = await startCheckout(owner, fake.provider);
    // Simulate a lost answer to createCheckout: the intent has no checkout id yet.
    await system.$executeRaw`UPDATE payment_intents SET status = 'CREATED' WHERE id = ${intentId}::uuid`;
    const lostId = "cs_test_lostanswer";
    const fresh = await system.paymentIntent.create({
      data: {
        workspaceId: owner.workspaceId,
        provider: "stripe",
        packageId: "credits_500",
        credits: 500,
        amountMinor: 1000,
        currency: "usd",
        idempotencyKey: `checkout:${owner.workspaceId}:${crypto.randomUUID()}`,
      },
    });
    const session = checkoutObject(fresh.id, lostId, {}, {}, { workspaceId: owner.workspaceId });
    await deliver(event("checkout.session.completed", session));
    expect(await intentOf(fresh.id)).toMatchObject({
      status: "SUCCEEDED",
      providerCheckoutId: lostId,
    });
    expect(await purchased(owner.workspaceId)).toBe(500);
  });

  it("refunds take back the credits proportionally, never below zero (shortfall recorded)", async () => {
    const paid = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", paid.session));
    const refund = (amount: number) =>
      event("charge.refunded", {
        id: "ch_test_r",
        object: "charge",
        payment_intent: paid.paymentId,
        amount_refunded: amount,
        currency: "usd",
      });
    await deliver(refund(500)); // half
    expect(await purchased(owner.workspaceId)).toBe(250);
    // Spend 200 of the remaining 250, then refund the rest.
    await system.$executeRaw`UPDATE credit_accounts SET purchased_credits = 50 WHERE workspace_id = ${owner.workspaceId}::uuid`;
    await deliver(refund(1000));
    expect(await purchased(owner.workspaceId)).toBe(0);
    expect(await intentOf(paid.intentId)).toMatchObject({
      refundedMinor: 1000,
      creditsRemoved: 300,
      refundShortfall: 200,
    });
  });

  it("disputes: an open one blocks new checkouts; a lost one takes the credits back", async () => {
    const paid = await paidCheckout(owner);
    await deliver(event("checkout.session.completed", paid.session));
    const dispute = (type: string, status: string) =>
      event(type, { id: "dp_test_1", object: "dispute", payment_intent: paid.paymentId, status });
    await deliver(dispute("charge.dispute.created", "needs_response"));
    await expect(startCheckout(owner, fakeProvider().provider)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await deliver(dispute("charge.dispute.closed", "lost"));
    expect(await purchased(owner.workspaceId)).toBe(0);
    expect(await intentOf(paid.intentId)).toMatchObject({
      disputeStatus: "LOST",
      creditsRemoved: 500,
    });
  });

  it("a live-mode event and an event for an unknown checkout grant nothing", async () => {
    const paid = await paidCheckout(owner);
    await deliver(
      event("checkout.session.completed", { ...paid.session, livemode: true }, { livemode: true }),
    );
    await deliver(
      event(
        "checkout.session.completed",
        checkoutObject(
          crypto.randomUUID(),
          "cs_test_unknown",
          {},
          {},
          {
            workspaceId: owner.workspaceId,
          },
        ),
      ),
    );
    expect(await purchased(owner.workspaceId)).toBe(0);
    const outcomes = await system.paymentEvent.findMany({
      select: { outcome: true, workspaceId: true },
    });
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { outcome: "livemode_refused", workspaceId: null },
        { outcome: "unknown_intent", workspaceId: null },
      ]),
    );
  });
});

describe("the return to the app, recovery and failures", () => {
  it("the success redirect without a webhook only reads; the status lookup credits once", async () => {
    const { fake, intentId, session } = await paidCheckout(owner);
    // The browser came back to ?checkout=success: the page reads, never writes.
    expect(await getCheckoutStatus(db, owner, intentId)).toEqual({ status: "OPEN", credits: 500 });
    expect(await getCheckoutStatus(db, other, intentId)).toBeNull();
    expect(await purchased(owner.workspaceId)).toBe(0);

    // The webhook never arrives: the provider now reports the session paid.
    const open = fake.sessions.get(session.id);
    if (open === undefined) throw new Error("the fake provider lost the session");
    fake.sessions.set(session.id, {
      ...open,
      status: "complete",
      paymentStatus: "paid",
      paymentId: session.payment_intent,
    });
    const later = new Date(Date.now() + RECONCILE_AFTER_MS + 60_000);
    expect(await reconcileOpenCheckouts(db, fake.provider, config, later)).toMatchObject({
      checked: 1,
      credited: 1,
    });
    expect(await reconcileOpenCheckouts(db, fake.provider, config, later)).toMatchObject({
      checked: 0,
    });
    expect(await purchased(owner.workspaceId)).toBe(500);
    // A late webhook for the same payment changes nothing.
    await deliver(event("checkout.session.completed", session));
    expect(await purchased(owner.workspaceId)).toBe(500);
  });

  it("a database failure commits nothing; the retried event is credited once", async () => {
    const { session } = await paidCheckout(owner);
    const verified = {
      kind: "checkout_completed" as const,
      id: "evt_test_dbdown",
      type: "checkout.session.completed",
      livemode: false,
      checkout: {
        checkoutId: session.id,
        paymentId: session.payment_intent,
        status: "complete",
        paymentStatus: "paid",
        amountTotal: 1000,
        currency: "usd",
        clientReferenceId: session.client_reference_id,
        metadata: session.metadata,
        livemode: false,
      },
    };
    // The transaction does all its work, then the database fails before the commit.
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "$transaction") {
          return (work: (tx: unknown) => Promise<unknown>) =>
            target.$transaction(async (tx) => {
              await work(tx);
              throw new Error("database connection lost");
            });
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    await expect(processProviderEvent(failing, verified, "0".repeat(64), config)).rejects.toThrow(
      "database connection lost",
    );
    expect(await purchased(owner.workspaceId)).toBe(0);
    expect(await system.paymentEvent.count()).toBe(0);
    // The provider retries the same event: applied once.
    expect(await processProviderEvent(db, verified, "0".repeat(64), config)).toMatchObject({
      outcome: "credited",
    });
    expect(await processProviderEvent(db, verified, "0".repeat(64), config)).toMatchObject({
      outcome: "duplicate_event",
    });
    expect(await purchased(owner.workspaceId)).toBe(500);
  });

  it("the database refuses changing what was sold and editing processed events", async () => {
    const { intentId, session } = await paidCheckout(owner);
    await expect(
      system.$executeRaw`UPDATE payment_intents SET amount_minor = 1 WHERE id = ${intentId}::uuid`,
    ).rejects.toThrow(/immutable/);
    await deliver(event("checkout.session.completed", session));
    await expect(system.$executeRaw`UPDATE payment_events SET outcome = 'x'`).rejects.toThrow(
      /append-only/,
    );
    await expect(system.$executeRaw`DELETE FROM payment_events`).rejects.toThrow(/append-only/);
  });
});
