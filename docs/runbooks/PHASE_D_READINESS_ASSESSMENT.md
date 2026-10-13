# Phase D — production readiness assessment

Date: 2026-10-13. Baseline: `claude/amazing-sagan-pvouqy` at `7c15f2e` (Phase C.3 saved).

**Scope and honesty statement.** This is an assessment and a plan. Nothing in it has been
provisioned, configured, deployed or tested against a real external service: no hosting
account, managed database, backup bucket, scheduler, monitor, alert destination, secret
manager, Meta app review, Resend domain or payment provider exists for Flexibx today
unless this document says so explicitly. Where the repository already contains code or a
runbook for something, that is stated with its test status. No costs are estimated.

## 0. Where the code stands (verified in the repository)

| Area                          | State                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application image             | `Dockerfile` (Next.js standalone, non-root) and a `migrate` target; built locally once in Phase C.1 with a sandbox-only CA layer. CI builds it without that layer.                                                            |
| CI                            | `.github/workflows/ci.yml`: lint, typecheck, format, unit, migrations on a clean database, integration, build, end-to-end, Docker build, secret scan.                                                                         |
| Local validation (2026-10-13) | `pnpm test` 975/975, `pnpm test:integration` 748/748 (role tests included), `pnpm build`, `pnpm e2e` 36/36 — all on disposable databases.                                                                                     |
| Health and operations         | `/api/health` (liveness/readiness), `/api/internal/ops-status` (bearer secret; tick age, stuck work, ledger integrity), `/api/internal/automation-tick` and `/api/internal/video-retention` (bearer secret, for a scheduler). |
| Alerts                        | `ALERT_WEBHOOK_URL` (+ token): HTTPS JSON webhook, throttled per key; logs always.                                                                                                                                            |
| Backups                       | `scripts/ops/db-backup.sh` / `db-restore.sh` / `db-verify.sh` (no credentials on command lines); drills on throwaway databases only.                                                                                          |
| Database roles                | `scripts/ops/sql/db-roles.sql` + `docs/runbooks/DATABASE_ROLES.md`; tested on disposable roles; **not applied anywhere**.                                                                                                     |
| Platform admin                | MFA-gated admin area; grants through `pnpm admin:grant` (TOTP proof) and a SECURITY DEFINER function; `pnpm admin:mfa-reset` verified under the runtime role.                                                                 |
| Email                         | `MAIL_TRANSPORT=resend` (HTTPS API) or SMTP implemented; production refuses test transports. No sending domain verified.                                                                                                      |
| AI                            | `AI_PROVIDER=openai` implemented; `fake` refused in production. No production key provisioned.                                                                                                                                |
| Storage                       | S3-compatible (`LEGACY_S3`) and Wasabi adapters; Wasabi tested with test doubles only (`docs/STORAGE_PROVIDERS.md`).                                                                                                          |
| Meta ads / WhatsApp / Pages   | OAuth, read, execution and webhooks implemented and tested **against deterministic stand-ins only** (`docs/ADVERTISING.md`). Never exercised against real Meta.                                                               |
| Snapchat / TikTok             | Read-only connectors, tested against stand-ins; write paths blocked pending platform approval.                                                                                                                                |
| Billing                       | Internal credit ledger, plans and manual admin grants. **No payment provider integrated.**                                                                                                                                    |
| Generative video              | Only `fake` / `disabled`; no real provider.                                                                                                                                                                                   |

## A. Infrastructure

### A1. Hosting

Requirements from the code: a container runtime for the Next.js standalone image (Node 22),
rolling or blue/green deploys, a one-off job runner for the `migrate` target, per-service
secret injection, outbound HTTPS, log retention, a public HTTPS origin (needed for Meta
OAuth redirect URIs and webhooks), and private networking to PostgreSQL.

Candidate shapes (decision needed — § D5):

- **Managed container platform** (e.g. AWS ECS/Fargate, Google Cloud Run, Azure Container
  Apps, Fly.io, Render): runs the existing image unchanged; one-off jobs for migrations;
  native secret stores. Best fit for the current Dockerfile.
- **Vercel-style serverless hosting:** possible for the web app, but long-running work
  (tick, retention, video recovery) and the migrate job need a separate runner; request
  time limits must be checked against tick timeouts. More moving parts.
