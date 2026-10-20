# Flexibx staging on AWS — infrastructure (Passes 15–16)

**Not applied.** Validated only (`terraform fmt -check`, `terraform validate` with the AWS
provider 6.69.1, and `terraform test` against a **mocked** provider — `tests/`; no
credentials, no plan against AWS). Passing these proves the configuration is consistent
and that the properties below hold in it — not that it deploys or runs on AWS. Applying it creates **paid** resources in the
owner's account: only the owner runs it, after the decisions below.

## What it creates

| Resource                         | Purpose                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| EC2 `t3.large`, 80 GB gp3, EIP   | Docker host for `deploy/staging/compose.yaml` (app, worker, scheduler); Caddy for TLS; SSM, no SSH                              |
| RDS PostgreSQL 16 `db.t4g.small` | Private, encrypted, TLS required, 7-day automated backups (point-in-time recovery), deletion protection                         |
| S3 bucket                        | Private (public access blocked), SSE, no versioning, CORS for `https://<app_domain>` PUT, abort incomplete uploads after 3 days |
| ECR `app`, `worker`, `ops`       | Immutable tags, scan on push                                                                                                    |
| Secrets Manager `…/env`          | Empty container for `staging.env` (filled by the owner)                                                                         |
| IAM                              | Storage user limited to the bucket; host role: SSM + read that one secret + pull those images                                   |

Rough monthly cost (on-demand, before taxes; **check the AWS pricing calculator for the
chosen region**): EC2 ≈ $60–75, RDS ≈ $25–35 + storage and backups, S3/ECR/Secrets a
few dollars at staging volumes. No load balancer, NAT gateway or Multi-AZ.

## Decisions and inputs the owner provides

1. **Region** (`region`, no default): decision D-1 (data residency,
   PHASE_D_1_INFRASTRUCTURE_DECISIONS.md) decides it; see RELEASE_READINESS_DECISIONS.md R-2/R-3.
2. **Domain** (`app_domain`) and the DNS A record to the output `public_ip`.
3. AWS credentials of an account the owner controls, and a private Terraform state
   backend (S3 bucket with versioning) for a shared setup.
4. After apply: an access key for the output `storage_user`; the app's database roles
   (`docs/runbooks/DATABASE_ROLES.md`) using the RDS-managed master secret; the env
   secret's content (`deploy/staging/staging.env.example`: staging-only values); a test
   alert destination; a mail provider for the staging domain.

## Launch, once those exist

```bash
cd deploy/staging/aws && cp terraform.tfvars.example terraform.tfvars   # fill in
terraform init && terraform plan -out staging.plan && terraform apply staging.plan
# images: from a clean checkout of one commit, build + verify + push with the commit as an
# immutable tag (docs/runbooks/RELEASE_PIPELINE.md; nothing is pushed if a check fails)
FLEXIBX_REGISTRY=<ecr> scripts/release/build-and-verify.sh <sha> --push
# on the host (aws ssm start-session --target <host_instance_id>):
#   fetch the env secret into /opt/flexibx/staging.env (mode 600), check out the same
#   commit's deploy/staging/compose.yaml, then STAGING_CREATOR_STUDIO.md § 3:
scripts/ops/db-environment.sh mark staging --confirm-database flexibx_staging   # once (ops image)
FLEXIBX_REGISTRY=<ecr> FLEXIBX_TAG=<sha> docker compose run --rm migrate
FLEXIBX_REGISTRY=<ecr> FLEXIBX_TAG=<sha> docker compose up -d app worker scheduler
FLEXIBX_REGISTRY=<ecr> FLEXIBX_TAG=<sha> docker compose run --rm check      # must say PASSED
```

Rollback: `FLEXIBX_TAG=<previous sha> docker compose up -d app worker scheduler` (no
database change; migrations are backward-compatible, DEPLOYMENT.md § 1). A failed
migration: restore the pre-deploy backup into a **new** database (BACKUP_RESTORE.md), mark
it, switch `DATABASE_URL`. Never restore over the live database.

Teardown: `deletion_protection` must be switched off first; a final snapshot is kept.

## Audit (Pass 16)

Reviewed file by file against least privilege, encryption, exposure, recovery and
pinning. Changes made, each covered by `tests/staging.tftest.hcl` (8 runs, all passing;
mutants `publicly_accessible = true` and `delete_automated_backups = true` are caught):

| Area           | Finding                                                                  | Change                                                                  |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| S3             | No TLS-only policy: plain-HTTP requests were not refused                 | Bucket policy denies every request with `aws:SecureTransport = false`   |
| IAM (storage)  | Object rights on the whole bucket                                        | Limited to `workspaces/*` (every key the app writes; `storage.ts`)      |
| RDS            | Automated backups deleted with the instance                              | `delete_automated_backups = false` (PITR outlives an accidental delete) |
| RDS            | `db_backup_retention_days = 0` would silently disable PITR               | Validation: 1–35 days                                                   |
| EC2            | IMDSv2 required, but containers could reach the metadata service (hop 2) | `http_put_response_hop_limit = 1`: the host role stays with the host    |
| Host / Compose | Container logs unbounded (disk fills on a long-running host)             | Docker daemon and Compose: json-file, 10 MB × 5 per service             |

