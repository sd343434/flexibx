import { createHash } from "node:crypto";

import type { PaymentIntentStatus } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import { AppError } from "../errors/app-error";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { addCredits, creditsError, lockAccount, type CreditsConfig } from "./credits";
import { findCreditPackage } from "./packages";
import type { CheckoutProvider, CheckoutSnapshot, ProviderEvent } from "./payments";

// Buying credits by card (Stripe Checkout, test mode only; STRIPE_SANDBOX.md). Pure
// (dependencies injected) so every rule below is tested against a real database.
//
// Rules:
// - The browser sends only a package id and a one-time request key. Credits, amount and
//   currency come from the server's catalog; the workspace from the signed-in owner's
//   membership. An intent is saved BEFORE the provider is called.
// - Credits are granted only by `processProviderEvent` (a verified webhook) or
//   `reconcileOpenCheckouts` (a server-side status lookup) — never by the success redirect,
//   which only reads `getCheckoutStatus`. Granting needs a paid payment whose amount,
//   currency, workspace, package and intent all match the saved intent.
// - Once per provider payment id (unique on the intent, unique ledger request key) and
//   once per provider event id (unique). Everything for one event commits in one
//   transaction; if it fails, the caller answers 5xx and the provider retries.
// - Refunds and lost disputes take back the purchased credits proportionally, as far as
//   they are unspent (the rest is recorded as a shortfall for the owner's policy); an open
//   dispute blocks new checkouts for the workspace.

export const PAYMENT_PROVIDER = "stripe";

