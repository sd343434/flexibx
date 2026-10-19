# CI status and the GitHub Actions blocker (Passes 10–12)

**Verdict on 2026-10-19: CI is NOT verified.** Since run #43 (2026-10-17), no job of the
`CI` workflow has started. GitHub never assigned a runner, so no step ran. This is a block
at the account or repository level, not a failing test. It cannot be fixed from inside
the repository. Until a run actually executes, the project must not be described as
passing CI. The local gates (below) do not replace CI.

## 1. Evidence

Collected through the GitHub API (repository, workflow, runs, jobs, check runs and usage).

| Run                | Commit    | Created (UTC)    | Result                                    |
| ------------------ | --------- | ---------------- | ----------------------------------------- |
| #41                | `ee1e886` | 2026-10-16 21:40 | success, about 14 minutes of real work    |
| #42                | `8820d9e` | 2026-10-16 22:27 | **success**: the last run that executed   |
| #43 (attempts 1–3) | `4c38dd3` | 2026-10-17 13:07 | failure in seconds, no runner             |
| #44–#49            | …         | 2026-10-17/18    | failure in 2–4 s each, no runner          |
| #50                | `9941a87` | 2026-10-18 23:28 | failure in 4 s, no runner                 |
| #51                | `976c80d` | 2026-10-19 08:53 | failure in 4 s, no runner                 |
| #52                | `81cfd81` | 2026-10-19 09:56 | failure in 4 s, no runner (Pass 12 check) |

For runs #50 to #52, all four jobs ("Lint, typecheck, unit tests", "Integration, build,
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
   [run #51](https://github.com/sd343434/flexibx/actions/runs/39226055526), select a failed
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

**Docker (Pass 11, local):**

- **App image** (`runner` target): built and run. It runs as uid 1001, contains no `.env`,
  keys or tests, answers liveness 200 and readiness `db: up`, and serves `/ar`.
  - The local build needed this sandbox's TLS-inspecting proxy CA added to Node in a
    derived Dockerfile kept outside the repository. Base images came from
    `mirror.gcr.io`, because Docker Hub rate-limits anonymous pulls here.
- **Worker and ops images:** NOT built (rechecked in Pass 12). Their `apt-get` steps need
  `deb.debian.org` (and `apt.postgresql.org` for the ops image); this environment's proxy
  refuses the CONNECT with HTTP 403. They are built only by CI, once it runs, or in an
  environment whose network policy allows those two hosts.

**Not reproduced locally:** GitHub-hosted conditions (Ubuntu image, Node from `.nvmrc`, the
gitleaks action).
