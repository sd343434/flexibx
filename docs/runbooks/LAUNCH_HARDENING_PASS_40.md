# Launch readiness and evidence closure — Pass 40 (2026-10-24)

**Local evidence only.** CI is blocked at the account level (no run since #80), nothing is
hosted, no AWS call was made, nothing was pushed or merged, the official candidate is still
`a463d1c`. Commits are local on `p40-launch-evidence`, stacked on `p39-hardening`
(`9cb9893`) → … → `42aa713` (the remote branch); linear history.

Index: conditions and their status → `LAUNCH_CLOSURE_MATRIX.md`; staging order →
`STAGING_EXECUTION_PLAN.md`; FFmpeg → `FFMPEG_RISK_DECISION.md`; sessions →
`SESSION_TOKENS.md`; payments/legal/tax → `COMMERCIAL_DECISION_PACK.md`; CI →
`CI_STATUS.md` § Pass 40.

## 1. Changes and why

| Commit    | Change                                                                                                                               | Why / evidence                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `80130b8` | Rollback / roll-forward test for hashed session tokens; `SESSION_TOKENS.md`                                                          | Found: sessions created during a rollback need the hashing statement re-run (Prisma won't re-run a migration). Command run from the ops image on a scratch database: hashed, idempotent |
| `7114ae8` | Test: HLS/TTY/XBIN demuxers are never selected under any accepted container; Compose check refuses `seccomp`/`apparmor` `unconfined` | 3 of the 4 FFmpeg CVEs with no fix anywhere live in those demuxers; negative control fails                                                                                              |
| `fba092f` | Test: a customer with two-factor cannot add credits or change a plan (valid request)                                                 | Proves "the client cannot change balance"; mutant without the admin check is caught                                                                                                     |
| `061ca14` | Closure matrix, FFmpeg decision + CVE evidence TSV, CI diagnosis, staging plan, commercial decision pack                             | Requested analysis                                                                                                                                                                      |
| `c2e94f8` | `fast-uri` pinned to 3.1.9 (pnpm override)                                                                                           | A fresh Trivy DB found 4 new advisories (2 MEDIUM, 2 LOW) in the ops image's Prisma CLI tree; after the fix the ops image has no Node finding                                           |

Investigated, not changed: an "aborted" upload-part error in the E2E server log (also in
Pass 38) comes from the test-only in-memory upload route; it returns 404 outside
`STORAGE_DRIVER=test-memory`, so it cannot raise production alerts.

## 2. Gate results — commit `c2e94f8`, local sandbox only

| Gate                                                      | Command                                                                                             | Result                                                                                                                                                                                                                                                                           | Exit |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Prisma generate, format, typecheck, lint, schema validate | `pnpm exec prisma generate`, `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm db:validate` | pass                                                                                                                                                                                                                                                                             | 0    |
| Unit                                                      | `pnpm test`                                                                                         | 1150 / 71 files                                                                                                                                                                                                                                                                  | 0    |
| Release, preflight, env, AWS CLI script tests             | `scripts/release/test-*.sh`, `scripts/ops/test-*.sh`                                                | pass (stubs; no AWS)                                                                                                                                                                                                                                                             | 0    |
| Terraform                                                 | `fmt -check`, `init -backend=false`, `validate`, `test` (offline mirror)                            | pass                                                                                                                                                                                                                                                                             | 0    |
| Migrations, checksums, drift                              | fresh database `migrate deploy` + `status`; schema dump; checksums; `migrate diff --exit-code`      | 38 applied; first 37 checksums = Pass 29; 38th = hash migration; schema identical; no drift                                                                                                                                                                                      | 0    |
| Integration                                               | `pnpm test:integration`                                                                             | 940 / 62 files                                                                                                                                                                                                                                                                   | 0    |
| Restore drill, mutants                                    | `scripts/ops/restore-drill.sh`, `restore-drill-mutants.sh`                                          | DRILL PASSED; 13/13 killed                                                                                                                                                                                                                                                       | 0    |
| S3 acceptance                                             | `scripts/staging/local-stack.sh`                                                                    | 5 / 5                                                                                                                                                                                                                                                                            | 0    |
| Build, E2E                                                | `pnpm build`, `pnpm e2e`                                                                            | build ok; 43 passed                                                                                                                                                                                                                                                              | 0    |
| Release images                                            | `scripts/release/build-and-verify.sh c2e94f8…`                                                      | built and verified: app 389 MB, worker 1197 MB, ops 1032 MB                                                                                                                                                                                                                      | 0    |
| Trivy (0.76.0, no exception)                              | inside `build-and-verify.sh`                                                                        | 0 fixable HIGH/CRITICAL; OS M/L app 21/4, worker 637/28, ops 23/4; **Node: none**                                                                                                                                                                                                | 0    |
| Role-separated container cycle                            | local Compose stack, throwaway secrets                                                              | gate 34/0/0; backup under writes → VERIFIED (77/502/38); restore over source refused; watchdog alert 16 s; failed alert retried 20 s; CapEff 0, NoNewPrivs 1, Seccomp 2 on app/worker; FFmpeg under the caps; DB outage: readiness 503, alert at 38 s, recovery without restarts | —    |
| Secrets                                                   | gitleaks on `9cb9893..c2e94f8`                                                                      | no leaks                                                                                                                                                                                                                                                                         | 0    |

The first image build of this pass (`061ca14`) verified everything except the scan, which
could not reach the proxy; the rescan with the right network found the `fast-uri` advisories
that led to `c2e94f8`. A build of `c2e94f8` then failed for lack of disk (sandbox full); after
removing this pass's build cache it passed. Documentation-only commits after `c2e94f8` do not
change the images.

## 3. What is still not proven (see the matrix)

CI (BLOCKED, account). Everything hosted: A1–A12, PITR, off-host backup, external uptime,
log shipping. FFmpeg (DECISION). Payments, legal texts, tax (DECISION). AWS CLI signing key
(BLOCKED: the official page is unreachable from this sandbox).
