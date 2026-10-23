# Security hardening and reliability — Pass 39 (2026-10-23)

Companion to `LAUNCH_PROGRAM_PASS_38.md`. **Local evidence only: CI has no runner (last
run #80, `runner_id` 0; nothing new since), nothing is hosted, nothing ran on AWS, no real
email, payment or merchant account was used.** Commits are local on `p39-hardening`,
stacked linearly on Pass 38 → 37 → 36 → `42aa713` (the remote branch); the official
release candidate stays `a463d1c` until the owner approves a replacement.

## 1. Session tokens stored hashed (`a777dee`, test fix `6ae284c`)

**Before:** `sessions.token` held the raw token; the cookie is that token signed with
`AUTH_SECRET`. A database copy alone could not be replayed, but a database copy **plus**
`AUTH_SECRET` (both in one compromised host or backup set) let an attacker sign in as
anyone with a live session.

**Now:** the Prisma client handed to Better Auth's adapter stores and matches
`h1$` + SHA-256(token) (`src/server/auth/session-token-hash.ts`); the cookie still carries
the raw token. Routes that return or accept _other_ sessions' tokens (`list-sessions`,
`revoke-session`, `revoke-sessions`, `revoke-other-sessions`) are disabled (404). Revocation
by user (password change/reset, MFA reset) is unaffected.

| Threat                              | Before                 | After                                                              |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| Database or backup leak alone       | No replay (signed)     | No replay                                                          |
| Database leak + `AUTH_SECRET`       | **Hijack any session** | Stored value signed as a cookie is hashed again → refused (tested) |
| Token reuse after sign-out / expiry | Refused                | Refused (tested)                                                   |
| One device signed out               | Others stay            | Others stay (tested)                                               |
| Database unreachable                | Fails closed           | Fails closed, no session (tested)                                  |

**Migration** `20261023120000_hash_session_tokens`: one transaction, hashes rows not yet
prefixed; idempotent (tested twice); **users stay signed in** (tested on rows written the
old way). It is data-only: the schema dump is identical to Pass 29's.

**Rollback:** redeploying the previous release leaves hashed rows the old code cannot
match: every user is signed out **once**, no data is lost. There is no reverse migration
(hashes cannot be undone, by design).

**Production rollout (needs its own owner approval — not done):** deploy with the
migration in a normal release; no mass revocation is needed or performed; watch sign-in
errors and `sessions` row counts for an hour; rollback as above if needed. `AUTH_SECRET`
rotation remains the emergency "sign everyone out" lever.

Evidence (local): integration 5 new + theft test reworked; unit 4; mutants "no hashing"
(7 failures) and "no restore" (11 failures) caught.

## 2. FFmpeg (`0682675`, `c977319`)

**Facts (verified):** worker image FFmpeg `7:6.1.1-3ubuntu5` from Ubuntu noble
**universe** — no update has been published for it. Trivy 0.76.0 on the `3d19ed3` worker:
665 OS findings (MEDIUM 637, LOW 28), **0 fixable**, 585 of them in the FFmpeg libraries
(65 distinct CVEs). No HIGH/CRITICAL. This is the largest open risk in the images: FFmpeg
parses customer uploads.

**Controls now (all tested locally):**

| Control                                                                                             | Since   | Test                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Only the `file` protocol (`-protocol_whitelist file`)                                               | Pass 8  | http playlist refused                                                                                                                 |
| Content sniffed before processing; size limits                                                      | Pass 8  | existing                                                                                                                              |
| **Demuxer pinned to the sniffed container** (`-f mov/matroska/mp3/wav`)                             | Pass 39 | A `.m3u8` playlist naming another local file **is followed** unpinned (control) and refused pinned, also behind an MP4-looking header |
| Hard timeout, SIGKILL; damaged file fails fast                                                      | Pass 8  | 1 s timeout kills a heavy encode; truncated MP4 fails < 15 s                                                                          |
| Worker: no capabilities, no-new-privileges, PID cap 256, 2 GB memory without swap, 2 CPUs, non-root | Pass 39 | `docker inspect` + `/proc/1/status` (CapEff 0, NoNewPrivs 1); FFmpeg encodes under the caps                                           |

