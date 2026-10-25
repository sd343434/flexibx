# Stripe Sandbox integration — Flexibx

Status: implementation branch; sandbox only. Implemented and tested locally (see "Implementation status"); not yet verified in CI or hosted staging.

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

The saved-method `PaymentProvider.charge()` is unchanged and `getPaymentProvider()` still returns `null` (automatic top-up stays off). Card checkout is a separate `CheckoutProvider` boundary in the same file.

## Implementation status (this branch)

Implemented and tested **locally only** (no CI run, no hosted webhook delivery yet):

| Piece                                                                                                                                                                      | Where                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Test-mode env guard (all-or-nothing; `STRIPE_MODE=test`; `sk_live_`/`rk_live_` refused; startup fails on invalid config)                                                   | `src/server/env-schema.ts`, `startup-env.ts`                          |
| Pinned SDK `stripe@23.0.0`                                                                                                                                                 | `package.json`, `pnpm-lock.yaml`                                      |
| Server-only adapter (Checkout Session, idempotency key per intent, response checks, signature verification on raw bytes, 300 s tolerance)                                  | `src/server/billing/stripe-provider.ts`                               |
| Server-owned packages (USD, integer cents): $10/500, $35/2,000, $80/5,000 credits — **temporary, Sandbox only**                                                            | `src/server/billing/packages.ts`                                      |
| `payment_intents` / `payment_events` tables, unique keys, CHECKs, immutability and append-only triggers                                                                    | `prisma/migrations/20261025090000_stripe_checkout/`                   |
| Checkout start, event processing (dedupe, match rules, grant once via the credit ledger, refunds, disputes, out-of-order, NEEDS_REVIEW), reconciliation of stale checkouts | `src/server/billing/checkout-service.ts`                              |
| Webhook endpoint `POST /api/payments/webhook/stripe` (503 unconfigured, 413, 400 bad signature/payload, 500 retryable, 200 committed)                                      | `src/app/api/payments/webhook/stripe/route.ts`, `checkout-runtime.ts` |
| Billing page buy card (owner only) and read-only return notice — the redirect never grants credits                                                                         | `src/app/[locale]/w/[workspaceSlug]/billing/`                         |
| Reconciliation runs in the automation tick (`payments` phase; no-op when unconfigured)                                                                                     | `src/server/orchestration/runtime.ts`                                 |

## Configuration (test mode)

Set all three or none (placeholders — never commit real values):

```
STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_...        # or a restricted rk_test_ key
STRIPE_WEBHOOK_SECRET=whsec_...      # from `stripe listen` or the test-mode endpoint
```

Unset → card checkout is off (buy card shows "unavailable", webhook answers 503). Partial or live values → the server refuses to start; the error names the variable, never the value.

Migration: `pnpm db:migrate` (dev) / `prisma migrate deploy` (non-production staging only after review). Never against production in this phase.

## Testing with Stripe test cards (local)

1. Install the Stripe CLI and log in to the **test-mode** account: `stripe login`.
2. Forward events: `stripe listen --forward-to localhost:3000/api/payments/webhook/stripe`. Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`, put the account's `sk_test_...` into `STRIPE_SECRET_KEY`, set `STRIPE_MODE=test`, restart `pnpm dev`.
3. As a workspace OWNER open `/en/w/<slug>/billing` → Buy credits → pick a package → pay on the Stripe page:
   - `4242 4242 4242 4242` (any future date, any CVC) → succeeds; credits appear only after the `checkout.session.completed` webhook.
   - `4000 0000 0000 0002` → declined (`payment_intent.payment_failed`; no credits).
   - `4000 0025 0000 3155` → 3D Secure; complete or fail the challenge.
   - Close the page / Back → cancelled notice, nothing granted; the session later expires (`checkout.session.expired`).
4. Refund: Dashboard (test mode) → Payments → Refund (full or partial) → `charge.refunded` removes credits proportionally (shortfall recorded if already spent).
5. Dispute: pay with `4000 0000 0000 0259` → `charge.dispute.created` (further checkouts refused for the workspace while open); submit evidence in the Dashboard for `charge.dispute.closed`.
6. Replay: `stripe events resend <evt_id>` → answered 200, recorded once, no double credit.
7. Redirect without webhook: stop `stripe listen`, pay, then run the automation tick after 10 minutes — reconciliation reads the session from Stripe and credits it once.

Hosted test endpoint (non-production staging): Dashboard (test mode) → Developers → Webhooks → Add endpoint `https://<staging-host>/api/payments/webhook/stripe`, events `checkout.session.*`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`; put its signing secret in the staging secret store as `STRIPE_WEBHOOK_SECRET`.

## Still open before "done"

- Hosted non-production webhook delivery not yet verified (needs a staging deploy with test keys).
- CI blocked at the GitHub account level; local results only.
- Package prices ($10/500, $35/2,000, $80/5,000 credits) are temporary and approved for Sandbox only; live prices need a separate owner decision.
- Legal/tax, invoices/receipts and live mode remain out of scope.
