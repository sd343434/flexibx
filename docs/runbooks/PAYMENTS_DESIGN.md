# Payments and billing — requirements and design (Pass 38, extended Pass 39, 2026-10-23)

**Status: no payment provider exists. Customers cannot pay.** Nothing below is
implemented; this is the design to implement once the owner has chosen a provider and
opened a merchant account. No real merchant account, card or money was used.

## 1. What exists today (verified in the code)

| Piece                                            | State                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credits ledger (`src/server/billing/credits.ts`) | Append-only, database-enforced; holds → capture/release; daily, period and feature caps; abandoned holds released after 15 min. Tested locally.       |
| Plans (`pricing.ts`)                             | trial / starter / growth / payg — **PROVISIONAL**, credit allowances an administrator assigns; no recurring charge.                                   |
| Admin top-up (`billing-service.ts`)              | Platform admin with fresh MFA adds credits against an invoice sent outside the app; idempotent (request key + version).                               |
| Payment boundary (`payments.ts`)                 | `PaymentProvider.charge({workspaceId, credits, idempotencyKey})`; `getPaymentProvider()` returns `null`.                                              |
| Auto top-up                                      | Coded against that boundary; inactive (`skipped`) without a provider. An "uncertain" charge stays PENDING and blocks later top-ups (no resolver yet). |

The internal credits are **not** payments and must never be shown as such (no "paid",
"receipt" or "invoice" wording on credit grants).

## 2. Requirements for real payments

1. **Provider and merchant account** (owner): supported in the target market, settling in
   the chosen currency, with a sandbox; contract, fees, payout schedule, chargeback terms.
2. **Checkout**: hosted payment page or provider-hosted fields (card data never touches
   Flexibx servers — keeps PCI DSS scope to the lightest self-assessment level; confirm
   with the provider). Local methods the market expects (e.g. mada in Saudi Arabia, Apple
   Pay) depend on the provider.
3. **Outcome handling**: succeeded, failed, pending/3-D Secure, cancelled, expired; the
   browser redirect is never trusted — only a verified webhook or a server-side lookup
   credits the account.
4. **Webhooks**: signature verified with the provider's secret; raw body; replay window;
   idempotent by the provider's event id (unique constraint); out-of-order events tolerated;
   2xx only after the database commit.
5. **No double charge, no double credit**: one idempotency key per purchase intent (sent to
   the provider); credits granted once per provider payment id (unique constraint in the
   ledger); "uncertain" outcomes resolved by a server-side status query, never by retrying
   the charge.
6. **Refunds and disputes**: full/partial refund through the provider; ledger entry that
   removes the unspent credits (or records a negative balance policy); chargeback webhook
   freezes further purchases and alerts.
7. **Reconciliation**: daily job comparing provider settlements/payouts with ledger credits
   (count and amount); mismatches alert; report for finance.
8. **Invoices and tax**: tax invoices with the seller's tax number, sequential numbering,
   VAT at the applicable rate, and the market's e-invoicing rules (in Saudi Arabia, ZATCA
   e-invoicing ("Fatoora") — scope and phase to be confirmed by a tax adviser). Whether the
   provider issues them or Flexibx must, is an owner/tax decision.
9. **Subscriptions** (if plans become recurring): renewals, proration, dunning, cancellation
   at period end, grace period, and the plan → credit allowance link already in `pricing.ts`.
10. **Operations**: payments kill switch (env), alerts on webhook failures and reconciliation
    mismatches, audit log entries for every money-affecting action, data retention for
    financial records as the law requires.

## 3. Integration design (provider-agnostic)

Extend the existing boundary instead of replacing it:

```ts
interface PaymentProvider {
  readonly name: string;
  createCheckout(input: { workspaceId; packageId; amountMinor; currency; idempotencyKey;
    successUrl; cancelUrl }): Promise<{ checkoutId: string; redirectUrl: string }>;
  verifyWebhook(rawBody: string, headers: Headers): ProviderEvent;   // throws on bad signature
  getPayment(paymentId: string): Promise<{ status; amountMinor; currency; reference }>;
  refund(input: { paymentId; amountMinor; idempotencyKey }): Promise<RefundResult>;
  charge(...): Promise<ChargeResult>;                                 // existing, saved method
}
```

Data model additions (one migration, tenant-guarded): `payment_intents` (workspace, package,
amount, currency, idempotency key UNIQUE, provider checkout id, status, timestamps),
`payment_events` (provider event id UNIQUE, type, payload hash, processed_at), a unique
`provider_payment_id` on the ledger credit entry, `refunds`. Route: `POST
/api/payments/webhook/<provider>` (raw body, signature, 200 only after commit).

## 4. Test plan (sandbox only)

- Unit: signature verification (valid, tampered, expired timestamp), event mapping, amount and
  currency checks, idempotency (same event twice → one credit).
- Integration (real database, fake provider): success, failure, 3-D Secure pending then
  success, duplicate webhook, out-of-order events, webhook before redirect, redirect without
  webhook (status lookup), refund, partial refund, chargeback, reconciliation mismatch.
