# Launch closure matrix (Pass 40, 2026-10-24)

One row per launch condition. **A condition is closed only by evidence from the
environment its acceptance names.** Local evidence never closes a CI, staging or
production condition.

Statuses: **PROVEN** (evidence exists for the stated environment) · **NOT PROVEN** (work
or evidence missing, nothing blocking it but time) · **BLOCKED** (cannot proceed without an
external action) · **DECISION** (needs an owner decision first).

Environments: L = local sandbox · CI = GitHub Actions · S = hosted staging · P = production.

Evidence paths are in this repository unless they start with `run:` (a command whose output
is the evidence; the Pass 40 outputs are summarised in `LAUNCH_HARDENING_PASS_40.md`).

## 1. Engineering gates

| ID  | Goal                                    | Status                      | Proof (command / test)                                                                                             | Evidence                                  | Env | Owner / decision                   | Close when                                                  |
| --- | --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --- | ---------------------------------- | ----------------------------------------------------------- |
| G1  | Format, lint, types, unit               | PROVEN (L) · BLOCKED (CI)   | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`                                                    | Pass 40 gate table                        | L   | —                                  | Green in CI on the release commit                           |
| G2  | Integration on a real database          | PROVEN (L) · BLOCKED (CI)   | `pnpm test:integration`                                                                                            | same                                      | L   | —                                  | Green in CI                                                 |
| G3  | E2E in a browser                        | PROVEN (L) · BLOCKED (CI)   | `pnpm e2e`                                                                                                         | same                                      | L   | —                                  | Green in CI                                                 |
| G4  | Migrations, checksums, schema drift     | PROVEN (L)                  | gate `migrate-schema-drift`: 38 applied, first 37 checksums = Pass 29, schema dump identical, `migrate diff` empty | same                                      | L   | —                                  | Same on the hosted database (S) at deploy                   |
| G5  | Prisma 7.10.1 upgrade                   | PROVEN (L) · NOT PROVEN (S) | Pass 29 gates; RC `a463d1c`                                                                                        | Pass 29 record (commit `42aa713` message) | L   | —                                  | `migrate` job and gate pass on staging                      |
| G6  | Release images built, verified, scanned | PROVEN (L)                  | `scripts/release/build-and-verify.sh <sha>` (no exception file entries)                                            | Pass 40 gate table                        | L   | Approval (3) ECR push              | Built in CI; digests pushed after approval                  |
| G7  | Secrets not in history                  | PROVEN (L) · BLOCKED (CI)   | gitleaks on the new commits                                                                                        | same                                      | L   | —                                  | CI secret-scan job green                                    |
| G8  | Terraform valid, tested (mocked)        | PROVEN (L)                  | `terraform fmt/validate/test` (offline mirror)                                                                     | same                                      | L   | —                                  | `terraform plan` reviewed (approval 1)                      |
| CI  | CI runs at all                          | **BLOCKED**                 | Actions API: run #80, every job `runner_id` 0, 0 billable ms, 0–4 s; no run since 2026-10-23 09:17 UTC             | `CI_STATUS.md` § Pass 40                  | CI  | Repository owner (account/billing) | A run on the release commit reaches a runner and goes green |

## 2. Hosted staging acceptance (A1–A10) — all NOT PROVEN, nothing is hosted

Blocked by: CI (above), `terraform.tfvars` (R-2), the five separate approvals.

| ID  | Goal                                         | Proof (command / test)                                                                              | Evidence to keep                                             | Env | Close when                                             |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --- | ------------------------------------------------------ |
| A1  | Pre-deploy gate on the host                  | `docker compose … run --rm check`                                                                   | Full gate output, `STAGING CHECK PASSED`, 0 fail / 0 not run | S   | Output attached; local reference 34/0/0 (Pass 39)      |
| A2  | TLS and pages                                | `curl -fsS https://<domain>/api/health?scope=liveness`; open `/ar`, `/en`                           | curl output with certificate issuer; two screenshots         | S   | 200 over TLS, both locales render                      |
| A3  | Running what was approved                    | `docker inspect` labels `org.opencontainers.image.revision`; ECR digests                            | Inspect output vs `docker buildx imagetools inspect` digests | S   | Revision = release SHA; digests = pushed               |
| A4  | Real mail                                    | Sign-up → verification mail → sign-in, with the real provider                                       | Provider log id; app log line (no address)                   | S   | Mail delivered once                                    |
| A5  | Creator Studio end to end                    | One upload to S3, one export (simulated provider); worker heartbeat                                 | Project/export ids; `system_heartbeats` row                  | S   | Export downloadable                                    |
| A6  | Scheduler steady                             | 30 min of tick 200s; ops-status no alert                                                            | Scheduler log excerpt; ops-status JSON                       | S   | 30/30 ticks 200                                        |
| A7  | Alerts reach a person                        | Gate's test alert + the database-outage test                                                        | Receipt at the destination (screenshot)                      | S   | Owner confirms receipt                                 |
| A8  | Off-host backup restores                     | `backup` job → copy off host → restore to NEW database → `db-verify.sh`                             | `VERIFIED` output, object versions in the backup bucket      | S   | VERIFIED, times recorded                               |
| A9  | PITR                                         | RDS restore-to-point-in-time into a new instance (`SERVICE_RESTORE.md` § 3a)                        | Requested time, restored time, duration = measured RTO       | S   | Restore usable; RPO and RTO measured                   |
| A10 | Logs clean                                   | Sample of each container's logs                                                                     | Reviewed sample, no secret/token/customer content            | S   | Reviewed by the owner                                  |
| A11 | Container hardening on the host (Pass 39/40) | `docker inspect` CapDrop/SecurityOpt/PidsLimit/Memory; `/proc/1/status` CapEff, NoNewPrivs, Seccomp | Output                                                       | S   | Same as the local cycle                                |
| A12 | Database outage on the host                  | Stop/start the RDS instance (staging only) during a quiet window                                    | Alert receipt; readiness 503 → 200; no restarts              | S   | Alert ≤ 2 watchdog intervals; recovery without restart |