export interface CheckoutDeps {
  readonly provider: CheckoutProvider;
  readonly credits: CreditsConfig;
  /** The app's public origin (APP_URL), for the success and cancel URLs. */
  readonly appUrl: string;
  readonly now?: Date;
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function paymentsError(
  code: "CONFLICT" | "VALIDATION_FAILED" | "SERVICE_UNAVAILABLE",
  field:
    | "payments_package_unknown"
    | "payments_dispute_open"
    | "payments_checkout_failed"
    | "payments_already_completed"
    | "payments_request_conflict",
): AppError {
  return new AppError(code, {
    message: `Payments: ${field}`,
    fields: [{ path: "payments", code: field }],
  });
}

// ── Starting a checkout ─────────────────────────────────────────────────────────

export interface StartCheckoutInput {
  readonly packageId: string;
  /** One per rendered form (UUID): a double submit reuses the same intent and session. */
  readonly requestKey: string;
  readonly locale: string;
  readonly slug: string;
}

/** Creates (or reuses) the intent and the provider's checkout; returns the hosted page. */
export async function startCreditCheckout(
  db: Db,
  ctx: TenantContext,
  input: StartCheckoutInput,
  deps: CheckoutDeps,
): Promise<{ readonly intentId: string; readonly redirectUrl: string }> {
  assertCan(ctx, "billing.manage");
  const pack = findCreditPackage(input.packageId);
  if (pack === null) throw paymentsError("VALIDATION_FAILED", "payments_package_unknown");
  if (!/^[0-9a-f-]{36}$/.test(input.requestKey)) {
    throw paymentsError("VALIDATION_FAILED", "payments_request_conflict");
  }
  const now = deps.now ?? new Date();
  const { workspaceId } = ctx;

  const disputed = await db.paymentIntent.count({
    where: { workspaceId, disputeStatus: "OPEN" },
  });
  if (disputed > 0) throw paymentsError("CONFLICT", "payments_dispute_open");

  const idempotencyKey = `checkout:${workspaceId}:${input.requestKey}`;
  let intent = await db.paymentIntent.findFirst({
    where: { workspaceId, idempotencyKey },
    select: { id: true, packageId: true, status: true, providerCheckoutId: true },
  });
  if (intent !== null) {
    if (intent.packageId !== pack.id) throw paymentsError("CONFLICT", "payments_request_conflict");
    if (intent.status !== "CREATED" && intent.status !== "OPEN") {
      throw paymentsError("CONFLICT", "payments_already_completed");
    }
  } else {
    intent = await db.paymentIntent.create({
      data: {
        workspaceId,
        userId: ctx.userId,
        provider: deps.provider.name,
        packageId: pack.id,
        credits: pack.credits,
        amountMinor: pack.amountMinor,
        currency: pack.currency,
        idempotencyKey,
        createdAt: now,
      },
      select: { id: true, packageId: true, status: true, providerCheckoutId: true },
    });
  }

  const billingUrl = `${deps.appUrl.replace(/\/$/, "")}/${input.locale}/w/${encodeURIComponent(input.slug)}/billing`;
  let session;
  try {
    // Same intent → same provider idempotency key → the same session on a retry.
    session = await deps.provider.createCheckout({
      intentId: intent.id,
      workspaceId,
      packageId: pack.id,
      credits: pack.credits,
      amountMinor: pack.amountMinor,
      currency: pack.currency,
      successUrl: `${billingUrl}?checkout=success&intent=${intent.id}`,
      cancelUrl: `${billingUrl}?checkout=cancelled&intent=${intent.id}`,
    });
  } catch {
    await db.paymentIntent.updateMany({
      where: { workspaceId, id: intent.id, status: "CREATED" },
      data: { status: "FAILED", failureCode: "checkout_create_failed" },
    });
    throw paymentsError("SERVICE_UNAVAILABLE", "payments_checkout_failed");
  }
  // The provider's idempotency key makes a retry return the same session; anything else
  // would be a second checkout for one intent, which is refused (and the database would
  // refuse to change the stored checkout id).
  if (intent.providerCheckoutId !== null && intent.providerCheckoutId !== session.checkoutId) {
    throw paymentsError("CONFLICT", "payments_request_conflict");
  }
  await db.paymentIntent.updateMany({
    where: { workspaceId, id: intent.id, status: { in: ["CREATED", "OPEN"] } },
    data: { status: "OPEN", providerCheckoutId: session.checkoutId, expiresAt: session.expiresAt },
  });
  await recordAudit(db, ctx, {
    action: "billing.checkout_started",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { packageId: pack.id, credits: pack.credits, amountMinor: pack.amountMinor },
  });
  return { intentId: intent.id, redirectUrl: session.redirectUrl };
}

/** What the success/cancel page shows: read only, this workspace's intents only. */
export async function getCheckoutStatus(
  db: Db,
  ctx: TenantContext,
  intentId: string,
): Promise<{ readonly status: PaymentIntentStatus; readonly credits: number } | null> {
  assertCan(ctx, "billing.view");
  if (!/^[0-9a-f-]{36}$/.test(intentId)) return null;
  return db.paymentIntent.findFirst({
    where: { workspaceId: ctx.workspaceId, id: intentId },
    select: { status: true, credits: true },
  });
}

// ── Verified provider events ────────────────────────────────────────────────────

interface LockedIntent {
  readonly id: string;
  readonly workspaceId: string;
  readonly packageId: string;
  readonly credits: number;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: PaymentIntentStatus;
  readonly providerCheckoutId: string | null;
  readonly providerPaymentId: string | null;
  readonly creditedAt: Date | null;
  readonly refundedMinor: number;
  readonly creditsRemoved: number;
  readonly refundShortfall: number;
  readonly disputeStatus: string | null;
}

type Tx = Parameters<Parameters<GuardedPrismaClient["$transaction"]>[0]>[0];

interface IntentRow {
  id: string;
  workspace_id: string;
  package_id: string;
  credits: number;
  amount_minor: number;
  currency: string;
  status: PaymentIntentStatus;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  credited_at: Date | null;
  refunded_minor: number;
  credits_removed: number;
  refund_shortfall: number;
  dispute_status: string | null;
}

/**
 * Locks one intent row (FOR UPDATE) found by a provider reference. A webhook carries no
 * tenant, so this is the one place that looks across workspaces — raw SQL on a unique
 * key; every write after it names the intent's workspace (tenant guard).
 */
async function lockIntent(
  tx: Tx,
  by: { readonly checkoutId?: string; readonly paymentId?: string; readonly intentId?: string },
): Promise<LockedIntent | null> {
  let rows: IntentRow[] = [];
  if (by.checkoutId !== undefined) {
    rows = await tx.$queryRaw<IntentRow[]>`SELECT * FROM payment_intents
      WHERE provider_checkout_id = ${by.checkoutId} FOR UPDATE`;
  } else if (by.paymentId !== undefined) {
    rows = await tx.$queryRaw<IntentRow[]>`SELECT * FROM payment_intents
      WHERE provider_payment_id = ${by.paymentId} FOR UPDATE`;
  } else if (by.intentId !== undefined && /^[0-9a-f-]{36}$/.test(by.intentId)) {
    rows = await tx.$queryRaw<IntentRow[]>`SELECT * FROM payment_intents
      WHERE id = ${by.intentId}::uuid FOR UPDATE`;
  }
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.package_id,
    credits: row.credits,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    providerCheckoutId: row.provider_checkout_id,
    providerPaymentId: row.provider_payment_id,
    creditedAt: row.credited_at,
    refundedMinor: row.refunded_minor,
    creditsRemoved: row.credits_removed,
    refundShortfall: row.refund_shortfall,
    disputeStatus: row.dispute_status,
  };
}

