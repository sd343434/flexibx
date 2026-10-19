# Release readiness decisions (Pass 16, 2026-10-19)

Decisions only the owner can take before Flexibx staging can be hosted and a release
promoted. None of them can be made from the repository: each needs an account, money, a
contract or a risk choice. For each: the options, their risks, a recommendation, and what
stays blocked until it is decided. Nothing here has been applied: no AWS resource, no
secret, no GitHub setting was created or changed.

**State at the time of writing:** everything below "blocked" is verified only locally (one
machine, Docker, local PostgreSQL 16, SeaweedFS as the S3 stand-in, simulated media
providers). CI has not run a single job since run #43 (no runner; § R-1). No hosted
environment exists.

| #   | Decision                           | Recommendation (short)                                                                  | Blocks                                |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| R-1 | Unblock GitHub Actions             | Fix the account's billing / Actions setting; allow the 8 actions                        | Any "CI passing" claim; image budgets |
| R-2 | AWS account and region             | A new account in an Organization, used for staging only; region per data-residency need | Terraform plan / apply                |
| R-3 | Cost approval                      | Approve the staging budget below with a budget alarm                                    | Terraform apply                       |
| R-4 | Staging secrets channel            | AWS Secrets Manager / SSM written by the owner, never chat or repo                      | First deploy                          |
| R-5 | Prisma 7.10.1 upgrade              | Apply on/after 2026-10-22 as already specified                                          | Clearing 3 of 4 audit findings        |
| R-6 | Static FFmpeg build                | Keep Ubuntu's signed FFmpeg 6.1 for now                                                 | Nothing (optional)                    |
| R-7 | Alert destination and retention    | One paging webhook (on-call) + log retention 30 days staging                            | Gate's `alert_destination` on hosting |
| R-8 | PITR / backup plan                 | RDS PITR 7 days + daily dump copied off-host; test PITR once                            | Any RPO promise                       |
| R-9 | OS package patch policy for images | Refresh base digests on a schedule; consider `apt-get upgrade` at build                 | Clearing OS findings                  |

## R-1. GitHub Actions is blocked