## 3. Operations

| ID  | Goal                              | Status     | Proof                                                           | Evidence                          | Env | Owner / decision                      | Close when                            |
| --- | --------------------------------- | ---------- | --------------------------------------------------------------- | --------------------------------- | --- | ------------------------------------- | ------------------------------------- |
| O1  | Backup + restore procedure        | PROVEN (L) | `restore-drill.sh` + 13 mutants; backup under writes → VERIFIED | Pass 39/40 gate tables            | L   | —                                     | A8                                    |
| O2  | Off-host backup copy              | NOT PROVEN | Design in `LAUNCH_HARDENING_PASS_39.md` § 3                     | —                                 | —   | R-8: bucket, account, retention, cost | A8                                    |
| O3  | PITR with measured RPO/RTO        | NOT PROVEN | Terraform enforces `db_backup_retention_days` ≥ 1               | `deploy/staging/aws/variables.tf` | —   | R-8: retention days                   | A9                                    |
| O4  | Scheduler/worker/DB-outage alerts | PROVEN (L) | Watchdog unit+integration; local cycle (Pass 39)                | Pass 39 record                    | L   | R-7: destination                      | A7, A12                               |
| O5  | External uptime check             | NOT PROVEN | Design (Pass 39 § 3)                                            | —                                 | —   | R-7: service, on-call person          | Check live, one test page received    |
| O6  | Log shipping and retention        | NOT PROVEN | Rotation 5×10 MB is in Compose; shipping not built              | `compose.yaml` `x-logging`        | L   | R-7: retention                        | Logs in CloudWatch with the retention |

## 4. Security

| ID  | Goal                                       | Status                          | Proof                                                              | Evidence                                | Env | Owner / decision                    | Close when                                  |
| --- | ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------ | --------------------------------------- | --- | ----------------------------------- | ------------------------------------------- |
| S1  | Session tokens hashed; rollback understood | PROVEN (L)                      | `session-token-hash.test.ts` (7 tests incl. rollback/roll-forward) | `SESSION_TOKENS.md`                     | L   | Separate approval for production    | Same on staging; production approval        |
| S2  | FFmpeg CVEs                                | **DECISION**                    | 65 CVEs: 61 fixed only in Ubuntu Pro, 4 deferred                   | `FFMPEG_RISK_DECISION.md`, evidence TSV | L   | Ubuntu Pro (A) and/or isolation (D) | Acceptance in that document                 |
| S3  | Other OS findings                          | NOT PROVEN (accepted per build) | 80 MEDIUM/LOW outside FFmpeg, none fixable                         | Trivy JSON                              | L   | R-9: re-scan cadence                | Weekly re-scan policy agreed                |
| S4  | Containers hardened                        | PROVEN (L)                      | `check-compose-credentials.sh` (CI step) + local cycle             | Pass 39/40                              | L   | —                                   | A11                                         |
| S5  | Client IP behind the proxy                 | PROVEN (L)                      | Caddy 2.6.2 test (Pass 38)                                         | Pass 38 record                          | L   | —                                   | Checked on the host                         |
| S6  | AWS CLI signing key                        | **BLOCKED**                     | `docs.aws.amazon.com` unreachable from this sandbox (2026-10-24)   | —                                       | —   | Operator with internet access       | Fingerprint compared with the official page |

## 5. Commercial

| ID  | Goal                                     | Status       | Proof                                                                         | Evidence                               | Owner / decision                    | Close when                                       |
| --- | ---------------------------------------- | ------------ | ----------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| C1  | Customers can pay                        | **DECISION** | No provider (`getPaymentProvider()` → null)                                   | `PAYMENTS_DESIGN.md`                   | Provider, merchant account, markets | § 9 of that document met in sandbox              |
| C2  | Clients cannot change balance or payment | PROVEN (L)   | `admin-mfa.test.ts` "a customer cannot add credits…"; `credits.test.ts` roles | Tests                                  | —                                   | Re-run in CI                                     |
| C3  | Terms, privacy, DPA, cookies, refunds    | **DECISION** | Not in the product                                                            | `docs/legal/LAUNCH_LEGAL_CHECKLIST.md` | Lawyer in each target market        | Approved texts published and accepted at sign-up |
| C4  | Account deletion, data export            | NOT PROVEN   | Deletion absent (`/delete-user` 404); export per Creator Studio project only  | Checklist § 5                          | Lawyer (scope, deadlines)           | Features built per the approved scope            |
| C5  | VAT and e-invoicing                      | **DECISION** | —                                                                             | `COMMERCIAL_DECISION_PACK.md`          | Tax adviser                         | Invoice flow approved and tested in sandbox      |