Note on pinning: today the worker names its copy `source.bin`, which FFmpeg does not take
for a playlist — pinning removes the dependence on that name.

**Alternatives (owner decision R-9; none applied — no random upgrade):**

| Option                                                   | Effect on the 585 findings  | Cost / risk                                         |
| -------------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| (a) Ubuntu Pro / ESM (universe security updates)         | Patched as Canonical ships  | Subscription; same build pipeline                   |
| (b) Maintained static FFmpeg build, pinned + checksummed | Depends on its cadence      | Supply-chain trust in the builder; we own updates   |
| (c) FFmpeg built with only the needed demuxers/decoders  | Removes most code paths     | Build and maintenance effort                        |
| (d) seccomp profile for the worker                       | Limits post-exploit actions | Profile tuning, test on every FFmpeg change         |
| (e) Documented acceptance                                | None                        | Must be signed by the owner with the controls above |

**Status: open.** Not closed without (a)–(c) or a signed (e).

## 3. Reliability, monitoring, backups

**Done and tested in the role-separated local cycle (images `3d19ed3`):**

- Scheduler stopped → critical alert at the receiver after 16 s (watchdog every 20 s in the test; 300 s default).
- Alert destination answering 500 → the slot is given back; delivered 20 s after it recovered (`answered` 500 then 200).
- **New:** database down → `readiness` 503, `liveness` 200; the watchdog alerts "cannot read
  the operational status" after 37 s (second consecutive failure); after 39 s down,
  PostgreSQL back → app ready at once, no container restarted, scheduler tick 200, worker
  and tick heartbeats recorded after recovery. Unit + integration tests; two mutants caught.
- No persistent false alert: the watchdog is stateless per run, the shared throttle holds a
  condition to one alert per 30 min, a single failed read is silent.

**Designed, not implemented (needs services / owner decisions R-7, R-8):**

| Item                   | Design                                                                                                                                                                                           | Who responds                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| External uptime        | A third-party check of `/api/health?scope=liveness` and `?scope=readiness` every 1 min from 2 regions; page after 2 consecutive failures; TLS expiry < 14 days → warning                         | On-call person named by the owner |
| Host / database alarms | CloudWatch: CPU > 80 % 10 min, disk > 80 %, RDS free storage < 20 %, connections > 80 % of max, replica lag n/a                                                                                  | Same                              |
| Logs                   | Ship container logs to CloudWatch Logs; staging 30 days, production per counsel; redaction already in pino (`authorization`, `cookie`, `*token*`, `*secret*`, `password`) — check a sample (A10) | Owner sets retention              |
| Off-host DB backups    | Daily `db-backup.sh` job → separate, versioned, encrypted S3 bucket in another account or region; lifecycle 35 days; restore drill monthly                                                       | Owner approves cost               |
| Media                  | Versioning with 7-day noncurrent expiry (protects against deletion; conflicts with erasure deadlines — counsel)                                                                                  | Owner + counsel                   |
| PITR                   | RDS automated backups `db_backup_retention_days` (1–35, Terraform-enforced ≥ 1); target **RPO ≤ 5 min**; restore test into a new instance (A9)                                                   | —                                 |
| RTO                    | Target 30 min for the database; local reference: 1 GB restore 27.1 s + verify 2.2 s; app rollback ≈ 6 s; **hosted values unmeasured**                                                            | —                                 |

Off-host backup and PITR **are not working anywhere yet**: nothing is hosted.

## 4. Mail and jobs

Resend: lost connection, timeout (new test: a hanging attempt is cut at its timeout and
retried), 429 and 5xx retried three times with **one Idempotency-Key per email**; other 4xx
not retried; give-up reports the status. No real email sent (fake fetch / test outbox).
Jobs: database outage during the cycle (above) — services recover without restart; leases
let an interrupted Creator Studio job be reclaimed after expiry (existing tests, Pass 14
container cycle); storage outage tests exist for retention and deletion.

