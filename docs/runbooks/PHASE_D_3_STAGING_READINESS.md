# Phase D.3 — staging readiness and operational verification

Date: 2026-10-15. Branch `claude/amazing-sagan-pvouqy`, HEAD `fdccb3a` (equal to the
remote; verified with `git fetch`). Inputs: `PHASE_D_READINESS_ASSESSMENT.md`,
`PHASE_D_1_INFRASTRUCTURE_DECISIONS.md`, `PHASE_D_2_SECURITY_HARDENING.md`,
`DATABASE_ROLES.md`, `BACKUP_RESTORE.md`, `DEPLOYMENT.md` (none modified).

**Scope and honesty statement.** Audit, planning and local verification only. No cloud
account, resource, secret, domain or role was created; nothing was deployed; no
persistent database was contacted (only throwaway databases on a local PostgreSQL 16,
dropped afterwards); no message, email or ad was sent; no application code, migration,
Dockerfile or runtime configuration was changed. Every "verified" below names the check
that was actually run; everything else is "not verified".

## 1. Executive summary

- **The code side is ready for a staging rehearsal**: on HEAD `fdccb3a` every local gate
  passes (§ 3), including the role-boundary and TOTP-claim tests on disposable roles.
- **Staging cannot start yet.** Blocking items are decisions and infrastructure, not code:
  1. **Data residency is undecided** (D.1 § 15.4). Until it is decided — with legal advice
     — no hosting provider or region can be chosen. This document does not decide it.
  2. Hosting provider, region and a staging budget are not approved.
  3. Account owners and at least two credential custodians are not named.
  4. The `ops` image (PostgreSQL 16 client) has **never been built to completion**: this
     environment's network policy blocks the Debian and PostgreSQL package mirrors.
  5. Nothing about managed PostgreSQL (roles, `rds_superuser`-style memberships,
     ownership transfer, SECURITY DEFINER, default privileges) has been proven on a real
     managed service.
- Two small engineering items should be approved before the rehearsal: a time limit for
  the scheduled tick (it has none) and building `--target ops` in CI.
- **Recommended next step** (§ 8): decide data residency, then approve the hosting
  provider/region and a staging budget. No operational step should start before that.

## 2. Readiness checklist

Status legend: **Done (local)** = implemented and verified on disposable local databases;
**Code only** = implemented, never run against the real service; **Open** = not done;
**Blocked** = needs a decision or access first. "Verify" is how staging proves it;
"Pass" is the acceptance criterion.

### 2.1 Hosting and PostgreSQL

| Item                                                     | Status      | Evidence                                                                                                      | Verify (staging)                                      | Pass                                                      | Depends on          |
| -------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- | ------------------- |
| Data-residency position                                  | **Blocked** | D.1 § 15.2/15.4: UAE region ≠ compliance; Saudi PDPL transfer rules; NCA ECC in-Kingdom for government bodies | Legal opinion recorded                                | Written decision naming allowed countries and processors  | You + legal counsel |
| Hosting provider and region                              | **Blocked** | D.1 recommends AWS `me-central-1` **conditionally**; not approved                                             | —                                                     | Written approval                                          | Data residency      |
| Managed PostgreSQL 16 with PITR, TLS, private networking | Open        | D.1 § 6 requirements; nothing provisioned                                                                     | Instance settings; `SHOW ssl`; PITR window in console | PG 16, TLS enforced, PITR ≥ agreed days, no public access | Provider approval   |
| Container runtime, one-off jobs, HTTPS origin            | Open        | `Dockerfile` `runner`/`migrate`/`ops` targets; CI builds `runner` only                                        | Staging URL serves `/api/health?scope=readiness` 200  | 200 over HTTPS; migrate job ran as owner                  | Provider approval   |

### 2.2 Credentials and the role model

