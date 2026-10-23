# Legal, privacy and tax checklist for a commercial launch (Pass 38, re-verified Pass 39, 2026-10-23)

**This is not legal advice and nothing here states that Flexibx is compliant.** It lists
what exists in the product, what is missing, and the questions a qualified lawyer and a
tax adviser must answer for the target markets (Arabic-first; default timezone
Asia/Riyadh; the markets themselves are an owner decision). Every row needs their review.

## 1. Documents

| Item                         | In the product today                                      | Needed / question for counsel                                                                                    |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Terms of service             | **Missing** (no page, no acceptance)                      | Text (ar/en), governing law, liability, acceptable use (ads, messaging), suspension, AI-output terms             |
| Privacy policy               | Draft only (`docs/legal/PRIVACY_POLICY_DRAFT.md`, blanks) | Final text; controller identity; legal bases; retention; transfers; rights; contact/DPO                          |
| Data processing agreement    | **Missing**                                               | Flexibx as processor for workspace data (customers' contacts, campaigns); template for business customers        |
| Subprocessor list            | **Missing** (placeholders in the draft)                   | Hosting (AWS region per R-2), storage (S3/Wasabi), email (Resend), AI (OpenAI, when enabled), Meta/WhatsApp APIs |
| Cookie notice                | **Missing**                                               | Whether session/auth cookies alone need a banner in the target markets                                           |
| Refund / cancellation policy | **Missing**                                               | Required before taking payments (PAYMENTS_DESIGN.md)                                                             |

## 2. Product features the law may require

| Feature                                | State                                                               | Question                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Terms/privacy acceptance at sign-up    | **Missing**                                                         | Required wording, versioning, re-acceptance on change                                      |
| Account deletion (user)                | **Missing** (operator-only paths; workspace soft delete, no purge)  | Deadlines, what may be retained (financial/audit records), deletion of backups             |
| Data export (user/workspace)           | Partial (Creator Studio project data only)                          | Scope and format of the right of access/portability                                        |
| Retention schedule                     | Videos 7 days, creator media purged; audit logs/workspace data kept | Maximum retention per category                                                             |
| Marketing consent (WhatsApp)           | Consent records, opt-out (STOP/START) — tested locally              | Lawful basis for messages customers send to their contacts; Meta/WhatsApp policy adherence |
| Meta data-deletion callback            | Exists, tested locally                                              | Meets Meta platform terms?                                                                 |
| Breach notification process            | Incident runbook exists; no legal notification steps                | Regulator/user notification deadlines                                                      |
| Data residency / cross-border transfer | Region not chosen (R-2); AI provider outside the region if enabled  | Whether personal data may be processed outside the market (e.g. Saudi PDPL transfer rules) |
| Age / eligibility                      | No check                                                            | Business-only service? minimum age?                                                        |

## 3. Tax and commerce (tax adviser)

- VAT registration of the selling entity; VAT rate and invoice content.
- E-invoicing obligations in the market (Saudi Arabia: ZATCA e-invoicing) and who issues
  the invoices (provider or Flexibx).
- Commercial registration / e-commerce law obligations (seller identity shown on the site,
  consumer-protection terms if consumers can buy).

## 4. What engineering does after the answers

Publish the pages (ar/en, versioned), record acceptance per user and version, build
self-service account deletion and workspace export, a retention job per category, a
subprocessor page, and the payment/invoice flows. Estimates in
`COMMERCIAL_LAUNCH_READINESS.md` § 9 start only once the approved texts exist.

## 5. Re-verified in the code (Pass 39)

- **Account deletion: does not exist for users.** Better Auth's `POST /delete-user` and
  `GET /delete-user/callback` pass the route allowlist but are disabled in the auth
  configuration: they answer 404 before reading the password (integration test
  `auth-entry-points.test.ts`, "no allowlisted endpoint checks a password…"; the user row
  stays). Workspaces are soft-deleted only. Building self-service deletion needs counsel's
  answers on deadlines, retained records (ledger, audit log) and backups first.
- **Data export: partial.** Only a Creator Studio project's data can be exported (project
  page, `studio-data-export`); there is no account- or workspace-wide export.
- **Session tokens are now stored hashed** (Pass 39): a database copy (including a backup)
  no longer contains usable session tokens — relevant to the breach-impact assessment.
- **Media uploads**: retained per the existing schedule; FFmpeg processing is local to the
  worker (no third party) unless the AI provider is enabled (then audio leaves for the
  provider — a subprocessor and transfer question, § 1 and § 2).

## 6. Decisions and reviews needed before selling (none taken here)

| Needs                                     | Who            | Blocks                                      |
| ----------------------------------------- | -------------- | ------------------------------------------- |
| Target markets and selling entity         | Owner          | Every row below                             |
| Terms, privacy policy, DPA, cookies       | Lawyer         | Sign-up acceptance, public launch           |
| Refund / cancellation policy              | Lawyer + owner | Payments (PAYMENTS_DESIGN.md § 9)           |
| Retention per category, deletion scope    | Lawyer         | Account deletion feature, backup retention  |
| Cross-border transfer (region, AI)        | Lawyer         | R-2 region choice, enabling the AI provider |
| VAT, e-invoicing, commercial registration | Tax adviser    | Invoices, prices shown with tax             |
| Breach notification procedure             | Lawyer         | Incident runbook completion                 |

Nothing in this repository states or implies compliance with any law.
