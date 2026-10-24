# Release candidate consolidation — Pass 41 (2026-10-24)

**Local evidence only.** CI is blocked at the account level (no run since #80), nothing is
hosted, no AWS call, nothing pushed or merged; the official candidate is still `a463d1c`.
The consolidated candidate is the local branch `p41-rc-candidate` (linear on
`a463d1c` → `42aa713` → `p39-hardening` → `p40-launch-evidence` → Pass 41).

Index: change-by-change review → `RC_REVIEW_PASS_41.md`; owner decisions →
`OWNER_DECISIONS.md`; conditions → `LAUNCH_CLOSURE_MATRIX.md`; staging package →
`STAGING_EXECUTION_PLAN.md` § Pass 41; FFmpeg → `FFMPEG_RISK_DECISION.md` § 6; sessions →
`SESSION_TOKENS.md`; commercial work list → `COMMERCIAL_DECISION_PACK.md` § 7.

## 1. Repository state verified before any change

Branch `claude/amazing-sagan-pvouqy` = `origin` = `42aa713`; local branches `p39-hardening`
`9cb9893`, `p40-launch-evidence` `89a5c7c` exist; `a463d1c` ⊂ `42aa713` ⊂ `9cb9893` ⊂
`89a5c7c`. The 22 commits after `a463d1c` touch 64 files, none of them `.env`, `AGENTS.md`
or `.phase-status.json` (those two remain uncommitted in the main checkout, untouched);
gitleaks on `a463d1c..89a5c7c`: no leaks; all Pass 39/40 evidence documents present.

## 2. Changes in Pass 41

| Commit    | Change                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `684f7eb` | `scripts/ops/rehash-session-tokens.sh` + `migrate` runs it + mandatory `rehash-sessions` job; replaces the Pass 40 manual command (which put the URL on a command line) |
| `64a608d` | CI: schema-drift step (`prisma migrate diff --exit-code`)                                                                                                               |
| `e81828b` | FFmpeg steps fail closed on an unknown container; job-level pinning test                                                                                                |
| `de110d9` | Review fixes: watchdog listener leak, mail 409 retry, stronger "customer cannot add credits" test, `/revoke-other-sessions` 404                                         |
| `bcb1619` | Documents: RC review, FFmpeg recommendation D, staging package, decisions                                                                                               |
| `b2aeb88` | Test-only: TOTP enrollment codes computed away from a step boundary (the one gate failure on `bcb1619`, diagnosed and reproduced)                                       |

## 3. Gate results — each line names its commit (local sandbox only)

Environment: this sandbox (Ubuntu 24.04, Node 22, PostgreSQL 16.15 on disposable
databases, Docker 28, MinIO for S3), throwaway credentials generated per run.

| Gate                                                                   | Command                                                                           | Commit    | Exit | Result                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------- | ---- | -------------------------------------------------------------------------------- |
| Prisma generate / validate                                             | `prisma generate`, `pnpm db:validate`                                             | `bcb1619` | 0    | valid                                                                            |
| Format, typecheck, lint                                                | `pnpm format:check`, `pnpm typecheck`, `pnpm lint`                                | `bcb1619` | 0    | clean (0 warnings)                                                               |
| Unit                                                                   | `pnpm test`                                                                       | `bcb1619` | 0    | 71 files, 1152 tests                                                             |
| Release, preflight, render-env, AWS CLI pin and signature script tests | `scripts/release/test-*.sh`, `scripts/ops/test-*.sh`                              | `bcb1619` | 0    | all passed                                                                       |
| Terraform fmt / validate / test (mocked provider)                      | `terraform … test`                                                                | `bcb1619` | 0    | 11 passed                                                                        |
| Migrations from empty + schema identical + drift                       | `prisma migrate deploy/status`, `pg_dump` diff, `prisma migrate diff --exit-code` | `bcb1619` | 0    | 38 migrations; first 37 checksums identical to Pass 29; "No difference detected" |
| Integration                                                            | `pnpm test:integration`                                                           | `bcb1619` | 1    | 942/943 — TOTP enrollment code crossed a 30 s step (test timing, not product)    |
| Integration (after the test-only fix)                                  | `pnpm test:integration`                                                           | `b2aeb88` | 0    | 63 files, 943 tests                                                              |
| Restore drill                                                          | `scripts/ops/restore-drill.sh`                                                    | `bcb1619` | 0    | DRILL PASSED                                                                     |
| Restore drill mutants                                                  | `scripts/ops/restore-drill-mutants.sh`                                            | `bcb1619` | 0    | 13/13 killed                                                                     |
| S3 acceptance (MinIO)                                                  | `scripts/staging/local-stack.sh`                                                  | `bcb1619` | 0    | passed                                                                           |
| Build + e2e                                                            | `pnpm build`, `pnpm e2e`                                                          | `bcb1619` | 0    | 43 passed                                                                        |
| Images built and verified (contents, size, media tools, Trivy)         | `scripts/release/build-and-verify.sh` (no push)                                   | `de110d9` | 0    | no fixable HIGH/CRITICAL; worker 637 MEDIUM + 28 LOW (FFmpeg, none fixable)      |
| Local staging cycle (roles, rehash job, watchdog, outage alert)        | local Compose on the images above                                                 | `de110d9` | 0    | STAGING CHECK PASSED 34/0/0; rehash job OK; alerts delivered                     |
| gitleaks                                                               | `gitleaks git --log-opts=a463d1c..b2aeb88`                                        | `b2aeb88` | 0    | 28 commits, no leaks                                                             |

`bcb1619` and `de110d9` differ only in documents; `b2aeb88` only in four integration-test files — the
images and the staging cycle therefore cover the product code of `b2aeb88`. CI: **BLOCKED**
(account level). Hosted staging: **not run**.

## 4. Still blocked, and why

| Item                                                          | Why                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| CI                                                            | Account level: no runner since run #80 (`CI_STATUS.md`) |
| Staging, A1–A13, PITR, off-host backup, uptime, log retention | Needs `terraform.tfvars`, approvals (1)–(4), R-7/R-8    |
| FFmpeg (S2)                                                   | Owner decision: D (recommended) and/or A                |
| Payments, legal, tax                                          | Provider, markets, lawyer and tax adviser (owner)       |
| AWS CLI signing key                                           | Official page unreachable from this sandbox             |
