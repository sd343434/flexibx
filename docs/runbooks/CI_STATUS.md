# CI status and the GitHub Actions blocker (Pass 10)

**Verdict on 2026-10-19: CI is NOT verified.** Since run #43 (2026-10-17), no job of the
`CI` workflow has started. GitHub never assigned a runner, so no step ran. This is a block
at the account or repository level, not a failing test. It cannot be fixed from inside
the repository. Until a run actually executes, the project must not be described as
passing CI. The local gates (below) do not replace CI.

## 1. Evidence

Collected through the GitHub API (Actions runs, jobs, check runs and usage).

| Run                | Commit    | Created (UTC)    | Result                                  |
| ------------------ | --------- | ---------------- | --------------------------------------- |
| #41                | `ee1e886` | 2026-10-16 21:40 | success, about 14 minutes of real work  |
| #42                | `8820d9e` | 2026-10-16 22:27 | **success**: the last run that executed |
| #43 (attempts 1–3) | `4c38dd3` | 2026-10-17 13:07 | failure in seconds, no runner           |
| #44–#49            | …         | 2026-10-17/18    | failure in 2–4 s each, no runner        |
| #50                | `9941a87` | 2026-10-18 23:28 | failure in 4 s, no runner               |

For run #50, all four jobs ("Lint, typecheck, unit tests", "Integration, build, e2e",
"Docker image builds", "Secret scan") show the same signs:

- `started_at` and `completed_at` are 2 seconds apart;
- `runner_id: 0`, with an empty `runner_name` and `runner_group_name`;
- the check run's output (title, summary, text) is empty;
- the logs return HTTP 404, because no log was ever written;
- `get_workflow_run_usage` reports `total_ms: 0` for every job.

**The workflow did not cause it.** Between the last green run (#42, `8820d9e`) and the
first blocked one (#43, `4c38dd3`), `.github/workflows/ci.yml` is identical. Run #43 is
the same workflow on a one-commit code change, and it was attempted three times. The
only later workflow change (the FFmpeg install step, Pass 8) came after the block began.

A job that fails before any step runs, with no runner and zero billable time, is
what GitHub does when Actions cannot be billed or is not allowed for the repository. The
annotation that names the exact reason is shown only in the GitHub web UI (the run page),
not through the API this session can use.

## 2. What the owner must check (outside the repository)

On the run page of any recent run, open a failed job and read the annotation; it names the
reason. Then check, in this order:

1. **Billing and spending limit:** _Settings → Billing and plans_ of the account
   `sd343434`, or of the organization if the repository moves.
   - a failed payment, or an expired card;
   - an Actions spending limit of $0 once the free minutes of a private repository are
     used up;
   - the month's included minutes exhausted.
2. **Actions permissions:** _Repository → Settings → Actions → General_.
   - "Allow all actions", or at least the actions this workflow uses:
     `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`,
     `docker/setup-buildx-action`, `docker/build-push-action`,
     `actions/upload-artifact` and `gitleaks/gitleaks-action`.
   - Actions must not be disabled for the repository.
3. **Account status:** a flagged or restricted account cannot start hosted runners.
   GitHub support is the only way out.
4. **Runner labels:** the jobs ask for `ubuntu-latest` (GitHub-hosted). Nothing in the
   repository requests self-hosted runners.

**After the fix:** push any commit, or use "Re-run all jobs" on run #50, and confirm
that the jobs show a runner name and step logs. Only a run whose four jobs complete
green counts as CI passing.

## 3. What was changed in the repository (Pass 10)

- `pnpm lint` now runs `next typegen` before ESLint. On a fresh checkout,
  `src/i18n/request.ts` imports `next/root-params`, whose types Next.js generates;
  without them, ESLint reported two `no-unsafe-*` errors. CI was not affected, because
  it runs `typecheck` (which also generates them) before `lint`. A contributor running
  `pnpm lint` first now gets the same result as CI.
- The workflow itself was not changed: its order (`format:check` → `typecheck` → `lint` →
  `test`; then migrations → integration → build → e2e) is correct, and no test was
  skipped or weakened.

## 4. Local gates (what stands in the meantime)

The exact commands of the workflow, run on disposable databases: `prisma validate`,
`phase:validate`, `format:check`, `typecheck`, `lint`, `test`, `prisma migrate deploy`,
`test:integration` (with FFmpeg), `build` and `e2e`, plus gitleaks over the staged
change. The counts of each pass are recorded in the readiness register.

Not reproduced locally:

- **The Docker image builds:** no Docker daemon in this environment.
- **GitHub-hosted conditions:** Ubuntu image, Node from `.nvmrc`, the gitleaks action.