- Provider sandbox (needs the owner's sandbox keys; no real money): end-to-end checkout with
  the provider's test cards; webhook delivery to staging.

## 5. Owner decisions

| Decision                                             | Why it blocks                                       |
| ---------------------------------------------------- | --------------------------------------------------- |
| Provider (and whether it must support local methods) | Defines the API, fees, settlement, compliance scope |
| Merchant entity, bank account, currency              | Required to open the account                        |
| Final prices, plans, recurring vs. prepaid           | `pricing.ts` is provisional                         |
| VAT registration and e-invoicing responsibility      | Invoices cannot be issued without it (tax adviser)  |
| Refund and negative-balance policy                   | Ledger behaviour on refunds/chargebacks             |

## 6. Ledger versus the provider's financial truth (Pass 39)

Two records, never confused:

| Record                         | Owner                | Answers                                       | Never used for                               |
| ------------------------------ | -------------------- | --------------------------------------------- | -------------------------------------------- |
| Provider payments, settlements | The payment provider | Was money taken, refunded, disputed, paid out | —                                            |
| `payment_intents` / `events`   | Flexibx (mirror)     | What we asked for, which events we processed  | Proving money moved (only the provider does) |
| Credits ledger                 | Flexibx              | What a workspace may consume                  | Accounting, tax, revenue — it is not money   |

Rules: credits are granted **only** by the server, from a verified provider event or a
server-side `getPayment` lookup, once per provider payment id; the reconciliation job (§ 2.7)
treats the provider as the truth and alerts on any difference instead of "fixing" the
provider side.

**The client cannot change payment state — verified in the code today:** the only billing
server action available to workspace users (`submitCreditSettings`) sets caps and the
auto top-up preference (owners only, versioned); credits are added only by
`submitAddCredits` / `submitChangePlan` in the platform admin area (platform admin with
fresh MFA, idempotent); no route or action accepts a payment status, amount or payment id
from the browser. The future checkout keeps this: the success redirect shows "processing"
and reads the state the webhook wrote; it never writes.

## 7. Webhook test design (to implement with the provider; sandbox only)

| Case                         | Input                                                          | Expected                                                                       |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Valid event                  | Signed `payment.succeeded`, amount = intent                    | One credit entry; event row processed; 200 after commit                        |
| Replay (same event id)       | The same body and signature again, minutes or days later       | 200, no second credit (UNIQUE provider event id); counted as duplicate         |
| Replay outside the window    | Valid signature, timestamp older than the provider's tolerance | 400, nothing written                                                           |
| Duplicate payment, new event | Two different event ids for one provider payment id            | One credit (UNIQUE `provider_payment_id` on the ledger entry)                  |
| Tampered body / wrong secret | Body changed after signing; signature from another secret      | 400, nothing written, alert after N in a window                                |
| Amount mismatch              | Event amount or currency ≠ the intent's                        | No credit; intent `NEEDS_REVIEW`; critical alert; manual resolution with audit |
| Unknown intent               | Event for an id we never created                               | 200 (stop retries), recorded, alert                                            |
| Out of order                 | `refund` before `succeeded`; `succeeded` after `failed`        | Final state from a `getPayment` lookup, never from arrival order               |
| Webhook lost                 | Redirect back, no event                                        | Status lookup job resolves PENDING intents; credit once                        |
| Database down at delivery    | Commit fails                                                   | 5xx so the provider retries; no partial credit (one transaction)               |
| Refund / partial / dispute   | Signed events                                                  | Ledger removal per the refund policy; dispute freezes purchases + alert        |

## 8. Provider acceptance criteria and comparison (no provider chosen)

A provider is acceptable only if **all** of these hold (answers come from its contract and
documentation, verified by the owner — not assumed here):

1. Licensed to acquire in the target market(s) and settles to the owner's bank in the
   chosen currency.
2. Hosted checkout or hosted fields (card data never on Flexibx servers).
3. The local methods the market expects (e.g. mada, Apple Pay in Saudi Arabia) if required.
4. Signed webhooks with event ids, retries, and a replay tolerance; a payment-status API.
5. Idempotency keys on create/charge/refund.
6. A sandbox with test cards, 3-D Secure and failure simulations, and webhook delivery to
   a non-production URL.
7. Refund (full/partial) and dispute APIs and events; settlement/payout reports via API.
8. Saved payment methods (for auto top-up) under the scheme's rules, if auto top-up stays.
9. Invoice or e-invoicing support, or clean data for Flexibx to issue them (tax adviser).
10. Fees, payout schedule, reserve and chargeback terms acceptable to the owner.

Comparison matrix for the owner to fill (one column per candidate; leave "unknown" until
confirmed by the provider in writing):

| Criterion (above)                   | Candidate A | Candidate B | Candidate C |
| ----------------------------------- | ----------- | ----------- | ----------- |
| 1 Market licence / settlement       |             |             |             |
| 2 Hosted checkout                   |             |             |             |
| 3 Local methods                     |             |             |             |
| 4 Signed webhooks + status API      |             |             |             |
| 5 Idempotency keys                  |             |             |             |
| 6 Sandbox quality                   |             |             |             |
| 7 Refunds, disputes, settlement API |             |             |             |
| 8 Saved methods                     |             |             |             |
| 9 Invoices / e-invoicing            |             |             |             |
| 10 Fees and terms                   |             |             |             |

## 9. Acceptance criteria before taking real money

All § 7 cases pass against the chosen provider's **sandbox** from hosted staging; the
reconciliation job runs a full day of sandbox payments with zero unexplained differences;
the payments kill switch stops checkout without affecting existing credits; refund and
dispute flows tested; the refund/cancellation policy, terms and invoice handling approved
by counsel and the tax adviser; then one controlled live transaction **only with the
owner's explicit approval**.
