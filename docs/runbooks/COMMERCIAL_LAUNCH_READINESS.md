# Commercial launch readiness (Pass 37, 2026-10-23)

**Verdict: Flexibx is NOT ready for a commercial launch.** Nothing has run in a hosted
environment, CI has had no runner since run #43, customers cannot pay, and there are no
published terms or privacy pages. This document lists, per area, what exists, what is
proven and how (local test, hosted, production), and what blocks the launch.

Evidence levels used throughout:

- **Present** — the code or document exists; no test exercises it.
- **Local** — a local test, drill or local container cycle exercises it (one machine,
  Docker, local PostgreSQL 16, SeaweedFS as the S3 stand-in, simulated providers).
- **CI** — a GitHub Actions run on the release commit passed it. **No item has this
  level**: runs #43–#80 got no runner (`runner_id` 0, 0 billable ms; R-1).
- **Hosted** — proven on hosted staging. **No item has this level**: nothing is hosted.
- **Unproven** — missing, or nothing shows that it works.

## 1. Baseline (verified 2026-10-23)

| Item                         | State                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Remote branch                | `claude/amazing-sagan-pvouqy` = `42aa713` (docs) on top of the release candidate `a463d1c`                                             |
| Current release candidate    | `a463d1c` (Prisma 7.10.1, no scanner exception). Its worker and ops images carry pnpm's `ip-address` 10.7.3 (CVE-2026-111997, MEDIUM)  |
| Proposed (Pass 36, unpushed) | `d6141e6` + `f48dee3`: no package manager in the worker and ops images; no Node finding                                                |
| Proposed (Pass 37, unpushed) | `fbd49ce` + `eebb3a0` + this document, on `d6141e6`: owner login for the one-off jobs, snapshot-consistent backups, launch order (§ 4) |
| CI                           | Run #80 (`42aa713`): four jobs, `runner_id` 0, 0 ms — account-level block, not the code (CI_STATUS.md)                                 |
| Hosted staging, production   | None exists                                                                                                                            |

## 2. Security gates (local)

Trivy 0.76.0 (pinned by digest), database updated 2026-10-23 07:12 UTC (the newest
published; next update 2026-10-24 07:12 UTC), **no exception** (`.trivyignore.yaml` has 0
entries). Rescanned in Pass 37.

| Images                 | HIGH / CRITICAL | OS MEDIUM / LOW                   | Node packages                              |
| ---------------------- | --------------- | --------------------------------- | ------------------------------------------ |
| `a463d1c` (current RC) | 0               | app 21/4, worker 637/28, ops 23/4 | worker 1 MEDIUM, ops 1 MEDIUM (ip-address) |
| `d6141e6` (Pass 36)    | 0               | app 21/4, worker 637/28, ops 23/4 | none                                       |
| `fbd49ce` (Pass 37)    | 0               | app 21/4, worker 637/28, ops 23/4 | none                                       |

No OS finding has a published fix (all `affected`). That does not close them:

