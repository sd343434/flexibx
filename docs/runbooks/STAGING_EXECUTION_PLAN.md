# Hosted staging — ordered execution plan (Pass 40, 2026-10-24)

The commands live in `STAGING_LAUNCH.md` (§ references below); this is the order, the
stop points and what each step must leave behind. Steps 1–3 are non-destructive. **Every
step from 4 on needs its own explicit owner approval; none was given or performed.**

| #   | Step                                                                                                                                                                                                                                                       | Touches AWS?           | Approval                                      | Done in Pass 40?                                                                                                                                                                                    | Evidence to keep / result                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 0   | CI green on the release commit                                                                                                                                                                                                                             | No                     | Repo owner (unblock)                          | **BLOCKED**                                                                                                                                                                                         | Run URL with 4 green jobs (`CI_STATUS.md` § Pass 40)   |
| 1   | Environment and Terraform files: `staging-preflight.sh <tfvars> <sha>` (§ 1)                                                                                                                                                                               | No                     | —                                             | Run: **2 FAIL** — no `terraform.tfvars`; the Pass 40 commits are not pushed. With `a463d1c` only the tfvars check fails. Lock file pins hashicorp/aws 6.69.1 with checksums; fmt/init/validate pass | Preflight output                                       |
| 2   | Image sources and versions: release images built and verified from the release SHA (`build-and-verify.sh`); base images pinned by digest                                                                                                                   | No                     | —                                             | Yes (local, `3d19ed3` and Pass 40 HEAD)                                                                                                                                                             | Gate table, image IDs                                  |
| 3   | Roles, permissions, secrets — names only, never values: IAM roles in `iam.tf` (tests in `deploy/staging/aws/tests`); secrets listed in `staging.env.example` / `staging-owner.env.example`; owner-login routing asserted by `check-compose-credentials.sh` | No                     | —                                             | Yes (mocked Terraform tests; Compose check)                                                                                                                                                         | Test output                                            |
| 4   | `terraform plan` (§ 2), reviewed by the owner                                                                                                                                                                                                              | Read-only              | **(1) use the account**                       | No                                                                                                                                                                                                  | Saved plan + reviewer sign-off                         |
| 5   | `terraform apply` of that plan (§ 3)                                                                                                                                                                                                                       | Creates paid resources | **(2) apply**                                 | No                                                                                                                                                                                                  | Apply log; outputs (no secrets)                        |
| 6   | Push the verified images to ECR (§ 4)                                                                                                                                                                                                                      | Yes                    | **(3) ECR push**                              | No                                                                                                                                                                                                  | Pushed digests = local verified IDs                    |
| 7   | Deploy on the host (§ 5: env from secret, logins, mark, migrate, roles, up, gate)                                                                                                                                                                          | Yes                    | **(4) staging deploy**                        | No                                                                                                                                                                                                  | A1 gate output                                         |
| 8   | Acceptance A1–A12 (`LAUNCH_CLOSURE_MATRIX.md` § 2)                                                                                                                                                                                                         | Yes                    | Within (4)                                    | No                                                                                                                                                                                                  | One artefact per row                                   |
| 9   | Readiness/liveness and database outage on the host (A12): stop the RDS instance in a quiet window, observe readiness 503 / liveness 200, the watchdog alert, then start it and observe recovery without restarts                                           | Yes                    | Within (4), owner present                     | No                                                                                                                                                                                                  | Times, alert receipt                                   |
| 10  | External uptime check, alert destination, log shipping and retention (O5, O6)                                                                                                                                                                              | Yes                    | R-7 decision                                  | No                                                                                                                                                                                                  | Check URL, test page received, log group retention     |
| 11  | Off-host backup and restore (A8), PITR (A9) — **measure RPO and RTO**                                                                                                                                                                                      | Yes                    | Within (4); R-8 for the backup bucket         | No                                                                                                                                                                                                  | `VERIFIED`; PITR requested vs restored time; durations |
| 12  | Production                                                                                                                                                                                                                                                 | Yes                    | **(5) production** + session-hashing approval | No                                                                                                                                                                                                  | Separate plan                                          |

## Rollback (from `STAGING_LAUNCH.md` § 8 and `SESSION_TOKENS.md`)

- Application: redeploy the previous image tag with `up -d` (local reference ≈ 6 s to
  healthy). With Pass 39+ images, rolling back to `a463d1c` signs every user out once;
  rolling forward again needs the session hashing statement re-run (`SESSION_TOKENS.md` § 3).
- Database: never `migrate` backwards; restore into a **new** database (`SERVICE_RESTORE.md`).
- Infrastructure on first launch: `terraform destroy` only with a further explicit approval.

## Stop conditions

Any FAIL or NOT_RUN in the gate; a digest that differs from the verified image; a migration
error; an alert that does not arrive; a restore that does not verify. Stop, record, change
nothing further, report.

