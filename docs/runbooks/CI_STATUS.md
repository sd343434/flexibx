# CI status and the GitHub Actions blocker (Passes 10–15)

**Verdict on 2026-10-19: CI is NOT verified.** Since run #43 (2026-10-17), no job of the
`CI` workflow has started. GitHub never assigned a runner, so no step ran. This is a block
at the account or repository level, not a failing test. It cannot be fixed from inside
the repository. Until a run actually executes, the project must not be described as
passing CI. The local gates (below) do not replace CI.

## 1. Evidence

Collected through the GitHub API (repository, workflow, runs, jobs, check runs and usage).

| Run                | Commit    | Created (UTC)    | Result                                                          |
| ------------------ | --------- | ---------------- | --------------------------------------------------------------- |
| #41                | `ee1e886` | 2026-10-16 21:40 | success, about 14 minutes of real work                          |
| #42                | `8820d9e` | 2026-10-16 22:27 | **success**: the last run that executed                         |
| #43 (attempts 1–3) | `4c38dd3` | 2026-10-17 13:07 | failure in seconds, no runner                                   |
| #44–#49            | …         | 2026-10-17/18    | failure in 2–4 s each, no runner                                |
| #50                | `9941a87` | 2026-10-18 23:28 | failure in 4 s, no runner                                       |
| #51                | `976c80d` | 2026-10-19 08:53 | failure in 4 s, no runner                                       |
| #52                | `81cfd81` | 2026-10-19 09:56 | failure in 4 s, no runner (Pass 12 check)                       |
| #53                | `99ae9c2` | 2026-10-19 11:14 | failure in 4 s, no runner (Pass 13 check)                       |
| #54                | `4ef0a26` | 2026-10-19 12:46 | failure in 5 s, no runner (Pass 14 check)                       |
| #55                | `069c2df` | 2026-10-19 14:33 | failure in 5 s, no runner (push)                                |
| #56                | `069c2df` | 2026-10-19 14:46 | failure in 8 s, no runner (manual `workflow_dispatch`, Pass 15) |

For runs #50 to #56, all four jobs ("Lint, typecheck, unit tests", "Integration, build,
e2e", "Docker image builds", "Secret scan") show the same signs:

- `started_at` and `completed_at` are 2 seconds apart;
- `runner_id: 0`, with an empty `runner_name` and `runner_group_name`;
- the check run's output (title, summary, text) is empty;
- the logs return HTTP 404, because no log was ever written;
- `get_workflow_run_usage` reports `total_ms: 0` for every job.

**Repository and workflow state (Pass 11):**

- The repository `sd343434/flexibx` is **public** and not archived or disabled.
- The `CI` workflow's state is `active`.
- The session's GitHub access has admin permission on the repository.

Two consequences:

- GitHub-hosted runner minutes are free for public repositories, so "monthly minutes
  used up" is not the cause.
- The workflow is not disabled. Repository-level Actions _permissions_ cannot be read
  through the tools available here.

