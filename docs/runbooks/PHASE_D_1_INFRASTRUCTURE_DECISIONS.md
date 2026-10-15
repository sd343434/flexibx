# Phase D.1 — infrastructure decisions and deployment plan

Date: 2026-10-13. Branch `claude/amazing-sagan-pvouqy`, baseline HEAD `451c4f6` (equal to
the remote). Builds on `docs/runbooks/PHASE_D_READINESS_ASSESSMENT.md` (not modified).

**Scope and honesty statement.** Research and planning only. No account, resource, role,
secret, domain, scheduler, monitor or alert destination was created; nothing was deployed;
no persistent database was contacted; no application code, migration or runtime
configuration was changed.

**How the vendor facts were checked.** The research environment's network proxy blocked
direct page loads of every vendor site (HTTP 403 / DNS failure). Facts below come from web
searches restricted to the vendors' own domains (and, for Vercel and Supabase, their
documentation search), on 2026-10-13. They are excerpts returned by search, **not pages
read in full**. Every figure marked _unverified_ could not be confirmed at all. **Before any
purchase or provisioning, each linked page must be re-read in a browser** (decision D-12).
No vendor was contacted for a quote.

**Exception — AWS prices.** The AWS figures in § 4 were read directly from AWS's official
public Price List API for `me-central-1`
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/me-central-1/index.json`,
an unauthenticated, free endpoint), fetched 2026-10-13; publication dates: RDS 2026-10-06,
ECS/Fargate 2026-09-11, ELB 2026-09-11, VPC 2026-09-17, CloudWatch 2026-10-07, S3
2026-10-12, Secrets Manager 2026-09-11, data transfer 2026-09-16. On-demand list prices in
USD, excluding tax, support plans, free tiers and discounts.

## 1. Executive summary

**Recommendation (conditional — see § 15.5): AWS in the Middle East (UAE) region
`me-central-1`** — the existing
Docker image on **ECS Fargate** behind a load balancer, **RDS for PostgreSQL 16**, the
scheduler as **EventBridge Scheduler**, secrets in **AWS Secrets Manager**, backups by RDS
PITR **plus** independent logical dumps in a **separate AWS account** with object lock,
external monitoring by an uptime service that can send the ops-status bearer header, errors
to Sentry, alerts to a team channel webhook.

Why this option over the managed alternatives:

1. **Region.** It is the only compared option with a Gulf region for both the application
   and the database. Render, DigitalOcean, Railway, Fly.io and Neon have no Middle East
   region; Vercel has `dxb1` (Dubai) for functions, but its natural database partners
   (Neon) do not, so every query would cross from Dubai to Frankfurt. No Saudi AWS region
   was confirmed live on 2026-10-13 (announced for 2026); if customers require data inside
   Saudi Arabia, this recommendation must be revisited (D-1).
2. **Database roles.** The role model (`DATABASE_ROLES.md`, `db-roles.sql`) transfers
   object ownership, sets default privileges, column grants and SECURITY DEFINER functions.
   RDS documents a master user with CREATE ROLE through `rds_superuser`. Neon's role
   documentation (search excerpt, to re-read) says `ALTER … OWNER TO` is restricted — a
   direct conflict with `db-roles.sql` if confirmed.
3. **Fits the code as it is.** The standalone image runs unchanged; the `migrate` image
   (full source + `tsx`) doubles as the one-off job image for migrations, `db-roles.sql`
   (needs `psql`, see § 5), `admin:mfa-reset` and `admin:grant`; scheduled work can run as
   a task, not an HTTP request held open.
4. **PITR and independence.** RDS retention is configurable up to 35 days with a new
   instance per restore; AWS Backup cross-account copy is listed for the UAE region.

Cost (§ 4, revised; AWS list prices for `me-central-1` plus stated usage assumptions):
**staging ≈ USD 94/month**, **initial production ≈ USD 182/month**, shared SaaS (Sentry,
Resend, uptime monitor) **≈ USD 46–83/month** — **≈ USD 322–359/month for both
environments**, before tax, OpenAI usage, media storage and Meta ad spend. These are
estimates, not quotes.

Main costs of this choice: more to operate than Vercel/Render (VPC, load balancer, IAM,
task definitions), which is why § 12 puts infrastructure-as-code and a staging rehearsal
first.

## 2. Requirements taken from the code

| Need                | From                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container runtime   | `Dockerfile` `runner` (Next.js standalone, Node 22, non-root, liveness healthcheck)                                                                                                                       |
| One-off jobs        | `Dockerfile` `migrate` target (`prisma migrate deploy`); `db-roles.sql` after each migration; `pnpm admin:grant` (interactive TOTP prompt), `pnpm admin:mfa-reset`                                        |
| Scheduled work      | `POST /api/internal/automation-tick` every 1–5 min (`AUTOMATION_CRON_SECRET`), `/api/internal/video-retention` (`VIDEO_RETENTION_CRON_SECRET`); CLI equivalents `pnpm automation:tick`, `video:retention` |
| Overlap safety      | Tick: "slots are claimed by compare-and-set and tasks by lease" (route comment); retention: run lock                                                                                                      |
| Monitoring          | `/api/health` (`?scope=liveness` / `readiness`), `/api/internal/ops-status` (bearer `OPS_STATUS_SECRET`; tick age critical after 15 min)                                                                  |
| Alerts              | `ALERT_WEBHOOK_URL` + `ALERT_WEBHOOK_TOKEN` (HTTPS JSON, throttled)                                                                                                                                       |
| PostgreSQL          | 16; `pgcrypto`, `citext`; direct (non-pooled) connection for migrations and `pg_dump`; TLS `verify-full`                                                                                                  |
| Public HTTPS origin | Meta OAuth redirect URIs and webhooks                                                                                                                                                                     |
| Request size        | Webhook bodies are capped in code; media uploads go to object storage by presigned URL                                                                                                                    |

## 3. Options compared

Three shapes, with a real provider for each. "Unverified" = not confirmed from an official
source on 2026-10-13.

| Criterion                       | A. Vercel Pro + Neon (Supabase as alt.)                                                                                             | B. Render (DigitalOcean as alt.)                                                                                               | C. AWS `me-central-1`: ECS Fargate + RDS                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js build/run               | Native platform; Node 24/22 (Next.js 16 named support unverified); body limit 4.5 MB; function max 800 s on Pro                     | Docker web service runs the image unchanged                                                                                    | ECS on Fargate runs the image unchanged; App Runner is closed to new customers (do not use)                                                  |
| Scheduler / worker              | Cron per minute on Pro (Hobby: once a day); **no retry**, may skip or double-deliver; bearer `CRON_SECRET`                          | Cron service (12 h max run, one run at a time, no retry, min interval unverified); DO jobs min **15 min**                      | EventBridge Scheduler (available in `me-central-1`); target ECS task or HTTP (target type to confirm in staging)                             |
| Gulf region (app)               | `dxb1` Dubai for functions                                                                                                          | **None** (Render: Oregon, Ohio, Virginia, Frankfurt, Singapore; DO nearest FRA1/BLR1)                                          | `me-central-1` UAE, 3 AZs (opt-in region); `me-south-1` Bahrain                                                                              |
| Gulf region (database)          | **None** for Neon (nearest Frankfurt); Supabase Middle East unverified                                                              | **None**                                                                                                                       | RDS in `me-central-1`                                                                                                                        |
| PostgreSQL 16                   | Neon 14–18; Supabase yes                                                                                                            | Render 13–18; DO 15–18                                                                                                         | RDS 11–17 (engine page)                                                                                                                      |
| TLS                             | Neon required; Supabase **not enforced by default**                                                                                 | Render external TLS required; DO required                                                                                      | `rds.force_ssl` = 1 by default from PG 15                                                                                                    |
| Custom roles for `db-roles.sql` | Neon: SQL roles OK, **`ALTER … OWNER TO` restricted**; Supabase: CREATE ROLE + SECURITY DEFINER documented, column GRANT unverified | Render: default user not superuser (forum, not docs); SQL `CREATE USER` allowed; rest unverified; DO: `doadmin` has CREATEROLE | Master user in `rds_superuser` (CREATE ROLE, CREATEDB); SECURITY DEFINER/ownership transfer expected to work — **must be proven in staging** |
| PITR                            | Neon: 7 d (Launch) / 30 d (Scale); Supabase add-on 7 d ≈ $100/mo, RPO 2 min                                                         | Render 3 d (Hobby) / 7 d (Pro+); DO 7 d                                                                                        | 0–35 days configurable; ~5 min RPO; restore = new instance                                                                                   |
| Independent backup              | Neon recommends `pg_dump` off-platform; store elsewhere                                                                             | Render exports kept 7 days; dump elsewhere                                                                                     | AWS Backup cross-account copy listed for UAE; RDS backup replication only UAE→Frankfurt; plus our dumps to a separate account                |
| Secrets                         | Vercel "Secret" env vars (not viewable after save)                                                                                  | Env groups, secret files                                                                                                       | Secrets Manager (per-task IAM access, versioning, rotation; $0.40/secret/month)                                                              |
| Logs / alerts                   | Runtime logs 1 day on Pro (30 d with Observability Plus); drains on Pro                                                             | Logs 7 d (Hobby) / 14 d (Pro); log streams                                                                                     | CloudWatch Logs/Alarms (priced for `me-central-1` in the Price List); retention configurable                                                 |
| Admin CLIs / migrate job        | **Needs a separate runner** (not on Vercel)                                                                                         | One-off job or shell on the service                                                                                            | ECS run-task with the `migrate` image; ECS Exec for interactive `admin:grant` (to confirm)                                                   |
| Exit / portability              | Next.js-specific hosting; DB portable (`pg_dump`)                                                                                   | Image portable; DB portable                                                                                                    | Image portable; DB portable; most AWS-specific work is IaC + IAM                                                                             |
| Operating effort                | Lowest                                                                                                                              | Low                                                                                                                            | **Highest** (VPC, ALB, IAM, task definitions) — mitigated with IaC                                                                           |
| Verdict                         | Rejected: database cannot be in the Gulf and ownership transfer conflicts with the role model; extra runner needed for CLIs         | Rejected: no Gulf region for app or DB; scheduler interval unconfirmed (DO: 15 min is too slow)                                | **Recommended**, subject to D-1 (Saudi residency) and the staging proof of the role model                                                    |

## 4. Cost estimate (monthly, with assumptions)

_Revised in the final decision review (§ 15): recalculated line by line; ECR, KMS,
EventBridge Scheduler, Secrets Manager API calls, cross-AZ traffic and the backup bucket
added; data transfer priced at the higher of the two figures in the price list._

**How to read it.** Three separate blocks — staging, production, shared SaaS — added once
each; no line appears in two blocks. "List" = taken from the AWS Price List API for
`me-central-1` (top note). "Estimate" = a usage assumption multiplied by a list price.
"Vendor" = SaaS price from a search excerpt of the vendor's pricing page (not re-read).
Nothing is a quote; free tiers, credits, tax and discounts are ignored.

**Assumptions** (each one changes the result if wrong):

| #   | Assumption                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a1  | Limited pilot: ≤ 20 workspaces, ≤ 200 users, database 20 GB provisioned (RDS gp3 minimum), ≤ 3,000 emails/month                                                                                                                                       |
| a2  | 730 hours/month; web tasks x86, 0.5 vCPU / 1 GB each (ARM would be ~20 % cheaper but needs a multi-arch image)                                                                                                                                        |
| a3  | Tick every 5 minutes = 8,755 runs/month, each billed 1 minute (Fargate minimum). **If image pull and start-up make a run 2 minutes, the tick line doubles (≈ $9.4).**                                                                                 |
| a4  | No NAT gateway: tasks in public subnets with a public IPv4 address, inbound allowed only from the load balancer's security group                                                                                                                      |
| a5  | Load balancer averages 1 LCU (pilot traffic)                                                                                                                                                                                                          |
| a6  | Outbound internet traffic: 5 GB staging, 50 GB production; cross-AZ app↔database traffic 5 / 20 GB each way                                                                                                                                           |
| a7  | Burstable RDS (t4g) stays within its CPU baseline. Sustained load above it adds CPU-credit charges (the price list shows $0.075 per vCPU-hour for T3 credits in this region; no T4g entry was found)                                                  |
| a8  | Backup bucket in the separate account: production ≈ 100 GB of dumps (daily 14, weekly 8, monthly 12 at ~3 GB each) + 50 GB media; staging ≈ 7 GB dumps + 10 GB test media                                                                             |
| a9  | RDS backup storage up to the provisioned size is not charged (the price list labels backup storage as "exceeding free allocation"; the size of that allocation was not read on an AWS page). Production adds 20 GB beyond it for a 14-day PITR window |
| a10 | One Sentry organization, one Resend account, one monitor account shared by both environments                                                                                                                                                          |

**Staging**

| Item                                                  | Basis                                    | USD      | Kind     |
| ----------------------------------------------------- | ---------------------------------------- | -------- | -------- |
| Web: 1 task 0.5 vCPU / 1 GB                           | 730 × (0.5 × 0.0526 + 1 × 0.0058)        | 23.43    | List     |
| Tick task (a3)                                        | 8,755 × 1/60 h × 0.0321                  | 4.68     | Estimate |
| Retention and backup tasks                            | 2 jobs × 30 × 10 min                     | 0.32     | Estimate |
| Application Load Balancer (a5)                        | 730 × 0.028224 + 730 × 0.00896           | 27.14    | List/est |
| Public IPv4: 2 (load balancer) + 1 (web) + tick tasks | 3 × 730 × 0.005 + 146 h × 0.005          | 11.68    | List     |
| RDS db.t4g.micro Single-AZ + 20 GB gp3                | 730 × 0.019 + 20 × 0.14                  | 16.67    | List     |
| CloudWatch Logs 2 GB ingested + stored, 10 alarms     | 2 × 0.63 + 2 × 0.033 + 10 × 0.10         | 2.33     | Estimate |
| S3 backup/test bucket ~17 GB                          | 17 × 0.025                               | 0.43     | Estimate |
| ECR image storage ~5 GB                               | 5 × 0.10                                 | 0.50     | Estimate |
| Secrets Manager: 15 secrets + task-start reads        | 15 × 0.40 + ~88k calls × $0.05/10k       | 6.44     | List/est |
| EventBridge Scheduler                                 | first 14 million invocations/month at $0 | 0.00     | List     |
| Data transfer out 5 GB                                | 5 × 0.117                                | 0.59     | List     |
| Cross-AZ traffic                                      | 10 GB × 0.01                             | 0.10     | Estimate |
| **Staging total**                                     |                                          | **≈ 94** |          |

**Initial production**

| Item                                                                                          | Basis                                  | USD       | Kind     |
| --------------------------------------------------------------------------------------------- | -------------------------------------- | --------- | -------- |
| Web: 2 tasks 0.5 vCPU / 1 GB in two AZs                                                       | 2 × 23.43                              | 46.87     | List     |
| Tick task (a3)                                                                                |                                        | 4.68      | Estimate |
| Retention and backup tasks                                                                    |                                        | 0.32      | Estimate |
| Application Load Balancer (a5)                                                                |                                        | 27.14     | List/est |
| Public IPv4: 2 + 2 + tick tasks                                                               | 4 × 3.65 + 0.73                        | 15.33     | List     |
| RDS db.t4g.small **Multi-AZ** + 20 GB Multi-AZ gp3 + 20 GB extra backup (a9)                  | 730 × 0.076 + 20 × 0.279 + 20 × 0.1045 | 63.15     | List/est |
| CloudWatch Logs 5 GB, 10 alarms                                                               |                                        | 4.32      | Estimate |
| S3 backup + media ~150 GB (a8)                                                                | 150 × 0.025                            | 3.75      | Estimate |
| ECR image storage ~5 GB                                                                       |                                        | 0.50      | Estimate |
| Secrets Manager: 18 secrets + task-start reads                                                | 18 × 0.40 + 0.44                       | 7.64      | List/est |
| KMS: 2 customer-managed keys (RDS snapshots shareable with the backup account; backup bucket) | 2 × 1.00                               | 2.00      | List     |
| EventBridge Scheduler                                                                         | within the 14 million free invocations | 0.00      | List     |
| Data transfer out 50 GB                                                                       | 50 × 0.117                             | 5.85      | List     |
| Cross-AZ traffic                                                                              | 40 GB × 0.01                           | 0.40      | Estimate |
| **Production total**                                                                          |                                        | **≈ 182** |          |

Optional, not in the total: **AWS Backup cross-account copy** of RDS snapshots — the
destination stores full snapshot copies; at the RDS backup-storage list price
($0.1045/GB-month) 20–60 GB of copies is ≈ $2–6 (estimate; the AWS Backup price list
returned no RDS-specific line for this region, so the exact charge is unverified). The
logical dumps (a8) already give an independent copy. Single-AZ RDS instead of Multi-AZ:
production RDS line ≈ $32.6 (saves ≈ $30), with longer recovery after an instance or zone
failure.

**Shared SaaS** (a10)

| Item           | USD/month   | Kind                                                                                                               |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Sentry Team    | 26–29       | Vendor                                                                                                             |
| Resend Pro     | 20          | Vendor (the free plan's 100/day limit is too low for resets and invitations)                                       |
| Uptime monitor | 0–34        | Vendor; Better Stack free tier from a vendor article; paid price and custom-header support on free tier unverified |
| **SaaS total** | **≈ 46–83** |                                                                                                                    |

**Totals.** Staging ≈ 94 + production ≈ 182 + SaaS ≈ 46–83 = **≈ USD 322–359 per month**
for both environments, nothing counted twice. Production alone with the SaaS ≈ USD
228–265. The earlier figure (315–352) omitted ECR, KMS, Secrets Manager API calls,
cross-AZ traffic and part of the backup bucket.

**Not included:** tax/VAT, an AWS support plan, Route 53 hosted zone and domain (hosted
zone price not found in the regional price list), a NAT gateway or VPC interface endpoints
if chosen later, AWS Backup copies, OpenAI usage, generative video, media kept on Wasabi,
Meta ad spend, WhatsApp conversation charges, payment fees.

**Most sensitive to:** RDS size/Multi-AZ, number and size of web tasks, tick run length
(a3), outbound traffic and log volume. **Growth reference** (estimate): 4 web tasks of
1 vCPU / 2 GB ≈ $187; RDS db.t4g.medium Multi-AZ with 100 GB ≈ $139; production then
≈ USD 400–550/month before media and AI costs.

### Alternatives, for comparison only

- **A (Vercel Pro + Neon Launch):** Vercel $20/member/month with $20 usage credit; Neon
  Launch compute $0.106/CU-hour (≈ $77/month for one CU always on), storage $0.35/GB-month,
  history $0.20/GB-month; plus a separate runner for CLIs and migrations.
- **B (Render):** web service Starter $7/month, Postgres basic-256mb $6/month + $0.30/GB,
  cron $1/month minimum; 7-day PITR needs a Pro workspace (workspace price unverified).

## 5. Proposed architecture

```
                    Users (Gulf)            Meta / WhatsApp webhooks
                         │ HTTPS                     │ HTTPS
                         ▼                           ▼
              ┌───────────────────── AWS me-central-1 (prod account) ─────────────────────┐
              │  ALB (TLS cert, HTTP→HTTPS)                                                │
              │    │                                                                       │
              │    ▼  private subnets                                                      │
              │  ECS service "web" (runner image, ≥ 2 tasks, 2 AZs) ── role: runtime       │
              │    │ DATABASE_URL = flexibx_app      secrets ← Secrets Manager (per task) │
              │    ▼                                                                       │
              │  RDS PostgreSQL 16 (private, TLS forced, PITR, Multi-AZ in production)     │
              │    ▲            ▲                ▲                                         │
              │    │            │                │                                         │
              │  ECS task     ECS task        ECS task "ops" (migrate image + psql)         │
              │  "tick"       "retention"     migrate → db-roles.sql (owner credential)    │
              │  (runtime)    (runtime)       admin:mfa-reset (runtime) / admin:grant (grant)│
              │    ▲            ▲                                                          │
              │  EventBridge Scheduler (every 5 min / daily, retry policy)                 │
              │  CloudWatch Logs + alarms (task failures, 5xx, RDS)                        │
              │  S3 media bucket (versioning)                                              │
              └────────────────────────────────────────────────────────────────────────────┘
                         │ daily pg_dump (owner) + AWS Backup copy
                         ▼
              Backup account (separate AWS account): S3 with versioning + Object Lock

  Outside AWS: uptime monitor → /api/health and /api/internal/ops-status (bearer header)
               Sentry (EU data region) ← app errors, scrubbed
               ALERT_WEBHOOK_URL → team channel (Slack/Teams) or incident tool
               Resend (sending region eu-west-1) ; OpenAI ; Meta Graph API