- **Evidence:** runs #43–#57 (latest #57, commit 5654509, 2026-10-19 16:38 UTC): all four
  jobs end within 3 seconds with 0 billable milliseconds, no runner name, no step log.
  Same for a manual `workflow_dispatch` (#56). An account-level block, not a workflow
  error (the same workflow ran green before #43). Details: CI_STATUS.md.
- **Options:** (a) fix the account (billing, Actions enabled, allowed actions); (b) run
  the same jobs on a self-hosted runner the owner controls; (c) move CI elsewhere.
- **Risks:** (a) none beyond cost (public repositories run free); (b) a self-hosted runner
  executing a public repository's pull requests is a known compromise path — only for a
  private repository or with approval-required workflows; (c) a rewrite and a second
  secret store.
- **Recommendation:** (a). Steps in CI_STATUS.md § 2. The allowed-actions list now has
  eight entries: `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`,
  `docker/setup-buildx-action`, `docker/build-push-action`, `actions/upload-artifact`,
  `gitleaks/gitleaks-action`, and (Pass 16) `hashicorp/setup-terraform`.
- **Blocked until decided:** any statement that CI passes; the image size budgets,
  the ops-image self-check and the Terraform tests running on every push.

## R-2. AWS account and region

- **Options:** (a) a new AWS account for Flexibx staging inside an AWS Organization
  (separate from any other product); (b) reuse an existing account; (c) another provider
  (the Compose stack maps onto any Docker host + managed PostgreSQL 16 + S3-compatible
  bucket).
- **Region:** the Terraform example uses `me-central-1` (UAE) as a placeholder. Choose by
  where customers' data may live — this is decision D-1 (Saudi residency) in
  PHASE_D_1_INFRASTRUCTURE_DECISIONS.md, still open (Gulf options: `me-central-1` UAE,
  `me-south-1` Bahrain, or a Saudi region if residency requires it); check that every service used (RDS PostgreSQL 16, ECR, SSM) is offered there.
- **Risks:** (b) mixes blast radius and billing with other products — a mistake in one
  touches the other; (c) loses the tested Terraform.
- **Recommendation:** (a), region chosen by the data-residency answer, root account with
  MFA and no access keys, deploy through an IAM Identity Center role.
- **Blocked:** `terraform plan` against a real account (only `validate` and a mocked
  `terraform test` have run), and therefore everything hosted.

## R-3. Cost approval

Approximate on-demand list prices for one small staging stack (verify in the AWS pricing
calculator for the chosen region before approving; these are estimates, not quotes):

| Item                                   | Size in `terraform.tfvars.example`     | Order of magnitude / month |
| -------------------------------------- | -------------------------------------- | -------------------------- |
| EC2 Docker host                        | t3.large, 80 GB gp3                    | ≈ USD 60–75                |
| RDS PostgreSQL 16, single-AZ           | db.t4g.small, 20 GB gp3, 7-day backups | ≈ USD 25–35 + storage      |
| S3 media + requests                    | a few GB                               | < USD 5                    |
| ECR, CloudWatch logs, SSM, Secrets Mgr | small                                  | ≈ USD 5–10                 |
| Public IPv4 address                    | 1                                      | ≈ USD 4                    |
| **Total**                              |                                        | **≈ USD 100–130**          |

- **Options:** (a) approve as sized; (b) smaller (t3.medium host — FFmpeg exports then
  take about twice as long; worker limited to 2 CPU anyway); (c) stop the host outside
  working hours (≈ 50% of EC2).
- **Recommendation:** (a) with an AWS Budget alarm at USD 150 / month; consider (c) once
  usage is known. Multi-AZ RDS is not needed for staging.
- **Blocked:** `terraform apply`.

## R-4. Staging secrets through a secure channel

- The stack needs: `AUTH_SECRET`, `ENCRYPTION_KEY`, `AUTOMATION_CRON_SECRET`,
  `VIDEO_RETENTION_CRON_SECRET`, `OPS_STATUS_SECRET`, the bucket credentials, the alert
  webhook URL and token, the mail provider key. The RDS master password is created and
  rotated by RDS in Secrets Manager (Terraform never sees it).
- **Options:** (a) the owner writes them into the Secrets Manager container Terraform
  creates (empty), and the host renders `staging.env` from it; (b) an `staging.env` file
  copied by the owner over SSM Session Manager; (c) a password manager shared vault.
- **Never:** chat, e-mail, the repository, CI logs, Terraform variables or state.
- **Recommendation:** (a); generate each value fresh for staging (never reuse a
  production value): `openssl rand -base64 33` (AUTH_SECRET), `openssl rand -base64 32`
  (ENCRYPTION_KEY), `openssl rand -hex 24` (each cron / status secret).
- **Blocked:** the first hosted deploy.

## R-5. Prisma upgrade (dated gate 2026-10-22)

- **Findings (re-run 2026-10-19):** 3 high, 1 moderate. `mysql2` (2 advisories) and
  `deepmerge-ts` come only through the `prisma` CLI and are present only in the **ops**
  image (migrate job); neither is loaded by the app or the worker (checked inside the
  images). `braces` is lint tooling only, in no image, with no upstream fix.
- **Options:** (a) apply Prisma 7.10.1 on/after 2026-10-22 as specified in
  PRODUCTION_READINESS_GAPS.md § 2 (verified in isolation in Pass 7); (b) wait for 7.10.2;
  (c) Prisma 8 — release candidate only, rejected.
- **Recommendation:** (a) on the gate date if no regression report appeared. The gate is
  not bypassed by this pass (today is 2026-10-19).
- **Blocked:** a clean audit of the ops image. Not a runtime exposure: the ops image runs
  only one-off jobs against the private database.

## R-6. Static FFmpeg build

- **Today:** FFmpeg 6.1 from Ubuntu 24.04's archive (signed by Ubuntu, patched through
  Ubuntu security updates, libx264 / aac / libopus / subtitles checked in every build).
- **Options:** (a) keep; (b) a static build (e.g. johnvansickle / BtbN) for a newer
  FFmpeg; (c) build FFmpeg ourselves.
- **Risks:** (b) third-party binaries without a distribution's security process —
  checksums prove only that the download is the file published; (c) maintenance burden.
- **Recommendation:** (a). Revisit only if a needed codec or filter is missing.
- **Blocked:** nothing.

## R-7. Alert destination and log retention

- **Alerts:** the app posts JSON to `ALERT_WEBHOOK_URL` (https only, optional bearer
  token). Options: a Slack / Teams incoming webhook, an incident tool (PagerDuty /
  Opsgenie events endpoint), or both through a relay. Recommendation: an on-call tool for
  `critical`, a chat channel for `warning`, through one relay URL. The gate sends a test
  alert (`--send-test-alert`) and fails if it is refused.
- **Log retention:** container logs rotate on the host (5 × 10 MB per service, Pass 16);
  nothing ships them off the host yet. Options: CloudWatch agent / awslogs driver with a
  retention period, or none on staging. Recommendation: CloudWatch, 30 days on staging
  (logs carry no customer content — scanned each pass — but do carry request ids and
  workspace-less counts).
- **Blocked:** a passing `alert_destination` check on the hosted stack.

## R-8. PITR and backup plan

- **Configured in code (not applied):** RDS automated backups 7 days (PITR), kept when
  the instance is deleted (`delete_automated_backups = false`), retention validated 1–35
  days; daily `db-backup.sh` (Compose `backup` job) for a logical copy.
- **Options:** (a) PITR 7 days + daily dump copied to a second bucket / account; (b) PITR
  only; (c) dumps only (RPO 24 h).
- **Recommendation:** (a), and one real point-in-time restore exercised on staging
  (SERVICE_RESTORE.md § 3a) before any RPO is written into a customer promise.
  Measured locally: 1 GB real schema — backup 40.1 s, restore 27.1 s, verify 2.2 s; RTO /
  RPO on RDS are **estimates** until that exercise.
- **Blocked:** any RTO / RPO commitment.

## R-9. OS package patch policy for images

- **Finding (2026-10-19):** the newest `ubuntu:24.04` digest (the one pinned) lacks two
  security updates already published (`libsystemd0`, `libudev1` 255.4-1ubuntu8.17 →
  8.18, noble-security). The app image (Debian bookworm slim) has none pending.
  No vulnerability scanner (Trivy / Grype) could be downloaded in this environment (GitHub
  release downloads refused by the proxy); the check was `apt-get -s upgrade` inside the
  built images.
- **Options:** (a) keep pinned digests, refresh them on a schedule (e.g. weekly, by a
  reviewed pull request); (b) add `apt-get upgrade` from the security pocket at build
  time (patched sooner, builds no longer byte-reproducible); (c) add Trivy in CI with a
  severity threshold once R-1 is solved.
- **Recommendation:** (a) + (c); (b) only if a finding is exploitable in the container
  (these two libraries are not used by the worker's processes: no systemd / udev in a
  container).
- **Blocked:** nothing at runtime; a "no known OS vulnerability" statement.
