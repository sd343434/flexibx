# Commercial launch program — Pass 38 (2026-10-23)

Companion to `COMMERCIAL_LAUNCH_READINESS.md` (Pass 37). **Local evidence only: CI has no
runner (last run #80, `runner_id` 0), nothing is hosted, nothing ran on AWS.** Commits are
local on `p38-launch-program`, stacked on `p37-launch-fixes` → `p36-no-runtime-pnpm` →
`42aa713` (linear history; integration order = fast-forward, if the owner approves).

## 1. Fixed in Pass 38

| Blocker                                                         | Fix (commit `c6d860c`)                                                                                                                                                | Evidence                                                                                                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in rate limits shared by every client behind the TLS proxy | Caddy overwrites `X-Real-IP` with the peer address; `AUTH_IP_HEADER=x-real-ip` in the staging env; a **public** production server refuses to start without the header | Caddy 2.6.2 (Ubuntu 24.04's version, `2.6.2-6ubuntu0.24.04.3`): a client-sent `X-Real-IP` / `X-Forwarded-For` is replaced by its real address; unit tests (startup, gate) |
| Mail: no retry, duplicates on lost answers                      | Resend: three attempts on lost connection/timeout/429/5xx, **one Idempotency-Key per email**; other 4xx not retried                                                   | Unit tests: key identical across retries and new per email, backoff 500/1500 ms, give-up status, no retry on 422                                                          |
| Nothing alerted when the scheduler stopped                      | Scheduler watchdog in the Creator Studio worker (`SCHEDULER_WATCHDOG_SECONDS`, default 300): critical alert on the tick's own stale/failed checks, shared throttle    | Unit + integration tests; container run: scheduler stopped, heartbeat aged → critical alert at the receiver after 14 s                                                    |

## 2. Re-verified Pass 37 fixes (independently, on the `c6d860c` images)

Owner login only in migrate/backup/check (`check-compose-credentials.sh`; app, worker,
scheduler containers have no `OWNER_DATABASE_URL`); `db-roles.sql` on an empty database
fails (exit 3), after migrate it passes; the runtime login cannot migrate (exit 1); gate
`STAGING CHECK PASSED` 34/0/0; a backup taken while the runtime login writes restores
`VERIFIED` (77 tables / 502 objects / 37 migrations); a restore aimed at the source is
**refused** ("target database is not empty").

### Owner credential policy (proposal for R-4)

| Aspect   | Policy                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage  | Its own Secrets Manager secret (not the app's env secret); on the host only as `staging-owner.env`, root-owned, mode 600, written at deploy time            |
| Use      | Only the one-off jobs migrate, backup and check (Compose `x-owner-env`, asserted in CI); never app, worker, scheduler                                       |
| Access   | Read by the deploy operator's role; the instance role reads it only if scheduled backups run on the host (decision with R-8)                                |
| Rotation | After each launch phase and on any suspicion: `ALTER ROLE … PASSWORD`, update the secret, rewrite the file; the app is unaffected (runtime login unchanged) |
| Audit    | CloudTrail on secret reads (needs R-7 log retention)                                                                                                        |

## 3. Images and vulnerabilities (fresh scan, no exception)

Trivy 0.76.0, database updated 2026-10-23 07:12 UTC (newest published). `c6d860c`: 0
HIGH/CRITICAL; OS MEDIUM/LOW app 21/4, worker 637/28, ops 23/4; **no Node finding**; no
pnpm, corepack or `ip-address` in any image (contents checks, with the `a463d1c` images as
the positive control); Prisma and tsx run offline (ops self-check).

**No OS finding has a published fix** (all `affected`), so none is fixable by rebuilding.
They are open risks, not closed ones:

| Group                               | Fixable now? | Risk                                                                                                                                                      | Mitigations in place                                                                                         | Options (owner, R-6 / R-9)                                                                                                                                    |
| ----------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg 6.1.1 (worker, ≈ 585 of 665) | **No**       | **High**: decodes customer uploads. Ubuntu ships it from **universe** (`6.1.1-3ubuntu5`, no update ever published): outside standard security maintenance | Local files only (`-protocol_whitelist file`), container sniffing, size limits, no shell, timeouts, non-root | (a) Ubuntu Pro / ESM for universe; (b) a maintained static FFmpeg with its own update cadence; (c) pin the demuxer per sniffed container; (d) seccomp profile |
| glibc, pcre2, gnutls, tar, systemd  | No           | Low–medium                                                                                                                                                | non-root, minimal packages, security updates at every build                                                  | Confirm the patch-at-build policy and a weekly re-scan (R-9)                                                                                                  |

## 4. Session tokens (analysis; not changed)

Better Auth 1.7.9 stores the session token unhashed (`sessions.token`). The cookie is
**signed with `AUTH_SECRET`** (`setSignedCookie` / `getSignedCookie`) and no bearer-token
plugin is enabled, so a database-only leak (a stolen dump, a read-only SQL injection)
cannot be replayed as a cookie without `AUTH_SECRET`. Impact if both leak: session hijack
until expiry (7 days) or revocation. Better Auth has no hashed-token option in 1.7.9.

A compatible fix is an adapter wrapper that stores `sha256(token)` and maps lookups — but
Better Auth also returns tokens to users (`list-sessions`) and accepts them back
(`revoke-session`, "revoke other sessions" compares the current token with stored ones), so
every one of those flows changes. Not done in Pass 38: it needs its own change with tests for
sign-in, refresh, sign-out, revoke-one, revoke-others, password reset (revokes all), MFA
(`mfaVerifiedAt`), and a migration that hashes existing rows in place (users stay signed in).
Interim controls: `AUTH_SECRET` never in backups or the database; rotation invalidates all
sessions (documented).

## 5. Monitoring, alerting, backups (design; values are owner decisions R-7/R-8)

| Signal                   | Source                                                 | Threshold / alert                                        | Status                        |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------------------- | ----------------------------- |
| App up (outside view)    | External uptime check of `/api/health?scope=liveness`  | 2 failures in 2 min → page                               | **Missing** (needs a service) |
| Scheduler stopped        | Worker watchdog                                        | tick age ≥ 15 min or last tick failed → critical         | **Done (local)**              |
| Worker stopped           | Tick's ops-status alerts                               | worker heartbeat ≥ 10 min → critical                     | Existing (local)              |
| Alert destination broken | ops-status `alert_delivery_failed`                     | warning                                                  | Existing (local)              |
| Host, database           | CloudWatch alarms (CPU, disk, RDS storage/connections) | per R-7                                                  | **Missing** (Terraform, R-7)  |
| Logs                     | Container logs rotated 5 × 10 MB                       | ship to CloudWatch, retention 30 days staging (proposal) | **Missing**                   |

Backups: PITR (RDS, 7 days default) configured, **never exercised** (A9). Logical dumps
are snapshot-consistent and verified locally, but there is **no schedule and no off-host
copy** — proposal: a daily job writing to a separate, versioned, encrypted bucket with
lifecycle expiry. Media: the bucket has **no versioning** (deliberate: deleted projects must
be gone) — proposal: versioning with a short noncurrent-version expiry (e.g. 7 days) as
protection against accidental or malicious deletion, an owner trade-off against erasure
deadlines.

## 6. CI (R-1)

No new run since #80; every job of #76–#80 had `runner_id` 0 and 0 billable ms (account
level). Not bypassed. Restoring it: owner fixes billing/Actions on the account, then runs CI
on the final candidate. Must pass there: the quality, integration, docker and secret-scan
jobs of `.github/workflows/ci.yml` (now including `check-compose-credentials.sh`).

## 7. Gate status

| Gate                                                | Local                              | CI  | Hosted staging | Production |
| --------------------------------------------------- | ---------------------------------- | --- | -------------- | ---------- |
| Format, lint, typecheck, unit                       | Yes: unit 1144                     | No  | —              | —          |
| Integration, Prisma, migrations/drift               | Yes: 925; 37 checksums; drift none | No  | No             | No         |
| Restore drill + 13 mutants                          | Yes: drill passed, 13/13           | No  | No (A8/A9)     | No         |
| S3 acceptance, build, E2E, Terraform (mocked)       | Yes: 5; build; 43; 11              | No  | No             | No         |
| Images built, contents, Trivy (no exception)        | Yes (`c6d860c`)                    | No  | —              | —          |
| Role-separated staging cycle, gate 34/0/0, watchdog | Yes                                | —   | No (A1–A10)    | No         |
| Client IP behind the proxy                          | Yes (Caddy 2.6.2 test)             | —   | No             | No         |
| Payments, legal texts                               | No (design / checklist only)       | —   | No             | No         |

Gates ran on `c6d860c` from 2026-10-23 16:15 to 16:45 UTC, all exit 0. Images
`c6d860c`: app `sha256:3e3b6f3d7d55…`, worker `sha256:6ac2cc0580c1…`, ops
`sha256:d8a7359209b1…` (local IDs; registry digests exist only after an ECR push).