/** Why a paid checkout does not match the intent it claims to be for, or null. */
export function checkoutMismatch(intent: LockedIntent, checkout: CheckoutSnapshot): string | null {
  const pack = findCreditPackage(intent.packageId);
  if (checkout.livemode) return "livemode";
  if (checkout.clientReferenceId !== intent.id) return "reference";
  if (checkout.metadata.intent_id !== intent.id) return "intent";
  if (checkout.metadata.workspace_id !== intent.workspaceId) return "workspace";
  if (checkout.metadata.package_id !== intent.packageId) return "package";
  if (pack?.credits !== intent.credits || pack.amountMinor !== intent.amountMinor) {
    return "package";
  }
  if (checkout.amountTotal !== intent.amountMinor) return "amount";
  if (checkout.currency !== intent.currency) return "currency";
  if (intent.providerCheckoutId !== null && checkout.checkoutId !== intent.providerCheckoutId) {
    return "checkout";
  }
  if (checkout.paymentId === null) return "payment";
  return null;
}

async function setIntent(
  tx: Tx,
  intent: LockedIntent,
  data: {
    status?: PaymentIntentStatus;
    failureCode?: string | null;
    providerCheckoutId?: string;
    providerPaymentId?: string;
    creditedAt?: Date;
    refundedMinor?: number;
    creditsRemoved?: number;
    refundShortfall?: number;
    disputeStatus?: string;
  },
): Promise<void> {
  await tx.paymentIntent.update({
    where: { workspaceId: intent.workspaceId, id: intent.id },
    data,
  });
}

/**
 * Takes back credits so that `target` credits of this purchase are removed or recorded as
 * a shortfall (never more than were granted, never below zero purchased credits).
 */
async function takeBack(
  tx: Tx,
  intent: LockedIntent,
  target: number,
  key: string,
  now: Date,
  config: CreditsConfig,
): Promise<{ removed: number; shortfall: number }> {
  const owed = Math.min(target, intent.credits) - intent.creditsRemoved - intent.refundShortfall;
  if (owed <= 0 || intent.creditedAt === null) return { removed: 0, shortfall: 0 };
  const account = await lockAccount(tx, intent.workspaceId, now, config);
  const removed = Math.min(owed, account.purchasedCredits);
  if (removed > 0) {
    await addCredits(
      tx,
      intent.workspaceId,
      {
        kind: "ADJUSTMENT",
        amount: -removed,
        actorUserId: null,
        externalRef: `${PAYMENT_PROVIDER}:${intent.providerPaymentId ?? intent.id}`,
        note: key.startsWith("refund") ? "card payment refunded" : "card payment disputed",
        requestKey: `${PAYMENT_PROVIDER}_${key}:${intent.id}:${String(target)}`.slice(0, 80),
      },
      now,
      config,
    );
  }
  const shortfall = owed - removed;
  await setIntent(tx, intent, {
    creditsRemoved: intent.creditsRemoved + removed,
    refundShortfall: intent.refundShortfall + shortfall,
  });
  return { removed, shortfall };
}

