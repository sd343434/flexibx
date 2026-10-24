# Stripe Sandbox integration — Flexibx

Status: implementation branch; sandbox only. This document is not evidence that payment processing is implemented.

## Selected path
Use the existing `src/server/billing/payments.ts` boundary and the existing append-only credit ledger. Stripe Checkout is the initial customer-facing flow. Do not add a second provider unless Stripe proves unavailable for the merchant entity.

## Hard environment guard
- Checkout creation must fail closed unless `STRIPE_MODE=test`.
- The server key must be a Stripe test secret (`sk_test_`); reject live keys.
- Webhook signing secret must be a test endpoint secret and must never be accepted from client input.
- Do not expose keys in browser bundles, logs, errors, or URLs.
- Do not use live Stripe API keys, live products/prices, real cards, real subscriptions, or production money movement in this phase.

## Required implementation
1. Add Stripe SDK as a pinned dependency and update the lockfile using the repository's package manager.
2. Create a server-only adapter for Checkout Session creation. Accept a server-owned package ID and workspace ID; derive amount/currency from trusted server configuration, never from the browser. Use USD and integer minor units.
3. Persist a payment intent before redirecting. Enforce uniqueness for the purchase idempotency key and provider payment/session ID.
4. Add a webhook route that reads the unmodified raw request body and verifies the Stripe signature using the configured test webhook secret. Never parse/serialize JSON before signature verification.
5. Handle duplicate and out-of-order events safely. Grant credits only once after a verified successful payment whose amount, currency, workspace, package, and intent all match persisted server state. A browser success redirect must never grant credits.
6. Record event IDs idempotently and return a retryable server error if the database transaction fails.
7. Add refund/dispute state handling and a reconciliation/status-recovery path before considering production readiness.

## Sandbox test matrix
- Checkout success, declined test card, 3DS/authentication, cancellation.
- Missing/bad webhook signature and modified payload.
- Duplicate delivery of the same event and two events for the same payment.
- Amount/currency mismatch, unknown session, and cross-workspace metadata tampering.
- Webhook before browser redirect; redirect without webhook; out-of-order events.
- Database failure during processing, refund, dispute, and reconciliation mismatch.

## Definition of done for this branch
- Unit and integration tests pass locally, with no live credentials.
- Lockfile and Prisma migration are reviewed.
- Hosted non-production webhook delivery is verified with test keys.
- CI and hosted staging results are recorded separately from local results.
- No live mode until legal/tax, refunds, invoice handling, and owner approval are complete.

## Current repository facts
The existing `PaymentProvider` currently only exposes saved-method `charge()`, and `getPaymentProvider()` returns `null`. The payments design document proposes checkout, verified webhooks, payment intents/events, refunds, and reconciliation. This document does not claim those pieces already exist.