Checked and unchanged: RDS private (no public access, security group from the host only,
TLS required — RDS default `rds.force_ssl = 1` for PostgreSQL 15+, and `sslmode=require` in the URL), storage encrypted (RDS, EBS root, S3 SSE), master password
managed by RDS in Secrets Manager (never in Terraform state), deletion protection and a
final snapshot, ECR immutable tags and scan on push, host reached through SSM only (no SSH,
no inbound except 80/443 for Caddy, which renews its certificates itself), versions constrained in `versions.tf` (AWS provider `~> 6.69`, Terraform `>= 1.6`; tested with 6.69.1 and 1.13.4) — **not exact pins**: no `.terraform.lock.hcl` is committed yet because the registry is not reachable from this environment; commit the one the first `terraform init` writes, which pins the provider version and its checksums, no secret created by Terraform.

**Owner decisions left open** (RELEASE_READINESS_DECISIONS.md): region and account (R-2),
cost (R-3), ECR lifecycle (keep the last N tags), CloudWatch log shipping and retention
(R-7), RDS CloudWatch alarms and an SNS destination, storage autoscaling ceiling,
backup / maintenance windows, rotation of the storage user's access key (or move the app
to the host role), the default-VPC assumption, and unrestricted egress from the host
(needed for image pulls and the mail / AI providers; narrowing it needs a NAT or proxy).

## Review (Pass 17)

Re-checked against the first hosted deployment; still **not applied, not planned against
AWS** (no credentials; no approval for paid resources). Made explicit (they were the
provider's defaults, now pinned so an edit cannot flip them silently) and tested: the
media bucket is never destroyed with its objects (`force_destroy = false`), image
repositories are never deleted with their images (`force_delete = false`), a deleted env
secret stays recoverable for 30 days. New `terraform test` runs: the host accepts 443 and
80 only (no SSH) and the database 5432 from the host only; nothing is deleted with its
data. 10 runs pass; mutants `force_destroy = true` and an SSH port are caught.

Secrets and rotation: the RDS master password is created and rotated by RDS in Secrets
Manager (`manage_master_user_password`; RDS's default rotation, 7 days); the env secret
is written by the owner; the storage user's access key is created by the owner and must
be rotated by hand (or the bucket moved to the host role — an open decision, see Audit).
Logs and alarms: container logs rotate on the host; nothing is shipped or alarmed in
AWS yet (RELEASE_READINESS_DECISIONS.md R-7). The images pushed to ECR are scanned on
push; the same images are scanned before by CI (Trivy).

## Pass 18

- **Lock file committed** (`.terraform.lock.hcl`): `hashicorp/aws` 6.69.1 pinned with the
  `zh:` hashes of all 15 platform packages from the provider's SHA256SUMS — whose GPG
  signature was verified against HashiCorp's release key (primary
  `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`) — and the `h1:` hash of the
  linux_amd64 package, which matched them. `terraform init` refuses a provider package
  whose checksum is not in the lock file (tested). Constraint in `versions.tf` unchanged
  (`~> 6.69`): the lock file is what pins the exact version.
- **New test `iam_is_least_privilege`:** the storage user has named `s3:` actions on the
  media bucket only; the host policy has no wildcard action, a wildcard resource only for
  `ecr:GetAuthorizationToken`, the env secret only; the host's one managed policy is
  Session Manager's. 11 runs pass; mutants `s3:*` and a secret read on `*` are caught.
- Still **not planned or applied against AWS**; logs, alarms and their retention are
  owner decision R-7 (paid resources). RDS rotates its master password itself; the
  storage user's key is rotated by hand (open decision).

## Pass 19

- Launch publishes images with `scripts/release/build-and-verify.sh <sha> --push` (above):
  nothing is pushed unless every check passed; a dirty tree or an existing tag is refused.
- `terraform fmt -check`, `validate` and `test` re-run against the lock file: 11 runs pass.
- Still **not planned or applied against AWS**: no account, region, cost approval or
  secrets channel (RELEASE_READINESS_DECISIONS.md "Inputs for the first AWS deploy").

## Pass 20

- The whole first launch — owner inputs, preflight, plan, the three approvals (use the
  account, create resources, push images), deploy, acceptance A1–A10, stop conditions,
  rollback and the RTO to measure — is one procedure: docs/runbooks/STAGING_LAUNCH.md.
- `scripts/release/staging-preflight.sh terraform.tfvars <sha>` checks the variables file,
  the release commit, the lock file and `terraform validate` without any AWS call; it
  passes on this repository with a filled-in file and refuses `terraform.tfvars.example`.
- Not planned or applied against AWS (no account, approval or secrets channel).
