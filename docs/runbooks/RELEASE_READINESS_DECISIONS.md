# Release readiness decisions (Pass 16, 2026-10-19; status updated Passes 17–24, 2026-10-20)

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
| R-9 | OS package patch policy for images | **Done in code (Pass 17):** security upgrades at build + Trivy in CI                    | — (owner: confirm the policy)         |

## Status of every open item (Pass 24, 2026-10-20)

`FIXED` = repaired and the repair proven by a test or a scan; `ACCEPTED` = a risk the
owner accepted explicitly (none yet: no owner decision has been recorded); `BLOCKED` =
waits on an owner decision, an account or a permission; `OPEN` = still needs work.
Writing a document about an item never makes it `FIXED`.

| Item                                                       | Where                  | Severity       | Status      | Evidence / what is needed                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ---------------------- | -------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions gets no runner (R-1)                        | CI                     | —              | **BLOCKED** | Runs #43–#67: four jobs each, 0 billable ms, `runner_id` 0 (#67 on 26ccada). Owner: CI_STATUS.md one-page note at the top                                                                                                                                                           |
| AWS account and region (R-2)                               | hosting                | —              | **BLOCKED** | Owner; D-1 (residency)                                                                                                                                                                                                                                                              |
| Cost approval (R-3)                                        | hosting                | —              | **BLOCKED** | Owner                                                                                                                                                                                                                                                                               |
| Staging secrets channel (R-4)                              | hosting                | —              | **BLOCKED** | Owner                                                                                                                                                                                                                                                                               |
| Hosted staging                                             | hosting                | —              | **BLOCKED** | Needs R-2, R-3, R-4; nothing created                                                                                                                                                                                                                                                |
| PITR exercised on the provider (R-8)                       | RDS                    | —              | **BLOCKED** | Configured in Terraform only; never tested (no hosted database)                                                                                                                                                                                                                     |
| Alert destination, log shipping and RDS alarms (R-7)       | operations             | —              | **BLOCKED** | Owner; paid resources                                                                                                                                                                                                                                                               |
| `deepmerge-ts` 7.1.5 (CVE-2026-40345)                      | ops image (Prisma CLI) | HIGH           | **OPEN**    | Pass 19: an ops image built with Prisma 7.10.1 scans clean with **no** exception (8.0.2 inside); applied with R-5 on/after 2026-10-22; exception expires 2026-10-29                                                                                                                 |
| `mysql2` 3.15.3 (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3) | ops image (Prisma CLI) | HIGH, MEDIUM   | **OPEN**    | Same upgrade (3.24.4 inside the Pass 19 rehearsal image, no finding); never used (PostgreSQL only)                                                                                                                                                                                  |
| `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm)                       | lint tooling, no image | HIGH           | **OPEN**    | No fixed release exists (`pnpm audit` re-run in Pass 19: patched versions `<0.0.0`); next review with the Prisma upgrade on 2026-10-22                                                                                                                                              |
| `http-cache-semantics` 4.2.0 (GHSA-ch52-4w7c-c8xp)         | worker and ops (pnpm)  | HIGH           | **FIXED**   | pnpm 10.34.7 bundles 4.3.0 (fixed); Pass 18 scan: gone. Pass 17's "no fix" was wrong: Trivy's database listed no fixed version, the advisory names 4.3.0                                                                                                                            |
| Ubuntu packages without HIGH/CRITICAL                      | app / worker / ops     | MEDIUM, LOW    | **OPEN**    | Pass 19 images of 3e41054 (Trivy DB updated 2026-10-20 07:17 UTC): app 21/4, worker 637/28, ops 23/4 (MEDIUM/LOW); not gated; updates at every build                                                                                                                                |
| Debian and npm findings of the Pass 16 app image           | app image              | CRITICAL, HIGH | **FIXED**   | Pass 17: app on Ubuntu with `node` only; scans since: 0 HIGH/CRITICAL                                                                                                                                                                                                               |
| pnpm 10.28.0 advisories                                    | worker, ops            | HIGH           | **FIXED**   | pnpm 10.34.7; scan                                                                                                                                                                                                                                                                  |
| OS patch policy (R-9)                                      | images                 | —              | **OPEN**    | Implemented (security updates at build + scan in CI); the owner has not confirmed the reproducibility trade-off                                                                                                                                                                     |
| Prisma 7.10.1 upgrade (R-5)                                | dependencies           | —              | **OPEN**    | Rehearsed again in Pass 19 (see below); the 2026-10-22 gate is not reached (checked 2026-10-20 10:08 UTC); not adopted                                                                                                                                                              |
| Terraform provider checksums                               | `deploy/staging/aws`   | —              | **FIXED**   | `.terraform.lock.hcl` from the GPG-verified SHA256SUMS; an altered hash makes `terraform init` fail                                                                                                                                                                                 |
| Restore drill blind spots (non-empty target, row counts)   | `restore-drill.sh`     | —              | **FIXED**   | Pass 18 mutation test: two defects went undetected; drill extended; 13/13 mutants now killed                                                                                                                                                                                        |
| Storage user's access key rotation                         | IAM                    | —              | **OPEN**    | Manual rotation, or move the app to the host role; owner decision                                                                                                                                                                                                                   |
| Static FFmpeg build (R-6)                                  | worker image           | —              | **OPEN**    | Recommendation: keep Ubuntu's FFmpeg; awaits the owner's confirmation                                                                                                                                                                                                               |
| Trivy image signature                                      | supply chain           | —              | **OPEN**    | Digest identical on Docker Hub and ghcr.io; cosign verification impossible here (sigstore unreachable) — to do where it is reachable                                                                                                                                                |
| Release push without verification, or of a dirty tree      | `scripts/release`      | —              | **FIXED**   | Pass 19: SHA tag must be HEAD, `--push` refuses a dirty tree; `test-release-guards.sh` (CI) proves nothing is pushed after a failed check; 8/8 mutants                                                                                                                              |
| Random Next.js build ID per build                          | app image              | —              | **FIXED**   | Pass 19: build ID = the commit; app differences between two builds 212 → 194                                                                                                                                                                                                        |
| Builds not byte-reproducible                               | images                 | —              | **OPEN**    | Remaining: per-build Server Action key and preview keys (secrets), trace-list order, pnpm's `.modules.yaml` timestamp (RELEASE_PIPELINE.md § 4)                                                                                                                                     |
| Pass 19's first E2E run (33 of 43 failed)                  | local gate script      | —              | **FIXED**   | Pass 20: reproduced exactly (33 failed / 10 passed): the local script left the shell in `deploy/staging/aws`, so the E2E database was never migrated (`rate_limits` missing). Not an app defect. `e2e/global-setup.ts` now stops a run on an unmigrated database (tested both ways) |
| Hosted-staging preflight                                   | `scripts/release`      | —              | **FIXED**   | Pass 20: `staging-preflight.sh` (no AWS call) and its test in CI, 6/6 mutants killed; STAGING_LAUNCH.md                                                                                                                                                                             |
| Env file on the host from Secrets Manager                  | `scripts/ops`, host    | —              | **FIXED**   | Pass 22: the host had no AWS CLI, so its role could not be used to read the env secret; user-data installs it (asserted in tftest); `render-staging-env.sh` validates and writes it (14 checks, 11/11 mutants)                                                                      |
| Host AWS CLI version not pinned (snap)                     | host (user-data)       | —              | **OPEN**    | Pinned alternative tested (Pass 23); Pass 24: its provenance is not established — `verify-aws-cli-signature.sh` refuses the only reachable key copy (expired 2026-07-07); needs the current key from AWS's documentation, then owner decision R-9                                   |
| Preflight accepted a reserved domain (`.test`)             | `scripts/release`      | —              | **FIXED**   | Pass 23: `.test/.example/.invalid/.localhost/.local` refused; 4 new checks; mutant killed                                                                                                                                                                                           |

## Status on 2026-10-20 (Pass 24)

Checked 2026-10-20 21:34 UTC: the Prisma gate (2026-10-22) is **still not reached**, so
7.10.1 is **not applied** and both exceptions stay (expire 2026-10-29; escalate
2026-10-28; never extended). No owner decision recorded: R-1, R-2, R-3, R-4, R-7, R-8
**BLOCKED**; R-5, R-6, R-9 **OPEN**; nothing `ACCEPTED`. AWS credentials **not used**.

**Rehearsal of the upgrade (detached worktree, separate databases; not on the branch):**
the committed patch applied to `88f3929` gives Prisma 7.10.1 with `deepmerge-ts` 8.0.2
and `mysql2` 3.24.4. validate, typecheck, lint, 1135 unit, migrate + status, drift
(migrated database vs schema: empty), 923 integration, drill PASSED, mutants 13/13,
build, 43 E2E — all pass. A database migrated by 7.10.0 and one by 7.10.1 have
**identical** schema dumps (7881 lines) and identical migration names + checksums (37).
Images built from the rehearsal commit (`697fcdd`, local only) with the exception file
**empty**: Trivy (DB 2026-10-20 07:17 UTC, newest) 0 fixable HIGH/CRITICAL and **no Node
finding in any image** (ops' 1 Node MEDIUM gone too); OS MEDIUM/LOW unchanged (app 21/4,
worker 637/28, ops 23/4, Ubuntu packages without fixes). Local stack on those images:
`STAGING CHECK PASSED` 34 / 0 / 0, `VERIFIED` restore (77 / 502 / 37). So both
exceptions can go with the upgrade: the exact change is
`docs/runbooks/patches/prisma-7.10.1-remove-exceptions.patch` (R-5 procedure).
Rehearsal mistakes kept on record: a test database not named `*_test` was refused by the
integration guard (re-run on a `_test` database: 923 passed), and a migrations-to-schema
diff needs a shadow database the config does not define (replaced by the dump comparison).

**AWS CLI (R-9):** `scripts/ops/verify-aws-cli-signature.sh` refuses an expired or revoked
key (gpg alone accepts an expired one); on the real 2.38.2 file with the keyserver copy of
the AWS key it **refuses** — the 2.38.2 pin is therefore unproven until rechecked with the
key from AWS's documentation (unreachable here). The keyserver shows AWS extending the key
every July (2023, 2024, 2025 self-signatures); the July 2026 extension is not on it.
**No decision:** snap stays in user-data.

## Status on 2026-10-20 (Pass 23)

Checked 2026-10-20 18:40 UTC: the Prisma gate (2026-10-22) is **still not reached**; not
applied; the committed patch applies to `72565fc`. Exceptions unchanged (expire
2026-10-29; escalate 2026-10-28; never extended). No owner decision recorded: R-1, R-2,
R-3, R-4, R-7, R-8 **BLOCKED**; R-5, R-6, R-9 **OPEN**; nothing `ACCEPTED`. The AWS
credentials in the session environment were **not used** (no call of any kind).

**New evidence:** R-9 extended to the host's tools (see R-9, "Pass 23"): the snap AWS CLI
is unpinned; a pinned, tested alternative exists and awaits the owner's choice. The
preflight accepted `staging.flexibx.test`; reserved names are now refused. Release
candidate **`72565fc`** built and verified (label, contents, sizes 389 / 1229 / 1089 MB,
ops self-check, media tools; Trivy database of 2026-10-20 07:17 UTC, the newest
published: 0 fixable HIGH/CRITICAL; OS MEDIUM/LOW app 21/4, worker 637/28, ops 23/4; ops 1
Node MEDIUM); staging gate `PASSED` 34 / 0 / 0 on the local stack (not hosted); backup,
refused restore over the source, `VERIFIED` restore (77 tables, 502 objects, 37
migrations). CI runs #68 and #69 again without a runner.

## Status on 2026-10-20 (Pass 22)

Checked 2026-10-20 16:40 UTC: the Prisma gate (2026-10-22) is **still not reached**; not
applied; the committed patch applies to HEAD. The exception timeline of Pass 21 stands
(upgrade from 10-22, escalate on 10-28, expiry 10-29). No owner decision recorded:
R-1, R-2, R-3, R-4, R-7, R-8 **BLOCKED**; R-5, R-6, R-9 **OPEN**; nothing `ACCEPTED`.
The AWS credentials in the session environment were again **not used** (no read call
either).

**New evidence:** a gap in the launch package found and closed — the host's role may
read the env secret, but the host had no AWS CLI (Ubuntu 24.04 ships no `awscli`
package), so STAGING_LAUNCH.md § 5 step 1 had no tool. user-data now installs it;
`scripts/ops/render-staging-env.sh` writes `staging.env` from the secret only when it is
complete and real. Release candidate **`26ccada`** built and verified (label, contents,
sizes 389 / 1229 / 1089 MB, ops self-check, media tools; Trivy database of 2026-10-20
07:17 UTC: 0 fixable HIGH/CRITICAL); staging gate `PASSED` 34 / 0 / 0 on the local stack
(not hosted); backup and `VERIFIED` restore; CI runs #66 and #67 again without a runner.

## Status on 2026-10-20 (Pass 21)

Checked 2026-10-20 13:11 UTC: the Prisma gate (2026-10-22) is **still not reached**; the
upgrade was not applied (the committed patch still applies cleanly to HEAD). No owner
decision recorded: R-1, R-2, R-3, R-4, R-7, R-8 **BLOCKED**; R-5, R-6, R-9 **OPEN**;
nothing `ACCEPTED`.

**Exception timeline (escalation rule):**

| Date       | What must happen                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------- |
| 2026-10-22 | earliest date for the Prisma 7.10.1 upgrade (procedure in R-5 below)                            |
| 2026-10-22 | the scan starts printing "expires in 7 day(s)" warnings (a CI annotation once CI runs; Pass 21) |
| 2026-10-28 | **escalate to the owner** if the upgrade is not merged by then                                  |
| 2026-10-29 | both exceptions expire: the image scan fails on `deepmerge-ts` / `mysql2` again (by design)     |

Extending an exception is not a remedy. If 7.10.1 fails its gates, the options are
R-5 (b), waiting for 7.10.2, or a red image gate for the ops image until a fix exists;
either one needs the owner's explicit, recorded decision.

**AWS credentials in the development environment:** this session's environment carries
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (names seen, values never printed). They were
**not used** — not even for `sts get-caller-identity`: nothing says whose account they
are or that the owner approved using it for staging (approval 1 of STAGING_LAUNCH.md).
The owner must say whether they belong to the staging account before any AWS call.

**New evidence:** release images built from `c8f2218` passed every check (label,
contents, sizes 389 / 1229 / 1089 MB, ops self-check, media tools, Trivy: 0 fixable
HIGH/CRITICAL); the staging gate on them `PASSED` 34 / 0 / 0 on the local stack (not
hosted); the preflight passed with the AWS variables removed from its environment and
rejected `terraform.tfvars.example`; CI run #64 again had no runner.

## Status on 2026-10-20 (Pass 20)

Checked 2026-10-20 12:13 UTC: the Prisma gate (2026-10-22) is **not reached**, so the
upgrade was not applied and both exceptions stay (they expire 2026-10-29). Still no owner
decision: R-1, R-2, R-3, R-4, R-7, R-8 **BLOCKED**; R-5, R-6, R-9 **OPEN**; nothing
`ACCEPTED`. New evidence only:

- **R-1:** run #63 (f7dfef6) like every run since #43 (four jobs, `runner_id` 0, 0 ms).
  Repository causes ruled out once more: the workflow parses, is `active`, uses no
  `environment`, no job-level `if`, `permissions: contents: read`; its `concurrency`
  can only cancel a superseded run (result `cancelled`, not `failure`).
- **R-5:** the upgrade patch is now in the repository with the exact procedure,
  acceptance and rollback (above), so it no longer depends on a scratch copy.
- **R-2/R-3/R-4:** the launch is prepared, not started: `scripts/release/staging-preflight.sh`
  (passes on this repository with a filled-in variables file; refuses the example) and
  docs/runbooks/STAGING_LAUNCH.md (owner inputs, approvals 1–3, stop conditions,
  rollback, acceptance A1–A10, RTO table to fill in).

## Status on 2026-10-20 (Pass 19)

No owner decision was recorded since Pass 16 (no commit, setting, message or approval in
this repository), so **no item is `ACCEPTED`**. Decisions R-1 to R-9:

| #   | Status      | Why                                                                                                                  |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| R-1 | **BLOCKED** | Run #62 (3e41054): four jobs, `runner_id` 0, 0 billable ms, logs 404. Account-level; owner steps in CI_STATUS.md § 2 |
| R-2 | **BLOCKED** | No AWS account or region chosen (D-1 residency open); `terraform plan` against AWS impossible                        |
| R-3 | **BLOCKED** | No cost approval; no budget alarm                                                                                    |
| R-4 | **BLOCKED** | No secrets channel; no staging secret exists anywhere                                                                |
| R-5 | **OPEN**    | Dated gate 2026-10-22 not reached; rehearsal passed again (below); not adopted                                       |
| R-6 | **OPEN**    | Recommendation (keep Ubuntu's FFmpeg 6.1) awaits the owner's confirmation; blocks nothing                            |
| R-7 | **BLOCKED** | No alert destination or log retention chosen (paid resources)                                                        |
| R-8 | **BLOCKED** | PITR configured in Terraform only; no hosted database to exercise it                                                 |
| R-9 | **OPEN**    | Implemented in code (security updates at build + Trivy gate); the owner has not confirmed the trade-off              |

**R-5 rehearsal, Pass 19** (isolated worktree of 3e41054, never this checkout; the Pass 17
patch applied unchanged: `package.json` and `pnpm-lock.yaml` only, Prisma's three packages
7.10.0 → 7.10.1):

- npm on 2026-10-20: 7.10.1 is `latest` for `@prisma/client` and `@prisma/adapter-pg`; no
  7.10.2; `prisma`'s `latest` is still `8.0.0-rc.23` (release candidate, not used).
- `pnpm install --frozen-lockfile` passes; `pnpm audit`: only `braces` remains (1 high).
- `prisma validate`, typecheck, lint, 1135 unit tests: pass. Integration: 923 of 923 (59 files)
  with the dedicated superuser test role the main gates use. (Three earlier runs are
  not counted: one hit a full disk during a parallel image build, PostgreSQL error 53100;
  two used a non-superuser role, where the same 3 tests fail identically on 7.10.0 — they
  write `pg_index` / `session_replication_role`, and that role's password is a substring
  of the database name.) Restore drill: PASSED; its mutation test: 13 of 13 killed.
- Migrations: 7.10.0 and 7.10.1 (schema engine `0edf323` → `d1b3f37`) each applied the 37
  migrations to a fresh database; schemas identical (`pg_dump --schema-only`, 7 881 lines,
  apart from pg_dump's random `\restrict` key), migration names and checksums identical;
  `migrate diff` against `schema.prisma`: empty both ways; 7.10.1 reports a
  7.10.0-migrated database "up to date".
- Ops image built from the rehearsal tree: self-check passes (Prisma CLI 7.10.1 offline),
  and `scan-images.sh` with an **empty** exception file finds no fixable HIGH/CRITICAL and
  no Node finding at all (`deepmerge-ts` 8.0.2, `mysql2` 3.24.4). So both exceptions in
  `.trivyignore.yaml` can be deleted in the same commit as the upgrade — not before:
  the images built from this branch still contain 7.1.5 / 3.15.3.
- An expired exception fails the gate (re-tested: both entries dated 2026-10-19 → the
  scan lists them as FIXABLE HIGH and exits 1).

**On or after 2026-10-22**, if no 7.10.2 and no regression report for 7.10.1 appeared,
apply exactly the committed patch (Pass 20: `docs/runbooks/patches/prisma-7.10.1.patch`,
`package.json` and `pnpm-lock.yaml` only; `git apply --check` passed on f7dfef6):

```bash
date -u +%F                                   # must be 2026-10-22 or later
git apply docs/runbooks/patches/prisma-7.10.1.patch
pnpm install --frozen-lockfile && pnpm audit  # expect only braces
pnpm exec prisma validate && pnpm typecheck && pnpm lint && pnpm test
pnpm test:integration && scripts/ops/restore-drill.sh && scripts/ops/restore-drill-mutants.sh
# migrations: fresh database with 7.10.0 and with 7.10.1 -> pg_dump --schema-only identical
# (apart from \restrict), _prisma_migrations names+checksums identical, migrate diff empty
git commit …                                  # the patch, not yet the exceptions
scripts/release/build-and-verify.sh <sha>     # images still pass WITH the exceptions
TRIVY_IGNOREFILE=<file with only "vulnerabilities:"> scripts/docker/scan-images.sh <images>
# only if that scan passes (Pass 24: the exact change is committed as a patch):
git apply docs/runbooks/patches/prisma-7.10.1-remove-exceptions.patch
git commit …                                  # then rebuild + verify: build-and-verify.sh <sha>
```

**Acceptance:** every command above exits 0; the scan without exceptions passes on the
rebuilt ops image. **Rollback:** `git revert` of the upgrade commit (lockfile and
`package.json` return to 7.10.0; no migration is involved, so the database needs no
change); keep the exceptions until 2026-10-29. If anything fails, keep 7.10.0 and record
why; never extend an exception to make the gate green.

### Inputs for the first AWS deploy (owner)

| Input                        | What exactly                                                                                          | Decision |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| Account and region           | A staging-only account in an AWS Organization; region from D-1 (`me-central-1` is only a placeholder) | R-2      |
| Deploy identity              | An IAM Identity Center role for Terraform; root with MFA and no access keys                           | R-2      |
| Terraform state              | A private S3 bucket with versioning (and locking) for the state                                       | R-2      |
| Cost approval                | The ≈ USD 100–130 / month staging budget, and an AWS Budget alarm (USD 150 suggested)                 | R-3      |
| Domain                       | `app_domain` and who edits its DNS (A record to the output `public_ip`)                               | R-2      |
| Secrets channel              | Owner writes the env secret into the Secrets Manager container Terraform creates                      | R-4      |
| Alert destination, logs      | One webhook relay (on-call + chat), CloudWatch log retention (30 days suggested)                      | R-7      |
| Image and dependency updates | Confirm R-9 (security updates at every build, Trivy gate, pinned bases refreshed by reviewed PR)      | R-9      |
| PITR and restore test        | Confirm 7-day PITR + daily off-host dump, and one point-in-time restore exercised before any RPO      | R-8      |
| Mail provider                | A sending domain and API key for staging mail                                                         | R-4      |
| CI                           | GitHub Actions running again (release images are verified in CI before any push)                      | R-1      |

Once R-2 and R-3 are given: `terraform plan -out staging.plan` (reviewed before anything
else), then a **separate** explicit approval for `terraform apply`; then
`FLEXIBX_REGISTRY=<ecr> scripts/release/build-and-verify.sh <sha> --push` from a clean
checkout (a separate approval for the push), then deploy/staging/aws/README.md "Launch".
None of this was run in Pass 19: no credentials, account or approval exists.

## Status on 2026-10-20 (Pass 17)

No decision was recorded by the owner since Pass 16 (no commit, setting or message; CI
run #58 on 6017891 failed like the others: four jobs, 0 billable ms). What changed in the
repository:

- **R-5 (Prisma):** the gate date (2026-10-22) is not reached; 7.10.2 does not exist and
  npm's `latest` is still `8.0.0-rc.23`. A full rehearsal of 7.10.1 passed in an isolated
  worktree (never this checkout): lockfile changes only Prisma's packages and mysql2's;
  `pnpm audit` then leaves only `braces`; generate, typecheck, lint, 1132 unit, 923
  integration tests, the restore drill and the build all pass; the migration engine
  (7.10.1's schema engine `d1b3f37`) applies the 37 migrations to a byte-identical schema
  with identical checksums, reports a 7.10.0-migrated database as up to date and finds no
  drift either way. **Ready to apply on 2026-10-22, not adopted before.**
- **R-9 (OS packages): implemented.** The app image now runs on the same Ubuntu 24.04
  base as the job images with only the `node` binary (no npm, npx, corepack), and every
  Ubuntu stage applies the archive's security updates at build (`apt-get upgrade`; the
  base stays pinned by digest, apt checks Ubuntu's signatures). Trivy (official image
  pinned by digest) scans all three images in CI and fails on a fixable HIGH/CRITICAL
  finding. Owner: confirm this policy (reproducibility trade-off: two builds of one commit
  can differ by the security updates published in between).
- **Correction to Pass 16:** its statement "app image (Debian 12): 0 pending updates" was
  wrong. Debian's archive is unreachable from the development environment, so
  `apt-get update` fetched nothing and `apt-get -s upgrade` had nothing to compare. A real
  scan (Trivy) of that image found 4 CRITICAL and 64 HIGH OS findings (perl-base with a
  fix available, among others) and 14 HIGH/CRITICAL in npm's bundled packages. All gone
  from the Pass 17 app image (0 HIGH/CRITICAL; 21 MEDIUM, 4 LOW).

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
  `gitleaks/gitleaks-action`, and (Pass 16) `hashicorp/setup-terraform`. The Pass 17 scan uses
  no new action (Trivy runs as a container pinned by digest).
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
- **Pass 17 outcome:** (b) and (c) were implemented, (a) stays (digests unchanged: the
  pinned `ubuntu:24.04` digest was still the newest on 2026-10-20). The "none pending"
  statement about the Debian app image above was wrong (see "Status on 2026-10-20"); the
  app image no longer uses Debian. A scanner was found after all: Trivy 0.76.0 from its
  official Docker Hub image through mirror.gcr.io, whose index digest equals the one Aqua
  publishes on ghcr.io (`sha256:2416d1f7…`; signature verification with cosign was not
  possible — the sigstore endpoints are unreachable here). Results on the Pass 17 images:
  app 0 HIGH/CRITICAL (21 MEDIUM, 4 LOW, OS); worker and ops 0 fixable HIGH/CRITICAL —
  one HIGH without any fix (`http-cache-semantics` inside pnpm's own bundle, used for
  registry HTTP caching, which the images never do: pnpm runs offline there) plus Ubuntu
  MEDIUM/LOW (worker: 637 MEDIUM, mostly FFmpeg's media libraries, no fixed versions);
  the two Prisma-gated advisories in ops are listed in `.trivyignore.yaml` with an expiry
  of 2026-10-29. Owner: confirm (b)'s reproducibility trade-off.
- **Pass 23, the host's tools (not the images):** the staging host gets the AWS CLI at
  first boot with `snap install aws-cli --classic` (Pass 22). That is the one tool on the
  host that is **not pinned**: the snap's version is whatever the `latest/stable` channel
  holds at boot, and snapd refreshes it on its own afterwards. Every other host package
  (`docker.io`, `caddy`, …) is also unpinned, from Ubuntu's archive with
  `unattended-upgrades`, so the snap matches the host's current policy, not the images'.
  If the owner wants host tools pinned like the images, a tested alternative exists:
  `scripts/ops/install-aws-cli-pinned.sh` installs **AWS CLI 2.38.2** from AWS's versioned
  installer only when its SHA-256 is the pinned
  `16a4d39d…76164b37` and the installed CLI reports that version (test in CI: 12 checks,
  7/7 mutants killed; the real 2.38.2 file installed into a scratch prefix reported
  `aws-cli/2.38.2`). The pinned hash was taken from a file whose GPG signature is valid
  for the AWS CLI team key `FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C`
  (`VALIDSIG`, signed 2026-10-19). Caveat: the only copy of that key reachable here
  (keyserver.ubuntu.com) is marked **expired on 2026-07-07**; AWS's own page with the
  current key was unreachable, and `gpg --verify` still exits 0 for an expired key, so
  a check at boot based on gpg's exit status alone would not catch an expired key. That is
  why the script checks a pinned hash, not the key, at install time. **Not adopted:** to switch,
  replace the `snap install` line in `user-data.sh.tftpl` with this script (plus `unzip`
  in the `apt-get install` line) and update the tftest assertion; moving to a new version
  means a new hash, verified against the current key from AWS's documentation.
  **Owner decision (R-9):** keep the snap (auto-updated, unpinned) or adopt the pin
  (reproducible, but updated only by a reviewed change).
- **Pass 24:** a pin may only be taken after `scripts/ops/verify-aws-cli-signature.sh`
  passes: valid signature, AWS CLI team key fingerprint, key **not expired or revoked**
  (test in CI: 7 checks with throwaway keys, 5/5 mutants killed). On the 2.38.2 file with
  the only reachable key copy (keyserver.ubuntu.com, last self-signature 2025-07-07,
  expired 2026-07-07) it refuses, so the pinned hash's provenance is **not established**.
  To close: download the key block from AWS's documentation page ("Install or update the
  AWS CLI" → PGP public key), run the script on the pinned file; if it passes, the owner
  chooses snap or pin; if it fails, the pin is dropped. Until then: snap (unchanged).