/** Grants the intent's credits for a verified, matching, paid checkout (once). */
async function grantForCheckout(
  tx: Tx,
  intent: LockedIntent,
  checkout: CheckoutSnapshot,
  now: Date,
  config: CreditsConfig,
): Promise<string> {
  if (checkout.paymentStatus !== "paid") {
    if (intent.status === "CREATED" || intent.status === "OPEN") {
      await setIntent(tx, intent, { status: "PROCESSING" });
    }
    return "awaiting_payment";
  }
  if (intent.creditedAt !== null) {
    // Another event for the payment already credited (or a second payment: review).
    return intent.providerPaymentId === checkout.paymentId ? "already_credited" : "second_payment";
  }
  if (intent.status === "NEEDS_REVIEW") return "under_review";
  const mismatch = checkoutMismatch(intent, checkout);
  if (mismatch !== null) {
    await setIntent(tx, intent, { status: "NEEDS_REVIEW", failureCode: `mismatch_${mismatch}` });
    await recordAudit(
      tx,
      { workspaceId: intent.workspaceId, userId: null },
      {
        action: "billing.payment_review",
        entityType: "payment_intent",
        entityId: intent.id,
        metadata: { reason: mismatch },
      },
    );
    return "mismatch";
  }
  const paymentId = checkout.paymentId ?? "";
  // A payment id already credited on another intent is never credited twice.
  const other = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payment_intents
    WHERE provider_payment_id = ${paymentId} AND id <> ${intent.id}::uuid`;
  if (other.length > 0) {
    await setIntent(tx, intent, { status: "NEEDS_REVIEW", failureCode: "duplicate_payment" });
    return "duplicate_payment";
  }
  const added = await addCredits(
    tx,
    intent.workspaceId,
    {
      kind: "PURCHASE",
      amount: intent.credits,
      actorUserId: null,
      externalRef: `${PAYMENT_PROVIDER}:${paymentId}`.slice(0, 160),
      note: `card payment, package ${intent.packageId}`,
      requestKey: `${PAYMENT_PROVIDER}_payment:${paymentId}`.slice(0, 80),
    },
    now,
    config,
  );
  if (!added) return "already_credited";
  await setIntent(tx, intent, {
    status: "SUCCEEDED",
    failureCode: null,
    providerCheckoutId: intent.providerCheckoutId ?? checkout.checkoutId,
    providerPaymentId: paymentId,
    creditedAt: now,
  });
  await recordAudit(
    tx,
    { workspaceId: intent.workspaceId, userId: null },
    {
      action: "billing.payment_credited",
      entityType: "payment_intent",
      entityId: intent.id,
      metadata: { credits: intent.credits, amountMinor: intent.amountMinor },
    },
  );
  // A refund or lost dispute that arrived before the payment event is applied now.
  const credited: LockedIntent = {
    ...intent,
    status: "SUCCEEDED",
    providerPaymentId: paymentId,
    creditedAt: now,
  };
  if (intent.refundedMinor > 0) {
    const target = Math.floor((intent.credits * intent.refundedMinor) / intent.amountMinor);
    await takeBack(tx, credited, target, "refund", now, config);
  } else if (intent.disputeStatus === "LOST") {
    await takeBack(tx, credited, intent.credits, "dispute", now, config);
  }
  return "credited";
}

/** Finds the intent an event is about. */
async function intentForEvent(tx: Tx, event: ProviderEvent): Promise<LockedIntent | null> {
  switch (event.kind) {
    case "checkout_completed":
    case "checkout_async_succeeded":
    case "checkout_async_failed":
    case "checkout_expired": {
      const byCheckout = await lockIntent(tx, { checkoutId: event.checkout.checkoutId });
      if (byCheckout !== null) return byCheckout;
      // The event can arrive before the checkout id was saved (the answer to
      // createCheckout was lost): match the intent the session was created for, only if
      // it has no checkout id yet.
      const reference = event.checkout.clientReferenceId;
      if (reference === null) return null;
      const byReference = await lockIntent(tx, { intentId: reference });
      return byReference?.providerCheckoutId === null ? byReference : null;
    }
    case "payment_failed": {
      const byPayment = await lockIntent(tx, { paymentId: event.paymentId });
      if (byPayment !== null) return byPayment;
      const reference = event.metadata.intent_id;
      if (reference === undefined) return null;
      const byReference = await lockIntent(tx, { intentId: reference });
      return byReference?.workspaceId === event.metadata.workspace_id ? byReference : null;
    }
    case "refund":
    case "dispute_opened":
    case "dispute_closed":
      return lockIntent(tx, { paymentId: event.paymentId });
    case "ignored":
      return null;
  }
}

async function applyEvent(
  tx: Tx,
  intent: LockedIntent,
  event: Exclude<ProviderEvent, { kind: "ignored" }>,
  now: Date,
  config: CreditsConfig,
): Promise<string> {
  const unsettled = ["CREATED", "OPEN", "PROCESSING"].includes(intent.status);
  switch (event.kind) {
    case "checkout_completed":
    case "checkout_async_succeeded":
      return grantForCheckout(tx, intent, event.checkout, now, config);
    case "checkout_async_failed":
      if (!unsettled) return "ignored_settled";
      await setIntent(tx, intent, { status: "FAILED", failureCode: "async_payment_failed" });
      return "failed";
    case "checkout_expired":
      // Arrives after success only out of order: a credited intent stays credited.
      if (!unsettled) return "ignored_settled";
      await setIntent(tx, intent, { status: "EXPIRED" });
      return "expired";
    case "payment_failed":
      // The customer can retry on the same page: not final, nothing granted.
      if (!unsettled) return "ignored_settled";
      await setIntent(tx, intent, {
        failureCode:
          `payment_failed${event.failureCode === null ? "" : `_${event.failureCode}`}`.slice(0, 80),
      });
      return "payment_failed";
    case "refund": {
      if (event.currency !== intent.currency) {
        await setIntent(tx, intent, { status: "NEEDS_REVIEW", failureCode: "refund_currency" });
        return "mismatch";
      }
      const refunded = Math.min(Math.max(event.amountRefunded, 0), intent.amountMinor);
      if (refunded <= intent.refundedMinor) return "refund_already_applied";
      await setIntent(tx, intent, { refundedMinor: refunded });
      const updated = { ...intent, refundedMinor: refunded };
      const target = Math.floor((intent.credits * refunded) / intent.amountMinor);
      const { shortfall } = await takeBack(tx, updated, target, "refund", now, config);
      await recordAudit(
        tx,
        { workspaceId: intent.workspaceId, userId: null },
        {
          action: "billing.payment_refunded",
          entityType: "payment_intent",
          entityId: intent.id,
          metadata: { refundedMinor: refunded, shortfall },
        },
      );
      return shortfall > 0 ? "refund_shortfall" : "refunded";
    }
    case "dispute_opened":
      await setIntent(tx, intent, { disputeStatus: "OPEN" });
      await recordAudit(
        tx,
        { workspaceId: intent.workspaceId, userId: null },
        { action: "billing.payment_disputed", entityType: "payment_intent", entityId: intent.id },
      );
      return "dispute_opened";
    case "dispute_closed": {
      const lost = event.disputeStatus === "lost";
      await setIntent(tx, intent, { disputeStatus: lost ? "LOST" : "WON" });
      if (!lost) return "dispute_won";
      const { shortfall } = await takeBack(
        tx,
        { ...intent, disputeStatus: "LOST" },
        intent.credits,
        "dispute",
        now,
        config,
      );
      return shortfall > 0 ? "dispute_lost_shortfall" : "dispute_lost";
    }
  }
}

export interface ProcessedEvent {
  readonly outcome: string;
  readonly duplicate: boolean;
  /** Needs a person (mismatch, shortfall, live mode, …): the caller alerts. */
  readonly alert: boolean;
}

const ALERT_OUTCOMES = new Set([
  "mismatch",
  "duplicate_payment",
  "second_payment",
  "refund_shortfall",
  "dispute_opened",
  "dispute_lost",
  "dispute_lost_shortfall",
  "livemode_refused",
  "unknown_intent",
]);

/**
 * Applies one VERIFIED provider event (the signature was checked on the raw body before
 * this is called) in one transaction, and records it once. A replay of the same event id
 * changes nothing. Throws on a database failure: nothing is committed, the caller answers
 * 5xx and the provider delivers the event again.
 */
export async function processProviderEvent(
  db: GuardedPrismaClient,
  event: ProviderEvent,
  payloadSha256: string,
  config: CreditsConfig,
  now: Date = new Date(),
): Promise<ProcessedEvent> {
  return db.$transaction(async (tx) => {
    const seen = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payment_events
      WHERE provider = ${PAYMENT_PROVIDER} AND provider_event_id = ${event.id} FOR UPDATE`;
    if (seen.length > 0) return { outcome: "duplicate_event", duplicate: true, alert: false };

    let intent: LockedIntent | null = null;
    let outcome: string;
    if (event.livemode) {
      // Test mode only: a live event is never acted on, whatever it claims.
      outcome = "livemode_refused";
    } else if (event.kind === "ignored") {
      outcome = "ignored";
    } else {
      intent = await intentForEvent(tx, event);
      outcome =
        intent === null ? "unknown_intent" : await applyEvent(tx, intent, event, now, config);
    }
    await tx.paymentEvent.create({
      data: {
        provider: PAYMENT_PROVIDER,
        providerEventId: event.id,
        type: event.type.slice(0, 80),
        workspaceId: intent?.workspaceId ?? null,
        paymentIntentId: intent?.id ?? null,
        livemode: event.livemode,
        payloadSha256,
        outcome,
        receivedAt: now,
      },
    });
    return { outcome, duplicate: false, alert: ALERT_OUTCOMES.has(outcome) };
  });
}