```

Notes:

- **`psql` in the ops image.** The `migrate` image is based on Node and was not checked for
  a PostgreSQL client; `db-roles.sql` and the backup scripts need `psql`/`pg_dump` 16. A
  small ops image (or adding the client to the migrate stage) is an engineering item that
  needs approval (Dockerfile change).
- **Scheduler target.** Prefer EventBridge Scheduler → **ECS RunTask** of the ops image
  running `pnpm automation:tick` (and `video:retention`): the work runs in a task with its
  own lifetime, not inside an HTTP request held open by the scheduler. The tick CLI does
  exactly the work of the endpoint (`scripts/automation/tick.ts`) and exits non-zero on a
  failed phase. The alternative (scheduler → HTTPS endpoint with the bearer secret) also
  works because overlapping calls are safe. Which targets and retry settings the scheduler
  supports must be confirmed in staging (unverified).
- **Sentry data region.** Chosen at organization creation and fixed (US or EU; no Middle
  East). Error events must not carry tokens or personal data; the app's logger redaction
  rules apply to what is sent.
- **Resend** stores account data and email metadata in the United States regardless of the
  sending region — a data-residency point for D-1.

## 6. Database and roles

1. **Provider and PITR.** RDS PostgreSQL 16 in `me-central-1`; automated backups with
   **14-day retention** (pilot; 35 days possible), which gives PITR across that window
   (~5-minute RPO). Production Multi-AZ; staging Single-AZ. Note: RDS's console default is 7
   days but the API/CLI default is 1 day — set it explicitly in IaC.
2. **Independent copy.** Daily `scripts/ops/db-backup.sh` (owner credential, run as an
   ECS task) to an S3 bucket in a **separate AWS account** with versioning and Object Lock
   (retention per `BACKUP_RESTORE.md` § 2: daily 14 d, weekly 8 w, monthly 12 m);
   optionally AWS Backup cross-account copy of the RDS snapshots (for RDS, AWS Backup does
   cross-Region or cross-account copy, not both in one plan; cost in § 4). Access: the backup job's write-only role
   and two named custodians.
3. **Tested restore before any cutover.** PITR restore into a new instance (new endpoint),
   and `db-restore.sh` of the dump into a throwaway instance, both followed by
   `db-verify.sh` → `VERIFIED`, with timings recorded.
4. **Credential separation.** RDS master user = break-glass only (Secrets Manager, managed
   rotation, two custodians). Owner role (`flexibx_owner`, member of nothing privileged
   beyond what the owner needs) for migrate, `db-roles.sql` and backups; runtime
   `flexibx_app` for web, tick, retention and `admin:mfa-reset`; grant
   `flexibx_admin_grant` for `admin:grant` only. Each in its own Secrets Manager secret,
   readable only by the task role that needs it.
5. **Secrets never on command lines or in logs.** ECS injects secrets as environment
   variables from Secrets Manager (task definition references, not values); passwords set
   with `\password` from a psql session inside the ops task; the ops scripts already turn
   URLs into a private `PGPASSFILE`. Prisma's schema engine receives the URL on its
   command line inside the one-off migrate task only (`DEPLOYMENT.md` § 1) — acceptable
   because that container runs nothing else.
6. **Provider permissions to prove in staging** (blocking for stage 3): see § 15.2 for
   what AWS documents and what remains unproven. In short: the master user creates the
   three roles; ownership transfer, default privileges, column grants and SECURITY DEFINER
   functions are expected to work under standard PostgreSQL rules but are not stated on an
   AWS page, so `DATABASE_ROLES.md` § 3 must pass in staging before any production
   cutover. **`db-roles.sql` does not detect membership in `rds_superuser` or in
   predefined roles** such as `pg_write_all_data` (its check looks for roles with the
   SUPERUSER attribute, which `rds_superuser` does not have) — add the manual check of
   § 15.2 to the staging checklist.
7. **TOTP-replay gap (B6).** Proposed design in § 15.3 (needs approval: migration, role
   script and code change). Until merged, the gap stays accepted at Low (D4 of the readiness
   report).
   _Update 2026-10-14: implemented locally (uncommitted) in Phase D.2, together with the
   membership check of § 15.2 — `docs/runbooks/PHASE_D_2_SECURITY_HARDENING.md`._

## 7. Scheduling, monitoring and alerts

| Concern                     | Design                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Work outlives HTTP          | Tick and retention run as ECS tasks started by the scheduler; the HTTP endpoints stay available as a fallback                                                                                                                                                                                                                              |
| Safe retries                | EventBridge Scheduler delivers at least once, and ECS has no built-in single-run guarantee (§ 15.2). The tick claims slots by compare-and-set and tasks by lease; retention holds a run lock — a duplicated run is designed to be safe (property of the code; to be re-observed in staging). Bounded run time and retry settings in § 15.2 |
| Detect a stopped scheduler  | External monitor on `/api/internal/ops-status` every 1–5 min with `Authorization: Bearer <OPS_STATUS_SECRET>` (Better Stack HTTP monitors accept custom headers); 503 → page. Tick age goes critical after 15 min                                                                                                                          |
| Liveness/readiness          | Monitor `/api/health?scope=liveness` and `?scope=readiness`; ALB health check on liveness                                                                                                                                                                                                                                                  |
| Task failures               | CloudWatch alarm on failed scheduled tasks (non-zero exit), on messages in the scheduler's dead-letter queue, and on ALB 5xx                                                                                                                                                                                                               |
| Alert destination           | `ALERT_WEBHOOK_URL` → a channel with a named on-call owner (D-5); monitor notifications to the same place                                                                                                                                                                                                                                  |
| No secrets or customer data | Alert payloads (`alert-sink.ts`: title, severity, key, `details` from each caller) must be reviewed in staging for personal data or secrets before a real destination is connected; the monitor stores only the ops-status secret; log retention set per group; a day of logs grepped for secrets in staging (D3 item 8)                   |

No real job was run and no test alert was sent in this phase.

## 8. Secrets and key rotation

All in AWS Secrets Manager (versioned, access-logged by CloudTrail), one secret per value,
readable only by the task role that uses it. Never in the repository, image, CI logs, chat
or `.env` outside local development.

| Secret                                                  | Used by                               | Rotation effect today                                                                                                                                                                                                                                   | Plan                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_SECRET`                                           | web, tick, CLIs                       | Ends every session and pending verification/reset link; **every two-factor secret and backup code becomes undecryptable** → every enrolled user, including all administrators, must be reset and re-enroll; admin flags are lost and must be re-granted | Generate once in the manager; escrow with two custodians; rotate only as an incident until key versioning (P9) separates MFA encryption from session signing; keep every retired value for as long as backups made with it are retained (§ 15.3) |
| `ENCRYPTION_KEY`                                        | web, tick                             | Every stored platform token (Meta, WhatsApp, ads, social) becomes unreadable → every workspace must reconnect                                                                                                                                           | Same; key versioning (key id prefix, decrypt with any listed key, background re-encryption) before scale                                                                                                                                         |
| `ADMIN_GRANT_DATABASE_URL`                              | `admin:grant` only (ops task)         | Old password stops working at once; no data effect                                                                                                                                                                                                      | Rotate after each operator change and at least quarterly; never in the web task                                                                                                                                                                  |
| `DATABASE_URL` (runtime), owner URL, master             | web/tick; migrate/backup; break-glass | Restart tasks to pick up the new value; brief connection errors if not staged                                                                                                                                                                           | Two-step: set new password, update secret, roll tasks; RDS-managed rotation for the master (7-day default)                                                                                                                                       |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TOKEN`              | web, tick                             | Alerts fail (logged) until both sides match                                                                                                                                                                                                             | Rotate with the destination owner; verify with a staging test alert                                                                                                                                                                              |
| `OPS_STATUS_SECRET`                                     | web; external monitor                 | Monitor reports down until updated                                                                                                                                                                                                                      | Rotate the app secret and the monitor header in one change window                                                                                                                                                                                |
| `AUTOMATION_CRON_SECRET`, `VIDEO_RETENTION_CRON_SECRET` | web; scheduler (HTTP fallback)        | HTTP-triggered runs refused until updated                                                                                                                                                                                                               | Same as above; unused if the scheduler runs tasks                                                                                                                                                                                                |
| `META_APP_SECRET`, verify tokens                        | web                                   | Webhook signature checks fail until updated; Meta dashboard change                                                                                                                                                                                      | Rotate in Meta and the manager together                                                                                                                                                                                                          |
| `RESEND_API_KEY`                                        | web, tick                             | Email fails until updated                                                                                                                                                                                                                               | Create new key, deploy, revoke old                                                                                                                                                                                                               |
| `OPENAI_API_KEY`, storage keys                          | web, tick                             | Feature fails until updated                                                                                                                                                                                                                             | Same overlap pattern                                                                                                                                                                                                                             |
| Payment provider keys                                   | future                                | —                                                                                                                                                                                                                                                       | Decided with D-9                                                                                                                                                                                                                                 |

No secret value was read, printed, created or rotated in this phase.

## 9. Staged rollout

Each stage starts only when the previous one is done and recorded.

| #   | Stage                                     | Prerequisites                                                                                                       | Success criteria                                                                                                                                          | Rollback                                                                                                                    |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Separate staging environment              | D-1…D-6 approved; AWS accounts (prod, staging, backup); IaC reviewed                                                | Staging over HTTPS; `/api/health?scope=readiness` 200; migrate task applied all migrations as owner; secrets only in Secrets Manager                      | Destroy the staging stack (IaC); nothing shared with production                                                             |
| 2   | Backup and restore drill                  | Stage 1; backup account and bucket with Object Lock                                                                 | Daily dump lands in the backup account; PITR restore and dump restore both `VERIFIED` by `db-verify.sh`; timings recorded                                 | Nothing to undo (restores go to throwaway instances)                                                                        |
| 3   | Role model (after cutover plan approval)  | Stage 2 `VERIFIED`; `psql` in ops image; `DATABASE_ROLES.md` § 2 rehearsed                                          | `DATABASE_ROLES.md` § 3 checklist all pass; app runs as `flexibx_app`; `admin:grant` works only with the grant credential                                 | Redeploy with the owner credential (restores pre-cutover state, recorded as incident)                                       |
| 4   | Auth flows                                | Stage 3; Resend staging subdomain verified                                                                          | Sign-up + verification, sign-in, password reset, MFA enroll, TOTP and backup-code sign-in, replay refused, `admin:mfa-reset` — all pass                   | Fix forward in code; staging data disposable                                                                                |
| 5   | Meta and Resend on approved test accounts | Stage 4; Meta test app/users, staging redirect URIs and webhooks registered                                         | Supervised test (`ADS_WHATSAPP_LIVE_TEST_SETUP.md` § 7) with minimum spend limits; webhook signature tamper rejected; emails received, SPF/DKIM pass      | Kill switches (`ADS_EXECUTION_ENABLED`, `WHATSAPP_SENDING_ENABLED`, `SOCIAL_SENDING_ENABLED`) off; disconnect test accounts |
| 6   | Scheduler, monitoring, alerts drill       | Stage 1; monitor and alert destination approved                                                                     | Scheduler disabled → ops-status 503 within ~15 min → monitor alert and webhook alert received by on-call; re-enabled → recovers                           | Re-enable the schedule                                                                                                      |
| 7   | Limited pilot                             | Stages 1–6 in production equivalents; production PITR restore tested; keys escrowed; privacy policy/terms published | Named pilot customers only; no critical alert unresolved for 7 days; daily backup and weekly restore check green                                          | Kill switches; app rollback to previous image; data restore by PITR as last resort                                          |
| 8   | Production go/no-go                       | Pilot review                                                                                                        | All D2 items of the readiness report done or formally accepted; Meta App Review approved for launched features; on-call rota; cost within approved budget | Stay in pilot                                                                                                               |

## 10. Decisions

_The decision list is condensed into blocking and deferrable decisions in § 15.4._

### Confirmed by this analysis (recommendations, still subject to your approval)

- Containers on a managed container platform, not serverless functions (CLIs, migrate job,
  tasks independent of HTTP).
- PostgreSQL 16 on a managed service with PITR ≥ 14 days, TLS `verify-full`, private
  networking, plus independent dumps in a separate account with object lock.
- Three database credentials (owner, runtime, grant) plus a break-glass master; one secret
  per value in a managed secret store.
- Scheduler starts tasks; external monitor watches ops-status with the bearer header.
- Infrastructure as code for every environment (tool decided under D-6).

### Need your approval

| #    | Decision                                                                                                   | Recommendation                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D-1  | Data residency: is the UAE acceptable, or must data stay in Saudi Arabia (or another country)?             | UAE (`me-central-1`) unless customers/legal require KSA             |
| D-2  | Hosting provider                                                                                           | AWS (Option C)                                                      |
| D-3  | Database: RDS PostgreSQL 16; Multi-AZ in production; PITR retention                                        | Yes; 14 days pilot                                                  |
| D-4  | Backup account and retention                                                                               | Separate AWS account, Object Lock, BACKUP_RESTORE.md retention      |
| D-5  | Alert destination and on-call names                                                                        | Team chat webhook + 2 named people                                  |
| D-6  | IaC tool (Terraform/OpenTofu or AWS CDK) and who reviews it                                                | Terraform/OpenTofu                                                  |
| D-7  | External monitor (Better Stack or other) and Sentry (EU region)                                            | Better Stack + Sentry EU                                            |
| D-8  | Email: Resend plan and sending domain/subdomain                                                            | Resend Pro, staging subdomain first                                 |
| D-9  | Payment provider (only if the pilot charges)                                                               | Decide before stage 7                                               |
| D-10 | Engineering items: `psql` in an ops image (Dockerfile), B6 purge function (migration), key versioning (P9) | Approve the first two before stage 3                                |
| D-11 | Custodians for master, owner, grant credentials and key escrow (≥ 2)                                       | —                                                                   |
| D-12 | Monthly budget ceiling (§ 4: ≈ USD 322–359 for staging + production + SaaS)                                | Your figure; whatever is chosen, an AWS Budgets alarm at 80 % of it |

## 11. Risks and priorities

| Risk                                                                                     | Priority | Mitigation                                                           |
| ---------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| Vendor facts (other than AWS prices) not read on live pages (proxy blocked)              | P0       | Re-read every linked page before D-2/D-12                            |
| Saudi data-residency requirement unknown                                                 | P0       | D-1 before any provisioning; KSA hosting options not researched here |
| Role model behaviour on RDS (`rds_superuser`, ownership transfer) unproven               | P0       | Stage 3 rehearsal on staging; abort the cutover on any failed check  |
| `psql`/`pg_dump` not in the job image                                                    | P0       | D-10 engineering item                                                |
| AWS operating complexity (IAM, networking) causes misconfiguration                       | P1       | IaC with review; staging first; least-privilege task roles           |
| No key versioning (rotation resets MFA / integrations)                                   | P1       | Escrow; incident-only rotation; P9 before scale                      |
| B6 TOTP-replay via grant role DELETE                                                     | P1       | Purge function + revoke DELETE (§ 6.7)                               |
| Third-party data outside the region (Sentry, Resend, monitor)                            | P1       | D-1; scrub events; EU regions where offered                          |
| Meta integrations never run against real Meta                                            | P1       | Stage 5 supervised test with kill switches and minimum spend         |
| Cost estimate misses usage-driven items (NAT, backup copies, transfer spikes, AI, media) | P1       | D-12 budget alarm; review the first two invoices against § 4         |

## 12. Execution plan (after approval)

1. Approve D-1 … D-12 (at least D-1, D-2, D-6, D-10, D-11 to start).
2. Engineering PR (no infrastructure): ops image with PostgreSQL 16 client; B6 purge
   function + role-script change + test. Normal review and CI.
3. IaC for staging (network, ALB, ECS services/tasks, RDS, Secrets Manager entries without
   values, scheduler, log groups, alarms, backup account bucket) — reviewed, then applied.
4. Stages 1–6 of § 9 in staging, each recorded.
5. Production stack from the same IaC; stages 2–3 and 6 repeated on production; then
   stage 7.

## 13. Sources (official, checked 2026-10-13; search excerpts except the AWS Price List — see the note at the top)

Vercel: https://vercel.com/docs/cron-jobs/usage-and-pricing ·
https://vercel.com/docs/cron-jobs/manage-cron-jobs ·
https://vercel.com/docs/functions/configuring-functions/duration ·
https://vercel.com/docs/functions/configuring-functions/region ·
https://vercel.com/changelog/introducing-the-dubai-vercel-region-dxb1 ·
https://vercel.com/docs/functions/limitations ·
https://vercel.com/docs/logs/runtime ·
https://vercel.com/docs/environment-variables/sensitive-environment-variables ·
https://vercel.com/pricing

Neon: https://neon.com/docs/introduction/regions ·
https://neon.com/docs/introduction/plans ·
https://neon.com/docs/manage/roles ·
https://neon.com/docs/manage/database-access ·
https://neon.com/docs/postgresql/postgres-version-support ·
https://neon.com/docs/manage/backup-pg-dump

Supabase: https://supabase.com/docs/guides/platform/backups ·
https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery ·
https://supabase.com/docs/guides/database/postgres/roles-superuser ·
https://supabase.com/docs/guides/platform/ssl-enforcement ·
https://supabase.com/docs/guides/platform/regions

Render: https://render.com/docs/regions · https://render.com/docs/cronjobs ·
https://render.com/docs/postgresql-backups ·
https://render.com/docs/postgresql-credentials · https://render.com/docs/logging ·
https://render.com/pricing

DigitalOcean: https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/ ·
https://docs.digitalocean.com/platform/regional-availability/ ·
https://docs.digitalocean.com/products/databases/postgresql/details/limits/ ·
https://docs.digitalocean.com/products/databases/postgresql/how-to/modify-user-privileges/ ·
https://docs.digitalocean.com/products/databases/postgresql/details/pricing/

Railway / Fly.io: https://docs.railway.com/deployments/regions ·
https://fly.io/docs/machines/guides-examples/machine-placement/

AWS prices (fetched directly 2026-10-13): https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonRDS,AmazonECS,AWSELB,AmazonVPC,AmazonCloudWatch,AmazonS3,AWSSecretsManager,AWSDataTransfer}/current/me-central-1/index.json

AWS: https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html ·
https://aws.amazon.com/about-aws/global-infrastructure/regions_az/ ·
https://press.aboutamazon.com/2024/3/aws-to-launch-an-infrastructure-region-in-the-kingdom-of-saudi-arabia ·
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate-Regions.html ·
https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html ·
https://docs.aws.amazon.com/general/latest/gr/eventbridgescheduler.html ·
https://aws.amazon.com/rds/postgresql/ ·
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html ·
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html ·
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.MasterAccounts.html ·
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html ·
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html ·
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReplicateBackups.html ·
https://docs.aws.amazon.com/aws-backup/latest/devguide/backup-feature-availability.html ·
https://aws.amazon.com/fargate/pricing/ · https://aws.amazon.com/secrets-manager/pricing/ ·
https://aws.amazon.com/rds/postgresql/pricing/

Monitoring and email: https://healthchecks.io/pricing/ ·
https://betterstack.com/docs/uptime/api/create-a-new-monitor/ ·
https://betterstack.com/pricing · https://sentry.io/pricing/ ·
https://docs.sentry.io/organization/data-storage-location/ ·
https://resend.com/docs/dashboard/domains/regions · https://resend.com/pricing

## 14. Not done

No provider account, resource, role, secret, domain, scheduler, monitor or alert
destination was created; no deployment, migration or persistent-database connection; no
job run, test alert, email or message; no application, migration, Dockerfile, role-script
or runtime configuration change; no paid service contacted (only AWS's free, public Price
List API was read); `PHASE_D_READINESS_ASSESSMENT.md`, `.env`, `AGENTS.md` and
`.phase-status.json` untouched; nothing staged, committed or pushed.

## 15. Final decision review (2026-10-13)

Review of this document before any execution. Evidence levels as in the top note: AWS
prices from the Price List API (read directly); AWS documentation, laws and SaaS facts from
search excerpts of official pages (pages not opened — the proxy blocked them); code facts
from this repository.

### 15.1 Costs — what was rechecked and changed

- Every line of § 4 recalculated. Corrections: added ECR storage, two customer-managed KMS
  keys ($1 each, list), Secrets Manager API calls, cross-AZ traffic ($0.01/GB, list), a
  realistic backup bucket (≈ 100 GB of dumps), public IPv4 hours of the short-lived tick
  tasks; data transfer priced at $0.117/GB (the price list shows $0.11 in its price field
  and $0.117 in its description for the first 10 TB — the higher is used).
- **No double counting:** staging, production and shared SaaS are three disjoint blocks.
  The previous totals (93 / 176 / 315–352) were too low by ≈ $1 / $6 / $7; the revised
  totals are **≈ $94 / ≈ $182 / ≈ $322–359**.
- **EventBridge Scheduler:** first 14 million scheduled invocations per month free in
  `me-central-1` (list); the tick uses ≈ 8,800 → $0.
- **RDS Multi-AZ:** exactly 2 × Single-AZ for both instance hours and gp3 storage (list).
- **Backup storage:** RDS backup storage is free up to 100 % of provisioned storage per
  Region (FAQ, search excerpt); above it $0.1045/GB-month (list). Cross-account copies:
  AWS Backup bills transfer to the sending account and storage to the receiving account
  (pricing page, search excerpt); no RDS-specific line in the regional price list, so the
  optional copy is an estimate and excluded from the total.
- **Data transfer:** AWS describes a 100 GB/month free tier for internet egress aggregated
  across services and Regions (search excerpt); it would make the egress lines ≈ $0 but is
  ignored in the estimate.
- **Assumptions that move the result most:** tick run length (1 vs 2 min doubles that line),
  RDS CPU credits if the burstable instance runs above baseline, Multi-AZ, number of web
  tasks, log volume, NAT gateway if the network design changes (not priced).
- SaaS prices remain search excerpts (Sentry, Resend, Better Stack) and must be re-read.

### 15.2 Fitness of AWS

**Roles on RDS for PostgreSQL** (AWS docs, search excerpts):

- Documented: the master user is created `NOSUPERUSER … CREATEDB CREATEROLE`, is granted
  `rds_superuser` at setup; `rds_superuser` has no SUPERUSER/REPLICATION/BYPASSRLS
  attribute; only the AWS-managed `rdsadmin` has them; the master-user privilege list
  includes `ALTER <object> OWNER`; `rds.force_ssl` defaults to on from PostgreSQL 15.
- **Not stated on an AWS page:** `ALTER DEFAULT PRIVILEGES FOR ROLE`, column-level GRANT,
  SECURITY DEFINER functions, and ownership transfer to a role the caller is not a member
  of. Standard PostgreSQL rules apply (the caller must be a member of the target owner
  role; the master user can obtain that through CREATEROLE), but this is **proven only
  by the staging rehearsal**.
- **Gap found in the role script (no change made):** `db-roles.sql` refuses an app/grant
  role that can reach a role with the SUPERUSER attribute; `rds_superuser` does not have
  it, and predefined roles (`pg_read_all_data`, `pg_write_all_data`, `pg_monitor`,
  `pg_signal_backend` …) are not checked either. Staging check to add by hand, expected
  `false` for each pair:
  `SELECT r, g, pg_has_role(r, g, 'MEMBER') FROM unnest(ARRAY['flexibx_app','flexibx_admin_grant']) r, unnest(ARRAY['rds_superuser','pg_read_all_data','pg_write_all_data','pg_monitor','pg_signal_backend','rds_password','rds_replication']) g;`
  Extending the script's own check is an engineering item (needs approval).

**Scheduler — one run, no unintended duplicates:**

- EventBridge Scheduler delivers **at least once** (duplicates possible); retries use
  exponential backoff bounded by `MaximumRetryAttempts` (0–185) and
  `MaximumEventAgeInSeconds` (60–86,400); a standard SQS dead-letter queue receives
  events whose retries are exhausted; ECS RunTask with Fargate is a supported templated
  target (search excerpts). No AWS page describes a built-in guard against two ECS tasks
  of the same schedule running at once — assume there is none.
- Therefore safety rests on the code: the tick claims slots by compare-and-set and tasks
  by lease (`LEASE_MARGIN_MS` 60 s in `engine.ts`); retention takes a run lock. Duplicate
  ticks are designed to be harmless; this must be observed in staging (two ticks started
  together, then one killed mid-run).
- Settings to use: rate 5 minutes, flexible time window **off**,
  `MaximumRetryAttempts` 1 and `MaximumEventAgeInSeconds` 120 (a retry never lands on the
  next slot), dead-letter queue with an alarm, ECS `clientToken` not relied upon.
- **Bounded run time:** the tick CLI (`scripts/automation/tick.ts`) has no overall deadline,
  and ECS has no maximum task runtime, so a hung tick would keep running while new ones
  start. Wrap the task command in a timeout shorter than the interval (e.g. coreutils
  `timeout 240`, available in Debian-based Node images — to be checked in the chosen
  image) and alarm on a tick task running longer than 4 minutes. A single-run database
  advisory lock in the tick would be a stronger guarantee (code change, optional).

**Access to `/api/internal/ops-status` without exposing the secret:**

- Code (verified): bearer token compared in constant time (`timingSafeEqual` on digests,
  `retention-trigger-auth.ts`); missing/wrong token → 404; unset secret → 404; response
  has check names and counts only, `cache-control: no-store`; logs pass through
  `redactSecrets`. The rate limiter runs **after** authorization, so wrong-token attempts
  are not limited by this route — acceptable with a ≥ 32-byte random secret.
- Requirements: a dedicated `OPS_STATUS_SECRET` (not shared with the cron secrets), stored
  only in Secrets Manager and in the monitor's header configuration (vendor UI access
  limited to on-call); monitor configured with the **https** URL only; HTTP→HTTPS redirect
  on the load balancer; no request-header logging added anywhere (whether ALB access logs
  can contain the `Authorization` header is unverified — the documented fields do not
  include it); a staging grep of logs for the secret value (D3 item 8); rotation as in
  § 8. Optional: restrict `/api/internal/*` to the monitor's published source IPs at the
  load balancer.

**UAE region and data protection (not legal advice):**

- Hosting in `me-central-1` places the database in the UAE; it does **not** by itself make
  Flexibx compliant with any law.
- UAE Federal Decree-Law 45/2021 (PDPL): cross-border transfers governed by Articles 22–23
  (adequacy, or exceptions such as contract or explicit consent); whether its Executive
  Regulations have been issued could not be confirmed.
- Saudi PDPL and SDAIA's Regulation on Personal Data Transfer outside the Kingdom: transfers
  of Saudi residents' data outside the Kingdom — **including to the UAE** — need adequacy or
  safeguards (standard contractual clauses, binding common rules, certification), a risk
  assessment and minimisation. NCA's Essential Cybersecurity Controls require hosting
  inside the Kingdom for government bodies and critical national infrastructure; the
  Cloud Cybersecurity Controls 2024 data-localisation clause was not confirmed.
- Independently of the region, personal data reaches processors elsewhere: Resend (account
  data and email metadata stored in the US), Sentry (US or EU), OpenAI, Meta, the uptime
  monitor. These are cross-border transfers to document.
- Required: a legal opinion covering target customers (Saudi/UAE/other; private vs
  government), a record of processors and transfer mechanisms, and privacy-policy wording
  — before stage 1, because the database region cannot be changed later without a
  migration.

### 15.3 Security risks

**TOTP replay through the grant role (B6) — proposed design, not implemented.**

Today (`src/server/auth/totp-replay.ts`): a claim first deletes the user's **expired** rows
(`expires_at < now`, application clock), then `INSERT … ON CONFLICT` with a 3-minute TTL;
exactly one concurrent claim wins. `db-roles.sql` grants the grant role
`SELECT, INSERT, DELETE` on the table, and the runtime role has table-level DELETE too;
the WHERE clause is only in application code, so either credential can delete
**unexpired** claims and make a code accepted again within its window.

Proposal:

1. Migration: `public.two_factor_claim_code(p_user uuid, p_code_hash char(64))`,
   `SECURITY DEFINER`, owned by the owner role, `SET search_path = pg_catalog, public`,
   `REVOKE ALL … FROM PUBLIC`. In one transaction it deletes that user's rows with
   `expires_at < now()` (database clock) and inserts the claim with a fixed TTL longer than
   the acceptance window (keep 3 minutes), returning whether the insert won.
2. `db-roles.sql`: `GRANT EXECUTE` on it to the runtime and grant roles; revoke `INSERT`
   and `DELETE` on `two_factor_used_codes` from both (keep `SELECT` only if needed).
   Cascading deletes from `users` keep working (referential actions run with the table
   owner's rights — to be confirmed by a test).
3. Code: `claimTotpCode` calls the function instead of the two statements.
4. Tests (disposable roles): grant and runtime roles refused on direct DELETE/INSERT; the
   function removes only expired rows and only for that user; concurrent claims → one
   winner; replay refused; user deletion still cascades; mutation checks (function with
   `<=`, grant re-added).
5. Residual: the owner and master credentials can still delete rows (trusted; inherent).
   The separate accepted risk remains that a grant-credential holder can grant without a
   TOTP code.

**Rotating `AUTH_SECRET` and `ENCRYPTION_KEY`** (no key versioning today):

- `AUTH_SECRET`: all sessions and pending verification/reset links end; all two-factor
  secrets and backup codes become undecryptable → every enrolled user (all administrators)
  must be reset with `admin:mfa-reset` and re-enroll; platform-admin flags are cleared and
  must be re-granted through the grant role.
- `ENCRYPTION_KEY`: all stored Meta/WhatsApp/ads/social tokens become unreadable → every
  workspace reconnects.
- Until key versioning (P9): rotate only for a suspected compromise, as an incident.

**Recovery requirements (accounts, keys, backups):**

- A database backup is only usable with the `AUTH_SECRET` and `ENCRYPTION_KEY` that were
  current when it was taken. Keep **every** retired key value, dated, in escrow (two
  custodians, separate from the backups) for at least the longest backup retention (12
  months in `BACKUP_RESTORE.md`). Do not rely on Secrets Manager version history for this.
- Restore drills must prove decryption, not only row counts: on the restored staging copy,
  sign in with TOTP and with a backup code, and read one stored integration token.
- Account recovery: a user who loses their authenticator uses a backup code; otherwise an
  operator runs `admin:mfa-reset` after identity verification (`ADMIN_PROVISIONING.md`).
  Administrators then re-enroll and are re-granted with the grant credential.
- Break-glass: if the grant credential is lost, the owner (which owns the functions) can
  call them; if every administrator is locked out, the same path applies. The master user
  is reserved for role recovery. Each of these credentials needs two named custodians.

### 15.4 Decisions

**Block the move to staging** (nothing is assumed approved — not AWS, not a budget):

1. **Data protection position (D-1):** where customers are (Saudi/UAE/other, private or
   government) and whether a UAE-hosted database plus the listed foreign processors is
   acceptable — with legal advice.
2. **Hosting provider and region (D-2):** AWS `me-central-1` as recommended, or another.
3. **Staging budget:** ≈ $94/month for AWS staging (§ 4) plus whichever SaaS you want in
   staging; a ceiling and who receives the billing alarm.
4. **Accounts and custodians (D-11):** owner of the AWS organization/accounts (production,
   staging, backup), and at least two named custodians for the master, owner, grant and
   key-escrow credentials.
5. **Infrastructure-as-code tool and reviewer (D-6).**
6. **Engineering items (D-10):** PostgreSQL client in an ops image (needed for stages 2–3);
   whether to implement the B6 design (§ 15.3) before stage 3 or accept it for staging.

**Can wait** (each before the stage named):

| Decision                                                                                        | Needed before                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------- |
| Resend plan and sending domain/subdomain (D-8)                                                  | Stage 4 (auth flows)              |
| Uptime monitor, Sentry region, alert destination, on-call (D-5, D-7)                            | Stage 6 (monitoring drill)        |
| Which Meta features launch first (permissions to request)                                       | Stage 5                           |
| Production database size, Multi-AZ, PITR retention (D-3), backup retention (D-4)                | Production stack                  |
| Production budget (≈ $182 + SaaS, § 4)                                                          | Production stack                  |
| Payment provider (D-9)                                                                          | Charging any customer             |
| Key versioning (P9), role-script check for `rds_superuser`/predefined roles, tick advisory lock | Scale / before production cutover |

### 15.5 Final recommendation (conditional)

Proceed with **AWS `me-central-1`** (ECS Fargate, RDS PostgreSQL 16, EventBridge Scheduler,
Secrets Manager, separate backup account) **only if**:

1. the legal review accepts a UAE-hosted database for the target customers (if Saudi
   government/critical-infrastructure customers or a Saudi-only residency requirement
   apply, this recommendation does not hold and in-Kingdom hosting must be researched);
2. the staging rehearsal proves the role model on RDS, including the membership check of
   § 15.2;
3. the tick runs bounded (timeout + alarm) and a duplicated tick is shown harmless in
   staging;
4. a restore drill proves decryption with the escrowed keys;
5. you approve a budget at or above the revised estimate.

Corrected monthly estimate: **staging ≈ USD 94, initial production ≈ USD 182, shared SaaS
≈ USD 46–83, total ≈ USD 322–359**, excluding tax, AI usage, media, ad spend and the
optional backup copies.

### 15.6 Changes made to this document in the review

1. § 1: recommendation marked conditional; cost summary updated to the revised totals.
2. § 4: rewritten — assumptions table, line-by-line staging and production tables with
   price source per line, added ECR, KMS, Secrets Manager calls, cross-AZ traffic,
   EventBridge Scheduler, larger backup bucket; data transfer at $0.117/GB; totals
   corrected (staging 93 → 94, production 176 → 182, total 315–352 → 322–359).
3. § 6.2: AWS Backup copy made optional with its cross-Region/cross-account limitation.
4. § 6.6: replaced with the RDS evidence summary and the `db-roles.sql` membership gap.
5. § 6.7: replaced with a pointer to the fuller B6 design in § 15.3 (the earlier purge-only
   function left the runtime role's DELETE in place).
6. § 7: at-least-once delivery, no ECS single-run guarantee, dead-letter queue alarm.
7. § 8: `AUTH_SECRET`/`ENCRYPTION_KEY` — retain retired keys for the backup retention.
8. § 10: D-12 no longer proposes a budget figure; pointer to § 15.4.
9. § 15 added.
