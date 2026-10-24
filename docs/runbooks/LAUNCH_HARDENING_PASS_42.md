# FFmpeg secret isolation and release gates — Pass 42 (2026-10-24)

**Local evidence only.** CI is blocked at the account level (no run since #80), nothing is
hosted, no AWS call, nothing pushed or merged; the official candidate is still `a463d1c`.
Pass 42 works on the local branch `p42-media-isolation`, linear on `p41-rc-candidate`.
Design and residual risk → `MEDIA_ISOLATION.md`; CVEs → `FFMPEG_RISK_DECISION.md` § 7.

## 1. Repository state verified before any change

Main checkout `claude/amazing-sagan-pvouqy` = `origin` = `42aa713` (untouched; `.env`,
`AGENTS.md`, `.phase-status.json` uncommitted there, as before). Local branches:
`p39-hardening` `9cb9893` → `p40-launch-evidence` `89a5c7c` → `p41-rc-candidate`
(`b2aeb88`, then `1ce2d07` with the Pass 41 record) → `p42-media-isolation`.
The Pass 41 integration re-run on `b2aeb88`, still running when Pass 41 was reported, was
checked to its end before anything else: **63 files, 943 tests, exit 0** (recorded in
`LAUNCH_HARDENING_PASS_41.md` § 3, separately from Pass 42).

## 2. Changes in Pass 42

| Commit    | Change                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b190c7a` | Media runner (`scripts/creator/media-runner.ts`, `runner-protocol.ts`, `runner-client.ts`, `runner-env.ts`); `media` Compose service; worker/preflight wiring; no-fallback guards; Compose isolation check; tests; worker-loop listener leak fixed |
| `729d8f6` | `creator_worker_media_runner_down` (critical) instead of counting the outage as a cleanup failure — found by the first container cycle; runbooks                                                                                                   |
| (this)    | Records: this file, `FFMPEG_RISK_DECISION.md` § 7, matrix S2/A14, CVE evidence                                                                                                                                                                     |

## 3. Review of the Pass 41 changes (requested)

| Item                                      | Finding                                                                                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rehash script and its place in the deploy | Runs at the end of `migrate` and as the mandatory `rehash-sessions` job after `up -d`; idempotent (`h1$` rows untouched); one statement; counts only                                                                               |
| Credentials in arguments or logs          | URL passed in the environment, turned into PG\* variables and a 0600 pass file by `lib/pgenv.sh`; `bash -c` sees the literal `$DATABASE_URL`, not the value; output is counts only                                                 |
| Rollback / roll-forward                   | Previous tag = one sign-in for everyone (raw tokens no longer match); roll-forward = migrate + rehash job again; documented in `SESSION_TOKENS.md`; Pass 42 adds `--remove-orphans` for rolling back past the runner               |
| CI drift check                            | `prisma migrate diff --from-config-datasource --to-schema … --exit-code` after `migrate deploy`; locally exit 0 on a migrated database, exit 2 after a manual column (Pass 41); runs in CI only when CI runs                       |
| FFmpeg pinning and unsupported formats    | Job steps refuse a container without a pinned demuxer (`unsupported_format`); Pass 42 adds the runner's own `-f` allowlist, so even a worker bug cannot select `lavfi`/`concat`/`hls`                                              |
| Watchdog listener cleanup                 | Fixed in Pass 41. **New finding:** the worker loop's own `sleep` had the same leak (one abort listener per poll) — fixed in `b190c7a`                                                                                              |
| Resend 409 / 429 / network errors         | Retried three times with one Idempotency-Key; 409 is Resend's "same key still in progress" (the body is identical per email, so the "different body" 409 cannot occur); other 4xx not retried                                      |
| Credit permissions and 404 tests          | Customer who owns the workspace is refused, admin's identical grant succeeds; all four session-exposing routes return 404                                                                                                          |
| Local vs hosted Compose                   | The local override only switches services to the host network (the sandbox's database, bucket and alert receiver are on 127.0.0.1); `media` is not overridden — `network_mode: none` in both                                       |
| Local tests vs the production path        | Before Pass 42 the integration tests and production ran FFmpeg the same way (locally). Now production runs it through the runner: covered by the runner integration tests and by the container cycle with the worker's real wiring |

## 4. Isolation proven in containers — release images `729d8f6`

Local Compose cycle (`deploy/staging/compose.yaml` + the sandbox override), synthetic
secrets generated per run, the database roles in force. Names and counts only.

| Check (inside `media` unless stated)                                                                                                               | Result                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Container settings (`docker inspect`)                                                                                                              | `network=none`, read-only root, own PID namespace, private IPC, user `node`, `CapDrop ALL`, not privileged                                                                                                                                             |
| Mounts                                                                                                                                             | Only the `work` volume at `/work`                                                                                                                                                                                                                      |
| Variable names in **every** `/proc/*/environ` visible                                                                                              | 10 names, **0 sensitive** (`CREATOR_WORK_DIR HOME HOSTNAME MEDIA_RUNNER_* NEXT_TELEMETRY_DISABLED NODE_ENV PATH PWD`)                                                                                                                                  |
| Control: the same read in the worker                                                                                                               | 8 credentials found (`AUTH_SECRET … VIDEO_RETENTION_CRON_SECRET`) — the test can see them where they exist                                                                                                                                             |
| Processes visible                                                                                                                                  | The runner (and its esbuild helper) and the probe itself; **0** worker processes                                                                                                                                                                       |
| Synthetic `AUTH_SECRET`, `S3_SECRET_ACCESS_KEY`, `ENCRYPTION_KEY`, `DATABASE_URL` searched in every readable file, `/proc/*/environ` and `cmdline` | **0 hits each** (control in the worker: 1 hit each)                                                                                                                                                                                                    |
| Network                                                                                                                                            | Interfaces: `lo` only; 127.0.0.1:5432/8333 refused; host, metadata 169.254.169.254, internet unreachable; DNS fails                                                                                                                                    |
| Docker socket, `/run/secrets`, `.env`, `deploy/`                                                                                                   | Absent                                                                                                                                                                                                                                                 |
| Root filesystem / `/tmp`                                                                                                                           | Read-only / tmpfs                                                                                                                                                                                                                                      |
| `/proc/self/status`                                                                                                                                | Uid 1000, CapEff 0, CapBnd 0, NoNewPrivs 1, Seccomp 2                                                                                                                                                                                                  |
| Socket                                                                                                                                             | `/work/.media-runner` 0700, socket 0600, owner `node`                                                                                                                                                                                                  |
| Policy, asked from the worker                                                                                                                      | `/proc/1/environ` input, `tcp://` input, `-f lavfi`, `-f concat` — all refused                                                                                                                                                                         |
| End to end with the worker's own wiring (`getCreatorDeps`)                                                                                         | Probe → render with Arabic subtitles → verify through the runner: `RENDERED_AND_VERIFIED` (≈1.1 s)                                                                                                                                                     |
| Worker loss mid-render                                                                                                                             | FFmpeg running in `media` (1) → caller killed → **0** FFmpeg left                                                                                                                                                                                      |
| Runner loss mid-render                                                                                                                             | Caller gets `unavailable` (retryable); no FFmpeg started in the worker container (0)                                                                                                                                                                   |
| Runner down                                                                                                                                        | `unavailable`; heartbeat `media_runner`; log "no job is claimed"; gate check `creator_worker_media_runner_down` critical                                                                                                                               |
| Runner back                                                                                                                                        | Render succeeds again; log "claiming jobs again"; next heartbeat clean                                                                                                                                                                                 |
| Runner given `DATABASE_URL`                                                                                                                        | Refuses to start, exit 78, names `DATABASE_URL` only                                                                                                                                                                                                   |
| Production worker without the runner                                                                                                               | Refuses to start, exit 1                                                                                                                                                                                                                               |
| Gate (`run --rm check`, FFmpeg checks through the runner)                                                                                          | **STAGING CHECK PASSED 36/0/0**, incl. `media_isolation` and `creator_worker_media_runner_down`                                                                                                                                                        |
| Unchanged cycle parts                                                                                                                              | Migrate + rehash, roles, backup under writes → VERIFIED, refused restore over the source, watchdog alert, alert retry, database outage alert (38 s) and recovery without restart, CapEff 0 / NoNewPrivs 1 / Seccomp 2 in app, worker, media, scheduler |

The first cycle (images `b190c7a`) found one defect, fixed in `729d8f6`: the outage was
reported as `creator_worker_cleanup_failed`. Its gate run, and one on `729d8f6` run within a
heartbeat period of the deliberate outage, failed on that check — correctly; the final run
waits for a clean heartbeat first.

## 5. Gate results — each line names its commit (local sandbox only)

Environment: this sandbox (Ubuntu 24.04, Node 22, PostgreSQL 16.15 on disposable databases,
Docker, SeaweedFS for S3, Trivy 0.76.0 with its database of 2026-10-24), throwaway or
synthetic credentials generated per run. **None of these is a CI or hosted result.**

| Gate                                                                   | Command                                                                           | Commit    | Exit | Result                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------- | ---- | ----------------------------------------------------------------------------------- |
| Prisma generate / validate                                             | `prisma generate`, `pnpm db:validate`                                             | `729d8f6` | 0    | valid                                                                               |
| Format, typecheck, lint                                                | `pnpm format:check`, `pnpm typecheck`, `pnpm lint`                                | `729d8f6` | 0    | clean (0 warnings)                                                                  |
| Unit                                                                   | `pnpm test`                                                                       | `729d8f6` | 0    | 72 files, 1189 tests (Pass 41: 1152)                                                |
| Release, preflight, render-env, AWS CLI pin and signature script tests | `scripts/release/test-*.sh`, `scripts/ops/test-*.sh`                              | `729d8f6` | 0    | all passed                                                                          |
| Terraform fmt / validate / test (mocked provider)                      | `terraform … test`                                                                | `729d8f6` | 0    | 11 passed                                                                           |
| Compose credentials, hardening and media isolation                     | `scripts/staging/check-compose-credentials.sh`                                    | `729d8f6` | 0    | owner login 4 jobs only; media: no credential, no network, read-only, only `/work`  |
| Migrations from empty + schema identical + drift                       | `prisma migrate deploy/status`, `pg_dump` diff, `prisma migrate diff --exit-code` | `729d8f6` | 0    | 38 migrations; first 37 checksums as Pass 29; "No difference detected"              |
| Integration                                                            | `pnpm test:integration`                                                           | `729d8f6` | 0    | 64 files, 952 tests (incl. 8 runner tests with real FFmpeg, 1 worker gate test)     |
| Pass 42 mutants (isolation controls)                                   | `p42m-run.sh` (19 mutants on a copy)                                              | `b190c7a` | 0    | 19/19 killed (`729d8f6` changed none of the mutated code)                           |
| Restore drill                                                          | `scripts/ops/restore-drill.sh`                                                    | `729d8f6` | 0    | DRILL PASSED                                                                        |
| Restore drill mutants                                                  | `scripts/ops/restore-drill-mutants.sh`                                            | `729d8f6` | 0    | 13/13 killed                                                                        |
| S3 acceptance (local S3)                                               | `scripts/staging/local-stack.sh`                                                  | `729d8f6` | 0    | passed                                                                              |
| Build                                                                  | `pnpm build`                                                                      | `729d8f6` | 0    | built                                                                               |
| E2E                                                                    | `pnpm e2e`                                                                        | `729d8f6` | 1    | 42/43 — `members.spec.ts` (ar): role still EDITOR after choosing VIEWER (see below) |
| E2E after the test-only fix                                            | `pnpm e2e`, twice                                                                 | (this)    | 0    | 43/43 both runs                                                                     |
| Images built and verified (contents, size, media tools, Trivy)         | `scripts/release/build-and-verify.sh` (no push)                                   | `729d8f6` | 0    | app 389 / worker 1197 / ops 1032 MB; no fixable HIGH/CRITICAL                       |
| Trivy JSON on the final images                                         | `trivy image --format json`                                                       | `729d8f6` | 0    | app 25, worker 665 (585 FFmpeg = 65 CVEs), ops 27 findings; **0 fixable** anywhere  |
| Local staging cycle with isolation, database outage and alerts         | `p42s/stage.sh` on the images above                                               | `729d8f6` | 0    | STAGING CHECK PASSED 36/0/0; § 4                                                    |
| gitleaks                                                               | `gitleaks git --log-opts=a463d1c..HEAD`                                           | `729d8f6` | 0    | no leaks                                                                            |
| CI                                                                     | —                                                                                 | —         | —    | **BLOCKED** (account level, not worked around)                                      |
| Hosted staging, Terraform plan/apply, ECR, PITR                        | —                                                                                 | —         | —    | **BLOCKED** (inputs and approvals; nothing run against AWS)                         |

**The one E2E failure.** In the full parallel run the owner chose VIEWER right after
`owner.reload()` and the select read EDITOR afterwards; the server logged no error for it.
The most consistent explanation is an interaction before React hydrated the page (the
uncontrolled select is reset to its default and the submit carries no change). It was
**not reproduced**: 24 isolated repetitions and two runs with delayed scripts passed
without the fix. The test now waits for `networkidle` after the reload (the wait
`workspace-shell.spec.ts` already uses); two full runs then passed 43/43. Product code is
unchanged; the same test passed on `bcb1619` in Pass 41.

## 6. Still blocked, and why

| Item                                                                 | Why                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| CI                                                                   | Account level: no runner since run #80 (`CI_STATUS.md`) — not worked around          |
| Hosted staging, A1–A14, PITR, off-host backup, uptime, log retention | Needs `terraform.tfvars`, approvals (1)–(4), R-7/R-8                                 |
| FFmpeg CVEs (S2)                                                     | 65 still present; isolation contains them; Ubuntu Pro (A) needs the owner's decision |
| Payments, legal, tax                                                 | Provider, markets, lawyer and tax adviser (owner)                                    |
| Session-token change in production                                   | Separate production approval (behaviour change, Pass 41)                             |