- **Single VM with Docker:** simplest, but backups, patching, TLS and failover become
  Flexibx's job; not recommended for production.

The region should be chosen with the data-residency expectations of the target customers
(Arabic-first market) and co-located with the database.

### A2. Managed PostgreSQL with point-in-time recovery

Requirements: PostgreSQL 16; PITR with a retention window agreed in advance; automated
daily snapshots; TLS (`sslmode=verify-full` with the provider CA — supported by the ops
scripts); ability to create login roles **without** superuser and to transfer object
ownership (needed by `DATABASE_ROLES.md`); `pgcrypto` and `citext` extensions; a direct
(non-pooled) connection for migrations and `pg_dump`; private networking. A connection
pooler, if used, must not run in transaction mode for migrations (`pgbouncer` URLs are
refused by the ops scripts).

### A3. Independent backups and object-storage versioning

- Logical dumps (`db-backup.sh`, owner credential) on a schedule, copied to a bucket in a
  **different account or provider** from the database, with versioning and object lock or
  retention, encryption at rest, and access limited to the backup job and two custodians.
- Media bucket (user uploads, generated videos): versioning on; lifecycle rules aligned
  with `docs/AI_VIDEO_RETENTION_POLICY.md` (retention deletes must still delete);
  replication optional.
- A monthly restore drill (`BACKUP_RESTORE.md` § 7 procedure) recorded with timings.

### A4. Scheduler and external monitoring

- Scheduler calling `POST /api/internal/automation-tick` every 1–5 minutes and
  `/api/internal/video-retention` on its schedule, with `AUTOMATION_CRON_SECRET` /
  retention secret as bearer tokens (platform cron, or a cloud scheduler).
- External uptime monitor on `/api/health` (liveness and `?scope=readiness`) and on
  `/api/internal/ops-status` with `OPS_STATUS_SECRET`; 503 = page someone. This is the only
  way to detect a stopped scheduler (the tick-age check goes critical after 15 minutes).

### A5. Alert destination