| Item                                                                                          | Status           | Evidence                                                                                               | Verify (staging)                                                                             | Pass                                                                 | Depends on                   |
| --------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| Separate owner / runtime / grant credentials (+ break-glass master)                           | Done (local)     | `db-roles.sql`; `db-roles.test.ts`, `totp-claim-roles.test.ts`, `mfa-reset-runtime-role.test.ts` (§ 3) | Create roles on the managed DB; run `db-roles.sql`; `DATABASE_ROLES.md` § 3 checklist        | Script prints `db-roles: applied`; every checklist row as expected   | Managed DB; custodians named |
| Membership refusal (direct and indirect, incl. `rds_superuser`-style)                         | Done (local)     | `db-roles.sql` refuses any membership; tested with a stand-in admin role and predefined roles (D.2)    | Grant `rds_superuser` (then `pg_write_all_data`) to the runtime role; run the script; revoke | Script refuses and changes nothing; after revoke it applies          | Managed DB                   |
| SECURITY DEFINER, ownership transfer, `ALTER DEFAULT PRIVILEGES`, column grants on managed PG | **Not verified** | Standard PostgreSQL behaviour, proven locally; AWS docs only partly state it (D.1 § 15.2)              | Run the full role script and its tests' scenarios on the managed instance                    | All succeed under the provider's master user                         | Managed DB                   |
| Release order: migrate → deploy app → `db-roles.sql`                                          | Code only        | `DEPLOYMENT.md` § 5, `DATABASE_ROLES.md`, D.2 § 8                                                      | Rehearse in that order; then try sign-in with TOTP                                           | Sign-in works; with the order reversed, TOTP fails closed (expected) | Staging stack                |
| No credential on command lines or in logs                                                     | Done (local)     | `scripts/ops/lib/pgenv.sh`; D.2: password absent from process arguments while `psql` ran               | Same check inside the `ops` task; grep a day of logs                                         | Zero occurrences                                                     | `ops` image; staging logs    |

### 2.3 Scheduled work

| Item                                         | Status    | Evidence                                                                                                        | Verify (staging)                                      | Pass                                        | Depends on                  |
| -------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- | --------------------------- |
| Overlap safety of the tick and retention     | Code only | Tick: compare-and-set slots + leases (`engine.ts`); retention: run lock; integration tests cover the code paths | Start two ticks at once; kill one mid-run             | No duplicate side effects; leases recovered | Staging stack               |
| Bounded tick run time                        | **Open**  | `scripts/automation/tick.ts` has no overall deadline; ECS has no maximum task runtime (D.1 § 15.2)              | Task wrapped in a timeout; alarm on runs > 4 min      | A hung tick is stopped before the next slot | Engineering approval        |
| Scheduler retry policy and dead-letter queue | Open      | Design only (D.1 § 15.2: 1 retry, max event age 120 s, DLQ with alarm)                                          | Disable the target; observe retry, DLQ message, alarm | Alarm received by on-call                   | Provider, alert destination |

### 2.4 Operations image, backups and restore

| Item                                                  | Status           | Evidence                                                                                                                                                                                                    | Verify                                                                                                             | Pass                                                    | Depends on                           |
| ----------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------ |
| `ops` image with `psql` / `pg_dump` 16                | **Blocked here** | D.2: base, deps and Next.js build stages built locally; the apt step failed — `deb.debian.org` and `apt.postgresql.org` blocked by this environment's network policy (re-checked 2026-10-15: still blocked) | Build `--target ops` in CI or staging; `psql --version`, `pg_dump --version`                                       | Both print 16.x                                         | CI change approval or network access |
| Logical backup, restore, `db-verify.sh`               | Done (local)     | Phase C drills on throwaway databases (`BACKUP_RESTORE.md`)                                                                                                                                                 | Backup from the managed DB with the owner credential; restore to a separate instance                               | `db-verify.sh` → `VERIFIED`; timings recorded           | `ops` image; managed DB              |
| PITR restore                                          | Open             | Provider feature; never exercised                                                                                                                                                                           | Restore to a new instance at a chosen time                                                                         | Restored instance `VERIFIED`; recovery point within RPO | Managed DB                           |
| Decryption after restore (MFA secrets, stored tokens) | **Not verified** | Requirement in D.1 § 15.3; no drill has proven it                                                                                                                                                           | On the restored copy: TOTP sign-in, backup-code sign-in, read one stored integration token, with the escrowed keys | All three succeed; with a wrong key they fail           | Escrowed keys; restored copy         |
| Retired keys kept for the backup retention period     | Open             | Policy only (D.1 § 8)                                                                                                                                                                                       | Escrow record lists every key version with dates                                                                   | Two custodians confirm access                           | Custodians named                     |

### 2.5 Authentication, MFA and recovery