## Inputs still missing (none invented here)

`terraform.tfvars` (region, `app_domain`, sizes, `db_backup_retention_days`) — R-2;
alert destination and on-call person — R-7; backup bucket account/region/retention — R-8;
re-scan cadence and the FFmpeg option — R-9; AWS CLI signing key verified from the official
page (S6); CI unblocked — R-1.

## Pass 41 — execution package (nothing below was run against AWS)

### 1. `deploy/staging/aws/terraform.tfvars` (owner fills in; git-ignored)

| Variable                   | Default             | Who decides                     | Note                                                                  |
| -------------------------- | ------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `region`                   | **none (required)** | Owner, data residency (D-1/R-2) | The example's value is an example, not a recommendation               |
| `app_domain`               | **none (required)** | Owner                           | Must resolve publicly (preflight refuses `.test`, `.example`, …)      |
| `name`                     | `flexibx-staging`   | —                               | Resource prefix                                                       |
| `host_instance_type`       | `t3.large`          | Owner (cost)                    | 2 vCPU / 8 GiB: app + worker (2 GiB cap) + scheduler                  |
| `host_disk_gb`             | `80`                | Owner (cost)                    | ≥ 3 × largest upload for the worker's `/work`; gate checks free space |
| `db_instance_class`        | `db.t4g.small`      | Owner (cost)                    |                                                                       |
| `db_storage_gb`            | `20`                | Owner (cost)                    |                                                                       |
| `db_backup_retention_days` | `7`                 | Owner (R-8)                     | PITR window; 0 refused by Terraform                                   |

### 2. IAM and secrets — names, never values

Before `plan`: read `iam.tf` and its tests (`deploy/staging/aws/tests`); confirm the instance
role can read only the env secret (and the owner secret only if host backups are chosen,
R-8). After `apply`: `aws secretsmanager describe-secret` (metadata only) for each secret;
`render-staging-env.sh` refuses missing, empty or placeholder values and prints no value.

### 3–4. Plan review, images, tags, digests

`terraform plan -out staging.plan` (approval 1) → reviewer checks: resource count, no public
database, deletion protection on, backup retention = tfvars, security groups, IAM policies.
Images: `build-and-verify.sh <release-sha>` on the approved commit → push (approval 3) →
compare each pushed digest (`docker buildx imagetools inspect`) with the verified local
image; the host runs `FLEXIBX_TAG=<release-sha>` and A3 checks the revision label.

### 5. Deploy and rollback (from `STAGING_LAUNCH.md` § 5 and § 8)

env → logins → mark → `migrate` (ends with the session rehash) → `db-roles.sql` →
`up -d app worker scheduler` → **`run --rm rehash-sessions`** → `run --rm check`. Rollback:
previous tag `up -d`; to a pre-Pass-39 tag everyone signs in again once; roll-forward again =
`migrate` + `rehash-sessions` (`SESSION_TOKENS.md`). Database: restore into a new database,
never migrate backwards.

### 6. Acceptance A1–A13

A1–A12 as in `LAUNCH_CLOSURE_MATRIX.md` § 2, plus **A13 — sessions survive the deploy**: one
test account signed in on the previous release before the deploy is still signed in after it,
and `rehash-sessions` reports `"rehashed"` ≥ 0 with no error. Evidence: the job's JSON line and
a screenshot of the account page after the switch.

### 7–9. Restore, off-host backup, PITR — with measured RPO/RTO

- Restore into an isolated new database: `backup` job → `db-restore.sh` into `*_restore` →
  `db-verify.sh` → `VERIFIED`. Record wall-clock times.
- Off-host: copy the set to the backup bucket (R-8: account, region, versioning, retention);
  then restore **from the bucket copy**, not the host copy.
- PITR: note the time T of a known write; restore RDS to T into a new instance
  (`SERVICE_RESTORE.md` § 3a); RPO = T − last write present; RTO = request → restored
  instance accepts the app's readiness check. Both measured, not estimated.

### 10. External monitoring with proof of delivery

An uptime check on `/api/health?scope=liveness` and `?scope=readiness` (R-7 service); proof =
a test failure that reaches the on-call person, with a timestamp, and the recovery notice.

### 11. Database outage and recovery on the host

Quiet window, owner present: stop the RDS instance; expect readiness 503 / liveness 200, the
watchdog's "cannot read the operational status" alert within two intervals, no container
restart; start it; expect readiness 200 and fresh heartbeats.

### 12. Local versus staging

Proven locally (Pass 41, commit and images in `LAUNCH_HARDENING_PASS_41.md`): gate 34/0/0,
migrate + rehash jobs, backup under writes → VERIFIED, restore over the source refused,
watchdog and alert retry, database outage and recovery, container hardening. **Not proven
anywhere yet:** TLS, real mail, ECR digests, RDS PITR, off-host copy, external monitoring,
real log retention, A1–A13.
