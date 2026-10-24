# Commercial decision pack — payments, privacy, legal, tax (Pass 40, 2026-10-24)

For the owner, a lawyer and a tax adviser in each target market. **Nothing here is legal or
tax advice, and nothing states that Flexibx is compliant.** No merchant account, real card
or real money was used.

## 1. Built and tested vs needing approval

| Area                                  | Built in code (tested locally)                                                                    | Needs a professional or owner decision                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Credits ledger                        | Append-only, database-enforced; holds/capture/release; caps                                       | Whether credits are a prepaid instrument in the market (lawyer)     |
| Who can raise a balance               | Only a platform admin with fresh MFA; a customer is refused (test, Pass 40); owners set caps only | —                                                                   |
| Payments                              | Boundary only; no provider                                                                        | Provider, merchant account, currency, markets                       |
| Webhooks                              | Design and test plan (`PAYMENTS_DESIGN.md` § 7)                                                   | Built after the provider is chosen; sandbox keys from the owner     |
| Account deletion                      | **Absent** (`/delete-user` disabled, 404)                                                         | Scope, deadline, what is retained (ledger, audit), backups (lawyer) |
| Data export                           | Per Creator Studio project only                                                                   | Required scope and format (lawyer)                                  |
| Retention                             | Videos 7 days; creator media purged; audit and workspace data kept                                | Maximum per category (lawyer)                                       |
| Session data at rest                  | Tokens hashed (Pass 39)                                                                           | —                                                                   |
| Terms, privacy, DPA, cookies, refunds | Privacy policy draft with blanks only                                                             | All texts (lawyer), acceptance at sign-up then built                |
| Invoices / VAT                        | Nothing                                                                                           | Tax adviser (§ 4)                                                   |

## 2. Payment provider selection (no provider chosen)

Requirements and the comparison matrix: `PAYMENTS_DESIGN.md` § 8. The owner supplies, per
candidate and in writing from the provider: market licence and settlement currency,
hosted checkout, local methods (e.g. mada / Apple Pay in Saudi Arabia, if required),
signed webhooks with event ids and replay tolerance, a payment-status API, idempotency keys,
sandbox quality, refunds/disputes/settlement APIs, saved methods (for auto top-up), invoice
support, fees and reserve terms.

## 3. Sandbox test design (to run against the chosen provider's sandbox)

`PAYMENTS_DESIGN.md` § 7 (valid event, replay, replay outside window, duplicate payment,
tampered body, amount/currency mismatch, unknown intent, out of order, lost webhook,
database down at delivery, refunds and disputes) and § 9 (acceptance before real money,
including one controlled live transaction only with explicit owner approval).

## 4. Tax and e-invoicing — questions for the tax adviser

Answers depend on the selling entity and each market; the items below are what to ask,
not answers.

- VAT registration of the selling entity; the rate on a digital B2B/B2C service in each
  market (Saudi Arabia's standard rate is currently understood to be 15% — **confirm**).
- Saudi Arabia: ZATCA e-invoicing ("Fatoora") — which phase and wave applies to the
  entity, whether the payment provider's invoices suffice, required invoice fields, QR code,
  cryptographic stamp and integration with ZATCA's platform.
- Other markets: their VAT/GST rules for foreign digital-service sellers.
- Invoice numbering, credit notes for refunds, record retention period.
- Commercial registration and e-commerce law: seller identity on the site, consumer terms
  if consumers can buy.

## 5. Pages and approvals needed before selling

Terms of service; privacy policy (controller identity, legal bases, retention, transfers,
rights, contact); data processing agreement for business customers; subprocessor list
(hosting region per R-2, S3/Wasabi, Resend, OpenAI if enabled, Meta/WhatsApp APIs); cookie
notice if required; refund and cancellation policy; seller identity page. Each approved by
a lawyer in the target market, versioned, and accepted at sign-up (feature to build after
the texts exist).

## 6. Owner decisions, in the order they unblock the most

1. Target markets and selling entity (everything else depends on them).
2. Engage a lawyer and a tax adviser in those markets.
3. Payment provider (after § 2 answers) and a sandbox account.
4. Refund and negative-balance policy.