| Item                                                        | Status       | Evidence                                                                         | Verify (staging)                                             | Pass                                       | Depends on      |
| ----------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ | --------------- |
| Sign-up, verification, sign-in, password reset              | Done (local) | Integration + E2E suites (§ 3); email captured by the test transport, never sent | Real inboxes via the staging sending domain                  | Each email arrives; links work once        | Resend decision |
| MFA enrolment, TOTP and backup-code sign-in                 | Done (local) | `admin-mfa.test.ts`, `account-security.test.ts`, E2E                             | Same flows under the runtime role                            | All succeed                                | Role model live |
| TOTP replay refused (incl. under concurrency, both roles)   | Done (local) | `totp-claim-roles.test.ts`, `admin-mfa.test.ts`; 7 mutations caught (D.2)        | Reuse a code within 90 s; runtime and grant roles try DELETE | Replay refused; DELETE refused             | Role model live |
| `admin:mfa-reset` (account recovery) under the runtime role | Done (local) | `mfa-reset-runtime-role.test.ts`                                                 | Reset a test account in staging                              | `RESET`, sessions ended, audit row written | Role model live |
| Clock skew between app and database                         | Open         | Residual risk (D.2 § 5): replay possible only with DB clock > ~90 s ahead        | Compare `now()` with the app host clock                      | Difference < 5 s                           | Staging stack   |

### 2.6 Monitoring, alerts, secrets

| Item                                           | Status           | Evidence                                                                                      | Verify (staging)                                        | Pass                                                             | Depends on                  |
| ---------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| `/api/health` liveness/readiness               | Done (local)     | Route + tests; E2E server starts                                                              | External monitor every 1–5 min                          | 200; readiness 503 when the DB is unreachable                    | Monitor choice              |
| `/api/internal/ops-status` with bearer secret  | Done (local)     | Constant-time compare, 404 on wrong/missing token, counts only (D.1 § 15.2)                   | Monitor with the header over HTTPS; stop the scheduler  | 503 within ~15 min; monitor alert received                       | Monitor + alert destination |
| Alert webhook (`ALERT_WEBHOOK_URL`)            | Code only        | `alert-sink.ts`, throttled; payload `details` per caller not yet reviewed for personal data   | Review payloads; send one staging test alert            | Received by on-call; no personal data or secrets in it           | Alert destination approved  |
| Secrets in a manager, per-task access          | Open             | Plan in D.1 § 8; nothing created                                                              | Each task reads only its secrets; audit log shows reads | No secret in images, files, CI output or logs                    | Provider approval           |
| Key rotation (`AUTH_SECRET`, `ENCRYPTION_KEY`) | Open (by design) | No key versioning; rotation resets MFA / integrations (D.1 § 8, `INCIDENT_RESPONSE.md` § 4.6) | Not tested in staging until key versioning exists       | Incident-only procedure documented and rehearsed on staging data | Engineering item (P9)       |

### 2.7 External integrations — simulated vs real

| Item                        | Status             | Evidence                                                                                                                                  | Verify (staging)                                                                                    | Pass                                                                       | Depends on                                   |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| Meta Ads / WhatsApp / Pages | **Simulated only** | Tests use a fake Graph API; `ADS_WHATSAPP_LIVE_TEST_SETUP.md` § 0: never run against real Meta; redirect URIs and webhooks not registered | Supervised test (§ 7 of that runbook) with test accounts, spend at the minimum, kill switches ready | OAuth, webhook verification, paused-first creation succeed; tamper refused | Your approval; Meta test accounts; HTTPS URL |
| Resend email                | **Simulated only** | `resend-mailer.test.ts` uses a stubbed HTTP client; no sending domain verified                                                            | Verify a staging subdomain (SPF/DKIM/DMARC); send to test inboxes                                   | Delivered; SPF and DKIM pass                                               | Your approval of Resend and the domain       |

## 3. Verified locally in this phase (2026-10-15, HEAD `fdccb3a`)

All on throwaway databases (a temporary test database and a temporary superuser for the
role tests, both dropped afterwards); `flexibx` and `flexibx_test` untouched.

| Check                                                                     | Result                                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `lint`, `typecheck`, `db:validate`, `phase:validate` | exit 0 each                                                                                                                                                 |
| `pnpm test` (unit)                                                        | 980/980                                                                                                                                                     |
| `pnpm test:integration`                                                   | 762/762, none skipped — includes the role-boundary, membership-refusal, TOTP-claim, admin-grant and MFA-reset-under-runtime-role suites                     |
| `pnpm build`                                                              | exit 0                                                                                                                                                      |
| `pnpm e2e` (throwaway database, dropped after)                            | 36/36                                                                                                                                                       |
| `docker build --target ops`                                               | **not attempted again**: `deb.debian.org` and `apt.postgresql.org` still unreachable from this environment (checked 2026-10-15); D.2's partial build stands |