// ── Recovery when the webhook never arrives ────────────────────────────────────

/** Checkouts left open this long are looked up at the provider. */
export const RECONCILE_AFTER_MS = 10 * 60_000;

/**
 * For intents still OPEN/PROCESSING after RECONCILE_AFTER_MS, asks the provider for the
 * session's status (server to server) and applies it exactly like the webhook would:
 * paid and matching → credited once; expired → EXPIRED. The browser plays no part.
 */
export async function reconcileOpenCheckouts(
  db: GuardedPrismaClient,
  provider: CheckoutProvider,
  config: CreditsConfig,
  now: Date = new Date(),
  limit = 20,
): Promise<{ readonly checked: number; readonly credited: number; readonly expired: number }> {
  const cutoff = new Date(now.getTime() - RECONCILE_AFTER_MS);
  // Across workspaces (a scheduled job, no tenant): ids only, by a reviewed raw query.
  const open = await db.$queryRaw<{ provider_checkout_id: string }[]>`SELECT provider_checkout_id
    FROM payment_intents WHERE status IN ('OPEN', 'PROCESSING') AND provider_checkout_id IS NOT NULL
      AND created_at < ${cutoff} ORDER BY created_at LIMIT ${limit}`;
  let credited = 0;
  let expired = 0;
  for (const { provider_checkout_id: checkoutId } of open) {
    const snapshot = await provider.getCheckout(checkoutId);
    const outcome = await db.$transaction(async (tx) => {
      const intent = await lockIntent(tx, { checkoutId });
      if (intent === null || !["OPEN", "PROCESSING"].includes(intent.status)) return "settled";
      if (snapshot.status === "complete") {
        return grantForCheckout(tx, intent, snapshot, now, config);
      }
      if (snapshot.status === "expired") {
        await setIntent(tx, intent, { status: "EXPIRED" });
        return "expired";
      }
      return "still_open";
    });
    if (outcome === "credited") credited += 1;
    if (outcome === "expired") expired += 1;
  }
  return { checked: open.length, credited, expired };
}

/** Unused credits of a workspace's card purchases (for tests and the overview). */
export async function purchasedBalance(db: Db, workspaceId: string, config: CreditsConfig) {
  return db.$transaction(async (tx) => {
    const account = await lockAccount(tx, workspaceId, new Date(), config);
    return account.purchasedCredits;
  });
}

export { creditsError };