**The workflow did not cause it.** Between the last green run (#42, `8820d9e`) and the
first blocked one (#43, `4c38dd3`), `.github/workflows/ci.yml` is identical. Run #43 is
the same workflow on a one-commit code change, and it was attempted three times. Later
workflow changes (the FFmpeg install, Pass 8; the worker image, Pass 10) all came after
the block began.

**Classification of the possible causes:**

| Cause                                          | Evidence                                                                                                                                            | Verdict                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| A workflow or repository error                 | Same file as the last green run; a YAML or permission error is reported as a startup failure with an annotation, never as four jobs failing in 2 s  | Ruled out                         |
| No runner available (labels, self-hosted)      | Jobs ask for `ubuntu-latest` (GitHub-hosted). An unavailable runner leaves jobs **queued**, not failed in seconds                                   | Ruled out                         |
| Minutes quota                                  | Public repository: hosted minutes are free                                                                                                          | Ruled out                         |
| Account billing lock or account restriction    | Jobs fail before a runner is assigned, with 0 billable ms on every job: the documented signature of an account that GitHub will not run Actions for | **Most likely**: owner must check |
| Actions disabled or restricted for the account | Not readable here; would show the same signature                                                                                                    | Possible: owner must check        |

The annotation that names the exact reason appears only in the GitHub web UI (the run
page, "Annotations"), not through the API this session can use.

## 2. What the owner must check (outside the repository; needs the account owner)

1. **Read the annotation:** open
   [run #56](https://github.com/sd343434/flexibx/actions/runs/39272010631), select a failed
   job, and read the message under "Annotations". It names the cause, for example "The job
   was not started because your account is locked due to a billing issue".
2. **Billing:** _Settings → Billing and licensing_ of the account `sd343434`.
   - A failed payment or an expired payment method locks Actions for the whole account,
     including public repositories.
   - Pay or replace the payment method. The lock lifts once the payment succeeds.
3. **Actions permissions:**
   - _Repository → Settings → Actions → General_: "Allow all actions and reusable
     workflows", or at least the actions this workflow uses: `actions/checkout`,
     `pnpm/action-setup`, `actions/setup-node`, `docker/setup-buildx-action`,
     `docker/build-push-action`, `actions/upload-artifact` and `gitleaks/gitleaks-action`.
   - Actions must not be disabled for the repository or the account.
4. **Account status:** a flagged or restricted account cannot start hosted runners. GitHub
   Support is the only way out (check for e-mails from GitHub).

**After the fix:** the workflow can now be started by hand (`workflow_dispatch`, Pass 11):
_Actions → CI → Run workflow_ on `claude/amazing-sagan-pvouqy`. Alternatively push any
commit, or use "Re-run all jobs" on the latest run. Confirm that the jobs show a runner name
and step logs. **Only a run whose four jobs complete green counts as CI passing.**

## 3. What was changed in the repository

- **Pass 10:** `pnpm lint` runs `next typegen` before ESLint, so a fresh checkout lints like
  CI.
- **Pass 11:**
  - **Manual trigger:** `workflow_dispatch`, for a re-run after the account fix.
  - **Integration job:** a check that the runner's `pg_dump` is version 16, then
    `scripts/ops/restore-drill.sh`. The drill runs backup → restore → verify on disposable
    databases of the service container, and must also see the failures it provokes:
    - a tampered dump;
    - a tampered manifest;
    - a missing index;
    - a guard trigger switched off before the backup.
  - **Docker job:** the worker image's own build runs `scripts/creator/check-media-tools.sh`
    (FFmpeg ≥ 6, libx264, aac, libopus, libass, ffprobe, the subtitle font, and a real
    smoke encode). The built image is checked again offline, and the job fails if the
    worker runs as root.
- **Pass 12:** the integration job also runs `scripts/staging/local-stack.sh`: a
  disposable S3-compatible bucket (SeaweedFS container, private, CORS and lifecycle set)
  and the Creator Studio acceptance suite against it (`pnpm test:acceptance`). The worker
  image's command runs `node` directly, so `docker stop` reaches the worker.
- **Pass 13:** the worker and ops images are built on Ubuntu 24.04 (FFmpeg 6.1 and the
  PostgreSQL 16 client from Ubuntu's archive, no third-party repository); the ops image's
  self-check also requires the Prisma CLI to run offline as its user; the Docker job checks
  the worker's PostgreSQL client (the staging gate needs it) and validates
  `deploy/staging/compose.yaml`.
- **Pass 14:** the job images carry only the packages their commands load
  (`scripts/docker/job-deps.mjs`, traced from the code at build time, `--verify` in each
  image); `migrate` is the ops image with its command fixed; the Docker job also loads the
  app image and enforces size budgets (`scripts/docker/check-image-size.sh`: app 500 MB,
  worker 1400 MB, ops 1250 MB).
- **Pass 15:** evidence re-collected. Run #56 was started by hand (`workflow_dispatch`)
  and failed like the push runs: the trigger does not matter. Each job's check run has an
  empty output and its log download answers 404 (the job never started); billable time
  0 ms. Nothing in the repository can change this: the workflow file parses and ran green
  before (run history), and the same jobs fail identically for every commit. The Docker
  job now also passes the commit as `GIT_SHA` (image label) and checks that the staging
  Compose file refuses to render without a release tag.
- **Nothing was weakened.** No test was skipped and no job was removed. The order stays:
  `format:check` → `typecheck` → `lint` → `test`; then migrations → integration → drill →
  build → e2e.

## 4. Local gates (what stands in the meantime)

The workflow's commands are run on disposable databases, with the counts of each pass
recorded in the readiness register:

- `prisma validate`, `phase:validate`, `format:check`, `typecheck`, `lint` and `test`;
- `prisma migrate deploy`, `test:integration` (with FFmpeg) and the restore drill;
- `build` and `e2e`;
- gitleaks over the staged change.

**Docker (Passes 11–14, local):**

- **App image** (`runner` target): built and run. It runs as uid 1001, contains no `.env`,
  keys or tests, answers liveness 200 and readiness `db: up`, and serves `/ar`; its
  healthcheck follows `PORT` (Pass 13).
- **Worker and ops images: built and run (Pass 13).** Passes 11–12 could not build them:
  their Debian `apt-get` steps needed `deb.debian.org` / `apt.postgresql.org`, which this
  environment's proxy refuses (CONNECT 403, rechecked in Pass 13; every Debian mirror
  tried is refused too). Ubuntu's archive is reachable, and Ubuntu 24.04 carries both
  FFmpeg 6.1 and the PostgreSQL 16 client, so both images now use it (no third-party
  repository; the FFmpeg is the version CI's integration job installs). Worker: the media
  check passes in the build and again offline, uid 1000, `docker stop` mid-render hands
  the job back (exit 0). Ops: `check-ops-image.sh` passes offline; migrate, backup,
  restore and verify run as its user.
- **Sizes (Pass 14, final images):** app 454 → 426 MB, worker 2.62 → 1.22 GB, ops 2.06 →
  1.08 GB, migrate ≈2.5 GB (a copy of the build stage) → 1.08 GB (the ops image). The worker
  keeps 67 of 553 store packages (112 MB of 1033 MB), ops 252 (380 MB, mostly the Prisma
  CLI). What remains in the worker is FFmpeg's own dependencies from Ubuntu (460 MB, of
  which ≈ 180 MB are Mesa/LLVM pulled in through SDL by `libavdevice`): hard package
  dependencies, kept (removing them would break the package database and security
  updates).
- The local builds add this sandbox's TLS-inspecting proxy CA in a derived Dockerfile kept
  outside the repository, and pull base images from `mirror.gcr.io` (Docker Hub
  rate-limits anonymous pulls here). Neither is in the repository.

**Not reproduced locally:** GitHub-hosted conditions (Ubuntu image, Node from `.nvmrc`, the
gitleaks action).