**Not verified anywhere yet:** the `ops` image build and its client versions; any
behaviour of a managed PostgreSQL service; PITR; decryption after a restore; the
scheduler, its retries, DLQ and alarms; external monitoring and alert delivery; secret
manager access; real Meta and Resend; log contents of a running deployment.

## 4. Open risks and dependencies

| #   | Risk / dependency                                        | Impact                                                          | Owner / unblocks                        |
| --- | -------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| R1  | Data residency undecided                                 | Blocks provider and region; region cannot change later          | You + legal counsel                     |
| R2  | `ops` image never built                                  | Role cutover and backups cannot run as jobs                     | CI change, or network access to mirrors |
| R3  | Managed-PostgreSQL behaviour unproven                    | Cutover could fail or behave differently                        | Staging rehearsal (step 5)              |
| R4  | Tick has no time limit                                   | A hung tick overlaps the next ones, holds DB connections        | Engineering item (approval)             |
| R5  | Decryption after restore unproven; key escrow not set up | A restore could be unusable for MFA and integrations            | Custodians; drill (step 4)              |
| R6  | Meta and Resend never exercised for real                 | Unknown API behaviour on first real use                         | Supervised tests (step 9)               |
| R7  | No key versioning                                        | Any rotation resets MFA / reconnects integrations               | Engineering item P9                     |
| R8  | Low residuals from D.2 (pre-claim DoS, clock skew)       | Temporary TOTP lock-out of an account; replay needs skew > 90 s | Accepted; skew checked in staging       |
| R9  | Alert payloads not reviewed for personal data            | Personal data could reach a chat channel                        | Review before connecting a destination  |

## 5. Staging plan

Each step starts only after the previous one is recorded. Approval = what you must
explicitly approve before the step; nothing in this plan is approved yet.

| #   | Step                                                           | Prerequisites                                                         | How it is verified                                                                                                                                                         | Rollback                                                                                                                    | Approval needed                                                 |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Decide data residency, provider, region, staging budget        | Legal opinion on residency (blocker)                                  | Written decisions recorded                                                                                                                                                 | n/a                                                                                                                         | **Yes** — each decision                                         |
| 2   | Create a separate staging environment (accounts, network, IaC) | Step 1; account owner and custodians named; IaC tool chosen           | IaC reviewed and applied; staging reachable over HTTPS; no shared resource with any future production                                                                      | Destroy the staging stack from IaC                                                                                          | **Yes** — account/resource creation and spend                   |
| 3   | PostgreSQL + backups **before** the role model                 | Step 2; `ops` image built (CI) and `psql --version` = 16.x            | Instance is PG 16, TLS enforced, PITR on; migrate job applied all migrations as the owner; first logical backup lands in the separate backup location                      | Drop the staging instance (no real data)                                                                                    | **Yes** — instance size and retention                           |
| 4   | Restore drill + decryption proof                               | Step 3; keys generated in the secret manager and escrowed             | `db-restore.sh` into a separate instance and a PITR restore → `db-verify.sh` `VERIFIED`; TOTP, backup-code sign-in and one token read succeed on the copy                  | Restores go to throwaway instances; delete them                                                                             | **Yes** — key generation and escrow                             |
| 5   | Real role model, including dangerous memberships               | Step 4 passed                                                         | Create roles; `db-roles.sql` applied; grant `rds_superuser`-style and `pg_write_all_data` membership → script refuses, then applies after revoke; `DATABASE_ROLES.md` § 3  | App keeps the owner credential until step 6; revoke test memberships                                                        | **Yes** — role creation on the staging DB                       |
| 6   | Security migration in the documented order                     | Step 5                                                                | migrate (incl. `20261014150000`) → deploy the app → re-run `db-roles.sql`; runtime/grant DELETE on `two_factor_used_codes` refused                                         | Before `db-roles.sql`: redeploy the previous image. After: do not roll the app back past D.2 (TOTP fails closed)            | **Yes**                                                         |
| 7   | Accounts, MFA, TOTP, `admin:mfa-reset`                         | Step 6; staging sending domain (step 9 can be first for email)        | Sign-up/verification, sign-in, reset, enrolment, TOTP + backup code, replay refused within 90 s, `admin:mfa-reset`, `admin:grant` with a valid code only; clock skew < 5 s | Staging data is disposable                                                                                                  | No new approval beyond step 2 (test accounts only)              |
| 8   | Scheduler, overlap, alerts                                     | Step 6; tick time limit implemented (R4); alert destination approved  | Two concurrent ticks harmless; a killed tick recovers; disabled schedule → ops-status 503 → monitor and webhook alerts; DLQ alarm fires                                    | Re-enable the schedule                                                                                                      | **Yes** — monitor/alert services and destination                |
| 9   | Meta and Resend on approved test accounts                      | Step 7; Meta test app, users, ad account/WABA; Resend domain verified | Supervised live test (`ADS_WHATSAPP_LIVE_TEST_SETUP.md` § 7) at minimum spend, paused-first; webhook tamper refused; emails delivered with SPF/DKIM pass                   | Kill switches off (`ADS_EXECUTION_ENABLED`, `WHATSAPP_SENDING_ENABLED`, `SOCIAL_SENDING_ENABLED`); disconnect test accounts | **Yes** — each real external connection, spend limits, messages |
| 10  | Log review for secret leakage                                  | Steps 3–9 produced logs                                               | Grep a full day of application, job and load-balancer logs for every staging secret value (by hash or exact value, offline) and for tokens/URLs with passwords             | Rotate any leaked secret (incident procedure)                                                                               | No (read-only review)                                           |
| 11  | Acceptance before a limited pilot                              | Steps 1–10 recorded                                                   | § 6 criteria all met                                                                                                                                                       | Stay in staging                                                                                                             | **Yes** — pilot go/no-go                                        |

