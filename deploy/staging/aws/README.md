# Flexibx staging on AWS — infrastructure (Pass 15)

**Not applied.** Validated only (`terraform fmt -check`, `terraform validate` with the AWS
provider 6.69.1; no credentials, no plan). Applying it creates **paid** resources in the
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

1. **Region** (`region`, no default): decision D-1 (data residency) decides it.
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
# images: build from one commit, push with that commit as an immutable tag
docker build --target runner -t <ecr>/app:<sha> --build-arg GIT_SHA=<sha> . && docker push …   # worker, ops likewise
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