## 5. Payments and legal

`PAYMENTS_DESIGN.md` § 6–9 (ledger vs provider truth, webhook test design, provider
criteria and comparison matrix — no provider chosen, acceptance before real money).
`docs/legal/LAUNCH_LEGAL_CHECKLIST.md` § 5–6: **no self-service account deletion**
(verified: `/delete-user` disabled, 404), export only per Creator Studio project; decisions
for counsel and the tax adviser. No compliance is claimed.

## 6. CI, staging preparation, approvals

- **CI (R-1):** no run since #80 (2026-10-23 09:17 UTC); all recent jobs had no runner.
  Not bypassed (no other account or runner). The owner restores Actions/billing, then CI
  runs on the approved candidate.
- **AWS CLI signature policy:** the official AWS documentation could not be fetched from
  this environment (proxy 403 / DNS). The pinned installer stays unused until the current
  signing key is verified from the official source.
- **Preflight values R-1…R-9** stay owner inputs (`STAGING_LAUNCH.md` § 1); none guessed.
- **A1–A10 evidence** (`STAGING_LAUNCH.md` § 6): each needs its artefact from the hosted
  environment — A1 gate output, A2 curl over TLS, A3 `docker inspect` labels + ECR digests,
  A4 real-mail sign-up log, A5 upload/export ids + worker heartbeat, A6 30 min of tick 200s,
  A7 screenshot/receipt at the destination, A8 backup set + `VERIFIED`, A9 PITR timings,
  A10 log sample review. Plus for Pass 39: container hardening (`docker inspect`) and the
  database-outage alert on the host.
- **Approvals stay separate:** (1) `terraform plan` → (2) `apply` after review → (3) ECR
  push → (4) staging deploy → (5) production. Rollback: previous image tag (`up -d`), the
  session migration rollback in § 1.

## 7. Gate results (local only)

Gates on `6ae284c` (2026-10-23, 19:52–20:25 UTC), all exit 0. Images built and verified
from `3d19ed3` (later commits change only tests and docs): app 389 MB, worker 1197 MB, ops
1056 MB; no `.trivyignore` entry; 0 fixable HIGH/CRITICAL; no Node finding.

| Gate                                                                                                       | Local                           | CI  | Hosted staging | Production |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------- | --- | -------------- | ---------- |
| Format, lint, typecheck, unit                                                                              | Yes: unit 1150 / 71 files       | No  | —              | —          |
| Integration                                                                                                | Yes: 937 / 62 files             | No  | No             | No         |
| Migrations: 38 applied; first 37 checksums = Pass 29; schema dump identical; drift none                    | Yes                             | No  | No             | No         |
| Restore drill + 13 mutants                                                                                 | Yes: drill passed, 13/13 killed | No  | No (A8/A9)     | No         |
| S3 acceptance, build, E2E, Terraform (mocked), release-script tests                                        | Yes: 5; build; 43; tests pass   | No  | No             | No         |
| Images, contents, Trivy (no exception)                                                                     | Yes (`3d19ed3`)                 | No  | —              | —          |
| Role-separated cycle: gate 34/0/0, backup under writes → VERIFIED (77/502/38), restore over source refused | Yes                             | —   | No (A1–A10)    | No         |
| Watchdog: scheduler stop, alert failure + retry, database outage + recovery                                | Yes                             | —   | No             | No         |
| Container hardening (caps, no-new-privileges, PID/memory/CPU)                                              | Yes (`docker inspect`, `/proc`) | —   | No             | No         |
| gitleaks on the 13 new commits                                                                             | Yes: no leaks                   | No  | —              | —          |
| Payments, legal texts                                                                                      | No (design / checklist only)    | —   | No             | No         |

A first run of the local cycle failed its gate 26/4 (scratch space, storage write,
multipart): the sandbox disk was full (640 MB free). After deleting old local images and
the build cache, the same images and script passed 34/0/0. A hosted host must have the
worker scratch space the gate requires (4.2 GiB here).
