# First hosted staging launch on AWS (Pass 20)

One ordered procedure from "owner inputs given" to "hosted staging accepted". **None of it
has been executed**: no AWS account, cost approval or secrets channel exists yet
(RELEASE_READINESS_DECISIONS.md R-2, R-3, R-4). Every step marked **APPROVAL** needs a
separate, explicit approval from the owner before it runs; an approval of one step is
never an approval of the next.

Related: `deploy/staging/aws/README.md` (the infrastructure), RELEASE_PIPELINE.md (images),
STAGING_CREATOR_STUDIO.md § 3 (the stack), SERVICE_RESTORE.md (incidents),
DEPLOYMENT.md (migrations and rollback).

## 0. Inputs the owner provides (still missing on 2026-10-20)

| Input                                           | Decision | Where it goes                                                                                              |
| ----------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| AWS account (staging only) and region           | R-2, D-1 | `terraform.tfvars` `region`; the deploy role                                                               |
| Staging domain and who edits its DNS            | R-2      | `terraform.tfvars` `app_domain`; an A record to `public_ip`                                                |
| Private Terraform state bucket (versioned)      | R-2      | backend configuration (not in the repository)                                                              |
| Cost approval (≈ USD 100–130 / month) + budget  | R-3      | AWS Budgets alarm, e.g. USD 150                                                                            |
| Secrets channel: owner writes the env secret    | R-4      | the Secrets Manager secret Terraform creates (empty)                                                       |
| Alert destination and log retention             | R-7      | `ALERT_WEBHOOK_URL` (+ token) in the env secret; retention                                                 |
| PITR + off-host dump plan, one restore exercise | R-8      | RDS retention (Terraform), backup job schedule                                                             |
| Image/OS update policy confirmed                | R-9      | as implemented (security updates at build + Trivy gate)                                                    |
| Host AWS CLI: snap (unpinned) or pinned 2.38.2  | R-9      | `user-data.sh.tftpl`; pin only after `verify-aws-cli-signature.sh` passes with AWS's current key (Pass 24) |
| GitHub Actions running again                    | R-1      | CI verifies the release commit before anything is published                                                |
| Mail provider for the staging domain            | R-4      | env secret                                                                                                 |

## 1. Preflight (no credentials, no AWS call)

```bash
scripts/release/staging-preflight.sh deploy/staging/aws/terraform.tfvars <release-sha>
```

Checks the variables file (present, git-ignored, real region and domain — a reserved
name such as `.test` or `.invalid` is refused, Pass 23), the release
commit (full SHA, pushed), the Terraform lock file (hashicorp/aws pinned with checksums)
and `terraform fmt` / `init -backend=false` / `validate`. Must print `PREFLIGHT PASSED`.
Tested by `scripts/release/test-staging-preflight.sh` (CI quality job). Also required
before going on: CI green on `<release-sha>` (R-1), or the owner's written acceptance of
running without CI.

## 2. Plan (read-only against AWS) — **APPROVAL 1: use the account**

```bash
cd deploy/staging/aws
terraform init                       # with the owner's private backend
terraform plan -out staging.plan     # creates nothing
terraform show -no-color staging.plan > staging.plan.txt
```

Review against `deploy/staging/aws/README.md` "What it creates" (25 `resource` blocks in
the code; ECR is one block with three instances; the security-group rules and IAM policies
are counted with their owners): one EC2 host with an Elastic IP and its instance profile
and role, two security groups (host: HTTP/HTTPS in; database: PostgreSQL from the host
only), one RDS PostgreSQL 16 instance and its subnet group, one S3 bucket with its policy,
encryption, public-access block, ownership, CORS and lifecycle, three ECR repositories,
one Secrets Manager secret, one IAM storage user. **No VPC is created** (the account's
default VPC is used). Nothing may be destroyed or replaced. The plan file is kept with the
approval record.

## 3. Apply — **APPROVAL 2: create paid resources**

```bash
terraform apply staging.plan         # exactly the reviewed plan
```

Then: AWS Budgets alarm (R-3), DNS A record to the output `public_ip`, the owner writes
the env secret (R-4; values generated fresh for staging, RELEASE_READINESS_DECISIONS.md
R-4), an access key for the output `storage_user` (into the env secret only).

## 4. Publish the images — **APPROVAL 3: push to ECR**