`ALERT_WEBHOOK_URL` must point to a real, watched destination (Slack/Teams incoming
webhook, or an incident tool's HTTPS endpoint) with an on-call owner. Verify by forcing a
test alert in staging.

### A6. Secret manager

All secrets in a managed secret store with per-service access, audit logging and
versioning: `DATABASE_URL` (runtime), owner credential (migrate and backup jobs only),
`ADMIN_GRANT_DATABASE_URL` (operators only), `AUTH_SECRET`, `ENCRYPTION_KEY`,
`AUTOMATION_CRON_SECRET`, `OPS_STATUS_SECRET`, `ALERT_WEBHOOK_TOKEN`, `RESEND_API_KEY`,
`OPENAI_API_KEY`, `META_APP_SECRET`, WhatsApp verify token, storage keys. No secret in
the repository, images, CI logs or chat; `.env` files are for local development only.

### A7. Rotating `AUTH_SECRET` and `ENCRYPTION_KEY`

The code has **no key versioning** (`INCIDENT_RESPONSE.md` § 4.6). Replacing a key today:

- `AUTH_SECRET`: invalidates every session and pending verification/reset link, and makes
  **every two-factor secret and backup code undecryptable** → every enrolled user (all
  platform administrators) must be reset (`pnpm admin:mfa-reset`) and re-enroll; admin
  authority is lost with the reset and needs a new grant.
- `ENCRYPTION_KEY`: makes every stored platform token unreadable → every workspace must
  reconnect Meta / WhatsApp / ads.

Plan:

1. Before production: generate both keys in the secret manager, escrow them with two
   named custodians separately from backups (`BACKUP_RESTORE.md` § 2), and treat rotation
   as an incident-only procedure until key versioning exists.
2. Engineering item (post-staging, before scale): key versioning — encrypt with the
   current key id, decrypt with any listed key, background re-encryption, then retire the
   old key. Separate the TOTP-secret encryption key from the session-signing secret so a
   session-secret rotation no longer resets MFA. Needs design and tests; not started.

## B. Database and roles

### B1. Review of `DATABASE_ROLES.md`

The runbook defines owner / runtime / grant roles, a staged cutover (backup and verified
restore, inventory, role creation, `db-roles.sql`, grant-path check, per-job credentials,
live verification, retiring the old credential), lock-out safety, rollback and a
verification checklist. It is consistent with the tested script. Gaps that only the
provider can close are listed in B5.

### B2. Requirements for applying the roles

- Three roles: owner (migrations, backups, emergency DBA), runtime (`flexibx_app`), grant
  (`flexibx_admin_grant`); runtime and grant non-privileged with no memberships.
- Migrations always run as the owner **login** (default privileges); `db-roles.sql` re-run
  after every migration (add it to the deploy pipeline after `migrate deploy`).
- Backup job and `db-verify.sh` use the owner credential (the runtime role cannot read
  `_prisma_migrations`; `pg_dump` as runtime fails — verified).

### B3. Rehearsal on a restored copy

Restore the latest backup into a staging database (`db-restore.sh`, `db-verify.sh` →
`VERIFIED`), run the full cutover there, run the § 3 checklist and the application smoke
test (sign-in, sign-up/verification, password reset, MFA enrollment and code/backup-code
sign-in, `admin:mfa-reset`, a workspace write, a credit operation, tick, ops-status, admin
area). Record timings and any permission errors; fix only in `db-roles.sql`.

### B4. Backup before cutover

No production cutover without a same-day backup restored and verified (`VERIFIED`) on a
throwaway database.

### B5. Provider requirements

The provider must allow: creating login roles and setting passwords from the console or
SQL without superuser; `ALTER … OWNER TO` for all objects in the database; `ALTER DEFAULT
PRIVILEGES`; column-level privileges; SECURITY DEFINER functions owned by a non-superuser.
Some managed services restrict ownership changes or role attributes — confirm before
choosing (decision D5).

### B6. Residual TOTP-replay risk tied to the grant role (open, not resolved)

The grant role holds DELETE on `two_factor_used_codes` because the code claim purges
expired rows. A holder of the grant credential could therefore delete **unexpired** claim
rows and make a recently used TOTP code acceptable again for sign-in within its acceptance
window (about 90 seconds). Severity: Low (the same person can already grant administrators
— a stronger power — and every grant is audited), but it is a real gap and is **not**
considered fixed. Options: (a) move the purge into a SECURITY DEFINER function that only
deletes expired rows and drop the grant role's DELETE; (b) leave purging to the runtime
path only. Either needs a migration, a role-script change and a test. Also inherent: grant
credential holders can grant without a TOTP code (the database cannot verify TOTP).

## C. Integrations and launch

### C1. Meta App Review and permissions

What the code requests (from the source and `docs/ADVERTISING.md`):

- Ads read: `ads_read` (Advanced/"Full" access via App Review for other businesses'
  accounts), Business Verification.
- Ads execution (only when `ADS_EXECUTION_ENABLED=true`): `ads_management`,
  `pages_show_list`, `pages_manage_ads`.
- Social manager (Pages and Instagram): `pages_read_engagement`, `pages_manage_engagement`,
  `pages_manage_metadata`, `pages_messaging`, `pages_manage_posts`, `instagram_basic`,
  `instagram_manage_comments` (`docs/ARCHITECTURE.md`).
- WhatsApp: `whatsapp_business_management`, `whatsapp_business_messaging`; Tech Provider /
  Partner status, Business Verification and Advanced access.
- App Review also needs the deauthorize and data-deletion callbacks (implemented:
  `/api/integrations/meta/deauthorize`, `/data-deletion`), a public privacy policy
  (`docs/legal/PRIVACY_POLICY_DRAFT.md` is a draft), screencasts and test users.

State today (`ADS_WHATSAPP_LIVE_TEST_SETUP.md` § 0): a Meta Business app exists with the
Marketing API use case; redirect URI not registered (no public HTTPS origin); no test ad
account, WABA, templates or webhook subscription. **Nothing has been exercised against
real Meta.**

### C2. Webhooks and Page ownership

- Endpoints: `/api/integrations/meta/webhook` (Pages/Instagram, `X-Hub-Signature-256`
  verified, body size capped) and `/api/integrations/whatsapp/webhook`; GET verification
  with the configured verify token.
- Needed: public HTTPS origin, app subscription to the Page/WABA, verify token in the
  secret manager. Page ownership is enforced by Flexibx through the Page `tasks`
  (ADVERTISE for ads) and the connection's granted Pages; a supervised live test
  (`ADS_WHATSAPP_LIVE_TEST_SETUP.md` § 7) must confirm it against real Meta.

### C3. Resend and the sending domain

`MAIL_TRANSPORT=resend` + `RESEND_API_KEY`; needs a verified sending domain (SPF, DKIM,
DMARC records), a from-address, bounce/complaint handling decision, and a staging test of
verification, reset and invitation emails to real inboxes. Not set up.

### C4. Supported vs not yet complete

- **Implemented and tested locally (stand-ins for external APIs):** accounts, MFA,
  workspaces and roles, marketing core, AI content (OpenAI adapter), credits ledger,
  Meta ads read/plan/launch (paused-first, approvals, spend limits), WhatsApp sending with
  consent, Page publishing and social replies (kill switch `SOCIAL_SENDING_ENABLED`),
  scheduler, monitoring, backups, role separation.
- **Not complete:** any real-Meta validation; Snapchat/TikTok writes; generative video
  provider; payment provider and invoices; security notification emails; key versioning;
  RLS; Instagram placements and other ad objectives (refused by design today).

### C5. Payment provider (decision needed before real billing)

Billing today is a credit ledger with manual grants. Before charging customers: choose a
provider (Stripe or a regional processor — open decision D11 in
`AI_MARKETING_EMPLOYEE_ROADMAP_4_6.md`), considering supported countries/currencies (the
ads code refuses some zero-decimal currencies), VAT/e-invoicing obligations in the target
markets, and webhook-driven reconciliation into the credit ledger. Not started.

### C6. Checks before a limited pilot

Staging green on the full acceptance list (D3); production database with PITR and a
verified restore; role cutover done; scheduler, monitor and alerts proven by a forced
failure; Resend domain verified; kill switches documented and tested
(`SOCIAL_SENDING_ENABLED`, `WHATSAPP_SENDING_ENABLED`, `ADS_EXECUTION_ENABLED`,
`AI_PROVIDER=disabled`); a supervised real-Meta test with spend limits at the minimum;
privacy policy and terms published; incident on-call named.

## D. Ordered plan

Priority: P0 = blocks the stage; P1 = needed for the stage but can run in parallel;
P2 = before scale.

### D1. Before staging

| #   | Item                                                                      | Pri | Depends on  | How to verify                                                   | Done when                                             |
| --- | ------------------------------------------------------------------------- | --- | ----------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| S1  | Choose hosting, region and managed PostgreSQL (meets B5)                  | P0  | D5 decision | Provider docs confirm role/ownership features; written decision | Decision recorded                                     |
| S2  | Secret manager with per-service access                                    | P0  | S1          | Each service reads only its secrets; access log shows reads     | All staging secrets stored; none in files/CI logs     |
| S3  | Staging environment: app container, migrate job, private DB, HTTPS origin | P0  | S1, S2      | `/api/health?scope=readiness` 200; migrate job runs as owner    | Staging reachable over HTTPS; migrations applied      |
| S4  | Database roles applied in staging (DATABASE_ROLES.md § 2 incl. step 0)    | P0  | S3          | § 3 checklist + `db-roles.test.ts` scenarios by hand            | All checks pass; app runs as `flexibx_app`            |
| S5  | Scheduler + external monitor + alert destination                          | P0  | S3          | Stop the scheduler → ops-status 503 → alert received            | Forced-failure drill recorded                         |
| S6  | Backup job to independent versioned bucket + restore drill                | P0  | S3          | `db-verify.sh` → `VERIFIED` on a restored copy                  | Drill recorded with timings                           |
| S7  | Resend domain (staging subdomain) and email flows                         | P1  | S3          | Verification, reset, invitation emails arrive; SPF/DKIM pass    | All three received at test inboxes                    |
| S8  | Meta app: register staging redirect URIs and webhooks; test users         | P1  | S3          | OAuth connect and webhook verification succeed in staging       | Supervised test (§ 7 of the live-test runbook) passes |

### D2. Before production

| #   | Item                                                                     | Pri                  | Depends on   | How to verify                                           | Done when                                        |
| --- | ------------------------------------------------------------------------ | -------------------- | ------------ | ------------------------------------------------------- | ------------------------------------------------ |
| P1  | Production database with PITR; restore test from PITR                    | P0                   | S1           | Point-in-time restore into a scratch instance           | Restore succeeds within the agreed time          |
| P2  | Production role cutover (rehearsed in S4)                                | P0                   | P1, S4, S6   | § 3 checklist on production; old credential rejected    | Runtime role live; owner credential only in jobs |
| P3  | Keys generated and escrowed (A7 step 1)                                  | P0                   | S2           | Two custodians confirm access; not stored with backups  | Escrow record signed                             |
| P4  | Meta App Review (permissions per enabled feature), Business Verification | P0 for Meta features | S8           | Approved permissions visible in the app dashboard       | Approval for every permission the launch uses    |
| P5  | Production email domain verified                                         | P0                   | S7           | DMARC report clean; test emails delivered               | Verified domain in Resend                        |
| P6  | Privacy policy and terms published; data-deletion callback URL live      | P0                   | legal review | Public URLs reachable; Meta accepts the callback        | Published                                        |
| P7  | Grant-role replay gap (B6) closed or explicitly accepted                 | P1                   | —            | Test that the grant role cannot delete unexpired claims | Merged fix with test, or written acceptance      |
| P8  | Payment provider chosen and integrated (only if charging at launch)      | P0 if charging       | D5 decision  | Sandbox payments reconcile into the ledger              | Sandbox end-to-end test passes                   |
| P9  | Key versioning (A7 step 2)                                               | P2                   | —            | Rotation test re-encrypts and keeps MFA working         | Shipped with tests                               |

### D3. Security and operational acceptance tests (run in staging, then production)

1. Role boundary: runtime role refused on the admin flag, functions, trigger, DDL, audit
   rewrite; grant via grant role only with a valid code; `admin:mfa-reset` under runtime.
2. Auth: sign-up + verification, password reset, MFA enrollment, TOTP and backup-code
   sign-in, replay refused, lockout after failures, admin area MFA freshness.
3. Tenancy: cross-workspace access returns 404 (existing tests plus a manual spot check).
4. Kill switches: each one stops its external effect.
5. Monitoring: scheduler stop → alert; ledger inconsistency injected in staging → critical.
6. Backup/restore: restore drill `VERIFIED`; PITR restore.
7. Webhooks: signature tampering rejected; oversized body rejected.
8. Secrets: no secret in logs (grep of a day's logs), images or CI output.

### D4. Risks accepted temporarily (with impact)

| Risk                                            | Impact                                                                                                            | Until                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------- |
| No key versioning                               | A key rotation forces MFA re-enrollment / integration reconnects                                                  | P9                   |
| Grant credential holders can grant without TOTP | Insider with that credential can create admins (audited)                                                          | Accepted by design   |
| Grant-role replay gap (B6)                      | A grant-credential holder could re-enable a used TOTP code for ~90 s                                              | P7                   |
| Meta integrations unvalidated against real Meta | Unknown API behaviour on first use; mitigated by paused-first creation, spend limits, approvals and kill switches | S8 / supervised test |
| No security notification emails                 | Users are not told about password/MFA changes                                                                     | Product decision     |
| Superuser/owner can bypass controls             | Database administrators are fully trusted                                                                         | Inherent             |
| Ledger integrity check scans all accounts       | Linear cost (≈1.2 s per 100k accounts measured locally)                                                           | Revisit at scale     |

### D5. Decisions and information needed from you

1. Hosting provider and region (and data-residency requirements of target customers).
2. Managed PostgreSQL provider (must satisfy B5) and PITR retention period.
3. Backup bucket provider/account (independent from the database) and retention.
4. Scheduler, uptime monitor and alert destination (and who is on call).
5. Secret manager.
6. Which features launch first (ads read, ads execution, WhatsApp, Page publishing/replies,
   AI) — this decides the Meta permissions to submit.
7. Sending domain for email.
8. Whether the pilot charges money; if yes, payment provider and markets.
9. Accept or fix the grant-role replay gap (B6) before production.
10. Who holds the owner, grant and key-escrow credentials (names, at least two).

## E. Not done in this phase

No infrastructure, account, secret, domain, database, role or app review was created or
changed; no deployment; no migration on any persistent database; no message, email or ad
was sent; no application code was changed.