| Finding group                                                         | Exposure                                                                                                    | Mitigation in place                                                                                                            | Decision needed                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| FFmpeg 6.1 (65 CVEs × ~9 library packages = most of the worker's 665) | **High**: the worker decodes media that customers upload                                                    | file sniffing and size limits, no shell, PATH-only env, timeouts and SIGKILL, non-root, no inbound port, one job per container | R-6: accept with a re-scan cadence, or a maintained static FFmpeg |
| glibc, pcre2, gnutls, tar, dash, systemd libs                         | Low–medium: present in all images, not handed untrusted input directly except through the app's own parsing | non-root users, minimal packages, security updates at every build                                                              | R-9: confirm the patch-at-build policy and a re-scan cadence      |
| `ip-address` (pnpm bundle)                                            | Low (pnpm runs offline, parses no untrusted input)                                                          | removed entirely in `d6141e6`                                                                                                  | Approve the Pass 36 candidate                                     |

Other security evidence (local): gitleaks over the new commits found no leak; image
contents checks (non-root, no credentials, no package manager in any image, no repository or
Terraform state) pass on `d6141e6` and `fbd49ce`, and fail on `a463d1c` (positive control).

**Prisma 7.10.1 reports.** npm (read 2026-10-23 14:46 UTC): no 7.10.2; `latest` is
8.0.0-rc.27, `prev` is 7.10.1. Release notes: nested `$transaction` fix, a shadow-database
safety check, MariaDB adapter and dependency advisories. Known 7.10.1 reports found:
prisma/orm#30818 (MariaDB adapter only) and #30713 (Accelerate retries, filed on 7.10.0);
neither applies (this project uses `@prisma/adapter-pg`, no Accelerate). GitHub's issue
search API is not reachable from this environment, so this is a web search, not a complete
list.

## 3. Readiness by area

| Area                                    | Evidence | What exists                                                                                                     | Gaps / risks                                                                                                                                                              |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up, sign-in, sessions              | Local    | Better Auth; 7-day sessions, daily roll, DB-checked every request; integration and e2e tests                    | Session tokens stored unhashed; no "sign out other devices" for users; unverified accounts can sign in (decision C1)                                                      |
| Email verification, password reset      | Local    | Tests incl. e2e; reset ends every session                                                                       | Mail has no retry and no idempotency key (a timeout can duplicate or lose a verification mail); real mail provider untested (A4)                                          |
| Admin MFA, account recovery             | Local    | TOTP + backup codes, replay claim, operator MFA reset                                                           | No self-service recovery; rotating `AUTH_SECRET` invalidates every enrolled factor (no runbook test)                                                                      |
| Auth rate limiting                      | Local    | DB-backed limits shared across instances; 2FA lockout                                                           | **Blocker (B5)**: `AUTH_IP_HEADER` / `AUTH_TRUSTED_PROXIES` are not in `staging.env.example`: behind the TLS proxy every client shares one bucket (platform-wide lockout) |
| Tenant isolation, permissions           | Local    | Permission matrix, Prisma tenant guard, cross-workspace 404, 134 triggers; tests                                | No row-level security; raw SQL (≈28 files) is scoped by hand                                                                                                              |
| Database role separation                | Local    | `db-roles.sql` + tests; **Pass 37: first local staging cycle with the roles in force (gate 34/0/0)**            | Never applied to a hosted database                                                                                                                                        |
| Secrets, input validation, headers      | Local    | Env validation at startup, log redaction, AES-GCM token vault, Zod, CSP/HSTS, origin checks, webhook signatures | Redaction misses message strings; no key rotation; no rate limit on webhooks or uploads; Meta page webhook bad-signature path untested                                    |
| Payments and billing                    | Unproven | Internal credits ledger (holds, caps, admin top-up) — tested locally                                            | **Blocker (B1)**: no payment provider, checkout, invoices or VAT handling; customers cannot pay                                                                           |
| Errors, retries, idempotency            | Local    | Error mapping; idempotency keys for WhatsApp, Meta writes, credits; uncertain outcomes never resent             | Database serialization/timeout errors become 500 without retry; overlapping ticks possible after a lock timeout (alerted)                                                 |
| Jobs, scheduling                        | Local    | Scheduler, retention, worker leases and heartbeat, deletion queue                                               | Nothing alerts when the scheduler stops (ops-status is pull-only; no uptime monitor)                                                                                      |
| Storage and media                       | Local    | S3/Wasabi routing, multipart resume, signed URLs, safe FFmpeg runner; acceptance on SeaweedFS                   | No orphan sweep outside Creator Studio; **bucket has no versioning** — customer media is not backed up                                                                    |
| Migrations, rollback                    | Local    | Forward-only, checksummed; drift-checked; rollback = previous image tag                                         | Rollback past the TOTP change fails closed; data rollback means a restore (data loss up to the RPO)                                                                       |
| Backups, restore                        | Local    | Backup/restore/verify scripts, drill + 13 mutants; **Pass 37: snapshot-consistent backups of a live database**  | No backup schedule or off-host copy (manual job, local volume); PITR never exercised (A9, R-8)                                                                            |
| Logs, alerts, monitoring                | Local    | Structured logs, alert webhook, ops-status, heartbeats, log rotation                                            | No alert destination (R-7), no uptime monitor, no browser error tracking, no log shipping (logs lost with the host)                                                       |
| Deployment, operations                  | Local    | Compose + Terraform (staging, mocked tests), preflight, runbooks, incident response                             | Staging only: one host, single-AZ RDS; **no production environment is defined**; no on-call names                                                                         |
| Legal, privacy (needs qualified review) | Unproven | Privacy policy **draft** (unpublished, blanks); WhatsApp consent records; Meta data-deletion callback           | **Blocker (B2)**: no terms, no published privacy page, no consent at sign-up, no account deletion, no full data export, no DPA/subprocessor list; PDPL/residency open     |

## 4. Defects found and fixed in Pass 37 (local commits, not pushed)

All reproduced first on a disposable database with the real `db-roles.sql` applied. Local
staging had always run as a superuser, so none of them had shown.

| #   | Defect                                                                                                                  | Reproduction                                                                              | Fix (commit)                                                                                                    | Proof                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Compose `migrate`, `backup` and the gate's `db-verify` used `DATABASE_URL`, which staging sets to the **runtime** login | Runtime login: migrate exit 1, backup `FAILED`, db-verify `FAILED`; owner login: all pass | `fbd49ce`: `staging-owner.env` (`OWNER_DATABASE_URL`) only for migrate/backup/check; gate uses it for db-verify | Unit tests; `check-compose-credentials.sh` (CI; negative control fails); role-separated staging cycle: owner login absent from app/worker/scheduler, gate 34/0/0 |
| F2  | `db-backup.sh` counted rows after `pg_dump`, outside its snapshot: a backup of a database in use never verified         | Live writes during backup → `row_counts MISMATCH` (rate_limits 54800 vs 53400), `FAILED`  | `fbd49ce`: one exported snapshot for the dump and the counts                                                    | Same live writes → `VERIFIED`; unit test (removing `--snapshot` fails it); drill passed, 13/13 mutants; staging backup under writes `VERIFIED` (77/502/37)       |
| F3  | Runbook: copy "three" backup files; verification needs four                                                             | `db-verify.sh` refuses a manifest without its checksum                                    | `fbd49ce` (BACKUP_RESTORE.md)                                                                                   | —                                                                                                                                                                |
| F4  | STAGING_LAUNCH.md applied `db-roles.sql` before the first migration                                                     | On the empty database: exit 3 (needs `users`)                                             | `eebb3a0`: mark → migrate → roles → services                                                                    | Role-separated staging cycle in that order                                                                                                                       |
| F5  | Terraform README said no lock file was committed                                                                        | The file exists and the preflight checks it                                               | `eebb3a0`                                                                                                       | —                                                                                                                                                                |

## 5. Launch requirements

Status: **Done** (proven where it must run) · **Local only** · **Blocked** (waits on access
or an approval) · **Decision** (waits on the owner).

| #   | Requirement                                                   | Status     | What it waits on                                                                                               |
| --- | ------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| L1  | Release images built, scanned, verified                       | Local only | CI (R-1); ECR push (approval 3)                                                                                |
| L2  | Full test suite on the release commit                         | Local only | CI (R-1)                                                                                                       |
| L3  | No package manager / `ip-address` in job images               | Local only | Approval of the Pass 36 candidate                                                                              |
| L4  | Staging jobs on correct logins; consistent backups            | Local only | Approval of the Pass 37 commits                                                                                |
| L5  | AWS account, region, budget                                   | Decision   | R-2, R-3                                                                                                       |
| L6  | Secrets channel (app env secret **and** the owner login)      | Decision   | R-4                                                                                                            |
| L7  | Client-IP header and trusted proxy for auth rate limits (B5)  | Decision   | Hosting topology (R-2); value then set in the env secret                                                       |
| L8  | Terraform plan / apply                                        | Blocked    | Approvals 1 and 2                                                                                              |
| L9  | Hosted staging acceptance A1–A10 (STAGING_LAUNCH.md § 6)      | Blocked    | L5–L8, ECR push                                                                                                |
| L10 | Alert destination, uptime monitor, log retention/shipping     | Decision   | R-7                                                                                                            |
| L11 | PITR exercised, off-host backup schedule, media backup        | Decision   | R-8 (+ bucket versioning choice)                                                                               |
| L12 | OS patch policy and FFmpeg risk acceptance                    | Decision   | R-9, R-6                                                                                                       |
| L13 | Payment provider, invoicing, VAT                              | Decision   | Owner: provider choice, tax registration; then implementation                                                  |
| L14 | Terms, privacy policy, consent, deletion, export, DPA         | Decision   | Qualified legal review (target markets, PDPL, residency); then implementation                                  |
| L15 | Production environment (separate account, multi-AZ, scaling)  | Decision   | Not designed yet; after staging is proven                                                                      |
| L16 | Real providers (OpenAI, Meta ads, WhatsApp, publishing, mail) | Blocked    | Each needs its own approval; all are off by default; real campaigns/messages need a separate explicit approval |

## 6. Approval sequence (each a separate, explicit approval)

1. **Terraform plan** (read-only against the owner's AWS account): needs R-2, the private
   state backend, `terraform.tfvars`. Output reviewed against `deploy/staging/aws/README.md`.
2. **Terraform apply** of exactly that plan (creates paid resources; R-3 budget alarm set).
3. **ECR push** of the verified images of the approved commit (`build-and-verify.sh --push`).
4. **Staging deploy** (STAGING_LAUNCH.md § 5, in the corrected order) and acceptance A1–A10,
   each recorded with evidence.
5. **Production** — design, then deploy — and **real campaigns or messages**: separate
   approvals, after staging is accepted.

Nothing above has been done. No AWS call, no plan, no apply, no push was made.

## 7. Preflight inputs (none may be invented; all are owner-provided)

| Input                                                 | Decision | Goes to                                                              |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| AWS account (staging only), region                    | R-2      | `terraform.tfvars` `region`; deploy role                             |
| Staging domain and who edits its DNS                  | R-2      | `terraform.tfvars` `app_domain`; A record to `public_ip`             |
| Private, versioned Terraform state bucket             | R-2      | backend configuration (outside the repository)                       |
| Budget and alarm                                      | R-3      | AWS Budgets                                                          |
| App env secret values (`staging.env.example` keys)    | R-4      | the Secrets Manager secret; `render-staging-env.sh`                  |
| Owner login credential (`staging-owner.env`)          | R-4      | its own secret; written on the host, mode 600 (Pass 37)              |
| `AUTH_IP_HEADER`, `AUTH_TRUSTED_PROXIES`              | R-2      | app env secret, once the proxy's address as seen by the app is known |
| Alert webhook (+ token), log retention                | R-7      | app env secret; CloudWatch/retention                                 |
| Mail provider for the staging domain                  | R-4      | app env secret (`RESEND_API_KEY`)                                    |
| PITR window, off-host backup destination              | R-8      | `db_backup_retention_days`; backup copy target                       |
| Host AWS CLI: snap or pinned 2.38.2 (current AWS key) | R-9      | `user-data.sh.tftpl`                                                 |
| CI running again (or written acceptance without CI)   | R-1      | GitHub account billing/Actions settings                              |

Current preflight result (`staging-preflight.sh`, 2026-10-23): `terraform.tfvars` missing
(owner input); release commit exists and is pushed; lock file pins hashicorp/aws 6.69.1;
`terraform init` cannot reach the registry from this environment.

## 8. CI (R-1) — options, without bypassing the block

The block is on the account (every job: `runner_id` 0, 0 billable ms), not the workflow.

1. Owner fixes GitHub billing / spending limit or the Actions setting, then re-runs CI on the
   release commit (Actions → CI → Run workflow).
2. Owner registers a self-hosted runner **they** control and approve (not done here).
3. Owner accepts in writing to launch staging without CI, with the local evidence recorded.

After CI runs again, these must pass on the release commit: quality (prisma validate,
phase status, format, typecheck, lint, unit, release-guard, preflight, render-env,
AWS CLI pin/signature tests, Terraform fmt/validate/test), integration (migrate +
status, integration suite, restore drill, 13 mutants, S3 acceptance, build, e2e), docker
(three image builds, Compose validation including `check-compose-credentials.sh`,
`verify-images.sh` with Trivy), and the gitleaks secret scan.

## 9. Estimate (conditional ranges; no launch date is implied)

| Milestone                        | Range after its preconditions are met                | Preconditions / what moves it                                                                                  |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Hosted staging accepted (A1–A10) | about 1–2 weeks of work                              | R-1..R-4, R-7, R-8 decided, approvals 1–3 given; slips with AWS quota/DNS/mail-domain verification, RDS issues |
| Payments (one provider, VAT)     | about 3–6 weeks                                      | provider chosen, merchant account approved, tax registration; provider review times dominate                   |
| Legal/privacy features + texts   | about 2–4 weeks of engineering after the texts exist | qualified legal review (duration outside engineering control), market and residency decisions                  |
| Production environment           | about 2–4 weeks after staging is accepted            | architecture choice (multi-AZ, scaling), separate account, on-call, monitoring stack                           |

These ranges assume one engineer and prompt owner decisions; they are not commitments.

## 10. Local evidence of Pass 37

See the final report of Pass 37 and `PRODUCTION_READINESS_GAPS.md` § 32 for commit, image
IDs, scan and database timestamps, test counts and exit statuses.