Release candidate (Pass 29, 2026-10-23): `a463d1ce7b31ae1219fd9f06ec18a61cb806d41a`
(Prisma 7.10.1, no vulnerability exception); its local evidence and image IDs are in
RELEASE_READINESS_DECISIONS.md "Status on 2026-10-23 (Pass 29)". Built and verified locally
only; nothing pushed.

From a clean checkout of `<release-sha>`:

```bash
FLEXIBX_REGISTRY=<account>.dkr.ecr.<region>.amazonaws.com/flexibx-staging \
  scripts/release/build-and-verify.sh <release-sha> --push
```

Nothing is pushed unless every check passed (labels, contents, sizes, ops self-check,
media tools, Trivy); an existing tag or a dirty tree is refused. Record the printed
digests. ECR scans again on push.

## 5. Deploy (on the host, through SSM Session Manager)

`deploy/staging/aws/README.md` "Launch", in this order — stop at the first failure:

1. Check out the same commit, then write the env file from the secret (instance role;
   refuses a missing key, an empty or placeholder value, a test-only setting; mode 600,
   atomic; prints no value — `scripts/ops/test-render-staging-env.sh`, CI):
   `scripts/ops/render-staging-env.sh <env_secret_arn> /opt/flexibx/staging.env`
   (the AWS CLI comes from the host's first boot, `user-data.sh.tftpl`).
2. Database roles (`docs/runbooks/DATABASE_ROLES.md`) with the RDS-managed master secret.
3. Mark the database once: `scripts/ops/db-environment.sh mark staging --confirm-database <name>`.
4. `docker compose run --rm migrate` (refuses an unmarked database).
5. `docker compose up -d app worker scheduler`.
6. `docker compose run --rm check` — must print `STAGING CHECK PASSED` with 0 fail and
   0 not run, including `alert_destination` (a real test alert reached the destination).

## 6. Acceptance (all must hold; record each with its evidence)

| #   | Criterion                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------- |
| A1  | Gate on the host: `STAGING CHECK PASSED`, 0 fail, 0 not run                                                 |
| A2  | `https://<app_domain>/api/health?scope=liveness` 200 over TLS; `/ar` and `/en` render                       |
| A3  | Running containers carry the label `org.opencontainers.image.revision=<release-sha>` and the pushed digests |
| A4  | Sign-up → e-mail verification → sign-in works with the real mail provider                                   |
| A5  | One Creator Studio upload to the S3 bucket and one export (simulated provider) complete; the worker beats   |
| A6  | Scheduler ticks are 200 for 30 minutes; ops-status shows no alert                                           |
| A7  | A test alert arrived at the owner's destination                                                             |
| A8  | Backup job writes a set off-host; restored into a **new** database and `VERIFIED` (SERVICE_RESTORE.md § 3b) |
| A9  | One RDS point-in-time restore into a new instance (SERVICE_RESTORE.md § 3a), times recorded = measured RTO  |
| A10 | Container logs carry no secret, token or customer content (sample checked)                                  |

Until A1–A10 hold, staging is "deployed", not "accepted".

## 7. Stop conditions (halt the launch, change nothing further)

- the plan shows a destroy, or a resource not listed in the README;
- preflight, image verification, `migrate`, or the gate fails;
- a secret appears in a log, a plan output or a shell history;
- the cost estimate or the Budgets alarm exceeds the approved amount;
- any step would touch a database that is not marked `staging`.

## 8. Rollback

- **Application:** `FLEXIBX_TAG=<previous sha> docker compose up -d app worker scheduler`
  (no database change; migrations are backward-compatible, DEPLOYMENT.md § 4).
- **Failed migration:** restore the pre-deploy backup into a new database, mark it, point
  `DATABASE_URL` at it (SERVICE_RESTORE.md); never restore over the live database.
- **Whole environment (first launch only, no data to keep):** `terraform destroy` after
  switching `deletion_protection` off — a further explicit owner approval; RDS keeps a
  final snapshot and automated backups.

## 9. Measured RTO (to fill in on the hosted environment)

| Exercise                                 | Measured | Local reference (not hosted)                   |
| ---------------------------------------- | -------- | ---------------------------------------------- |
| Restore a backup set into a new database | —        | 1 GB real schema: restore 27.1 s, verify 2.2 s |
| RDS point-in-time restore                | —        | none (RDS only)                                |
| Application rollback to previous tag     | —        | app healthy in ≈ 6 s after `up -d` (Pass 19)   |