## 6. Acceptance criteria before a limited pilot

1. Data-residency decision and privacy policy wording approved.
2. `ops` image built in CI; client 16.x verified.
3. Restore drill `VERIFIED` from a logical backup and from PITR, with decryption proven;
   timings within the agreed RTO/RPO.
4. Role model live in staging; `DATABASE_ROLES.md` § 3 all rows as expected; dangerous
   memberships refused.
5. All step-7 flows pass under the runtime role; replay refused; clock skew < 5 s.
6. Scheduler drill: duplicate and killed ticks harmless; stopped scheduler detected and
   alerted within 15 minutes; DLQ alarm works; tick time limit in place.
7. Meta and Resend supervised tests passed (or the launch scope excludes them).
8. No secret found in a day of logs; alert payloads reviewed.
9. Keys escrowed with two custodians; retired keys kept for the backup retention.
10. On-call named; incident runbook rehearsed once on staging.

## 7. Decisions that need your approval (none is assumed)

| #   | Decision                                                                                                                                                                              | Blocks        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| A1  | Data residency: which countries may hold customer data; whether transfers outside Saudi Arabia are allowed; which foreign processors (email, error tracking, AI, Meta) are acceptable | Everything    |
| A2  | Hosting provider and region (D.1 recommends AWS `me-central-1` only if A1 allows it)                                                                                                  | Steps 2–11    |
| A3  | Staging budget and billing alarm recipient                                                                                                                                            | Step 2        |
| A4  | Account owner, IaC tool and reviewer, two custodians per credential and for key escrow                                                                                                | Steps 2–4     |
| A5  | Engineering items: build `--target ops` in CI; a time limit for the tick task                                                                                                         | Steps 3 and 8 |
| A6  | Monitor, error-tracking and alert destination; on-call names                                                                                                                          | Step 8        |
| A7  | Real Meta and Resend connections (test accounts, spend limits, sending domain)                                                                                                        | Step 9        |
| A8  | Pilot go/no-go                                                                                                                                                                        | After step 11 |

## 8. Recommended next step (not executed)

Decide A1 (data residency) with legal advice — it is the only decision everything else
waits on. In parallel, and without any infrastructure: approve A5 so that the next
engineering change adds the CI build of `--target ops` (closing the image-build gap in a
network that can reach the package mirrors) and a time limit for the tick. Then decide
A2–A4 and start step 2.

## 9. Not done in this phase

No account, resource, secret, domain, role, scheduler, monitor or alert destination was
created; no deployment, migration or persistent-database connection; no real message,
email, ad or external API call; no code, migration, Dockerfile or configuration change;
the D.1 and D.2 reports were not modified; nothing was staged, committed or pushed.
