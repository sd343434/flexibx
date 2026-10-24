# FFmpeg isolation — the media runner (Pass 42, 2026-10-24)

**Status: implemented and tested locally** (unit, integration, mutation, container cycle on
the release images). Not deployed anywhere: no hosted staging exists yet, nothing pushed.
This is option **D** of `FFMPEG_RISK_DECISION.md` § 4. It limits what a compromised FFmpeg
can reach; it does **not** fix a single CVE (§ 6).

## 1. The problem it removes

The worker holds every credential the Creator Studio needs (`DATABASE_URL`, `AUTH_SECRET`,
`ENCRYPTION_KEY`, the S3 keys, the cron secrets). Until Pass 42 FFmpeg ran inside that
container. Giving FFmpeg a minimal environment was not enough: any process of the same user
in the same container reads `/proc/<worker pid>/environ`. Measured on the Pass 41 images: a
process spawned by the worker read the names `AUTH_SECRET`, `AUTOMATION_CRON_SECRET`,
`DATABASE_URL`, `ENCRYPTION_KEY`, `OPS_STATUS_SECRET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `VIDEO_RETENTION_CRON_SECRET` (and their values). FFmpeg parses
customer files and carries 65 open CVEs, one of them reachable with no fix anywhere
(CVE-2025-25467, libx264).

## 2. Design

```
 worker container (credentials, network)            media container (no credentials, no network)
 ┌──────────────────────────────────────┐           ┌──────────────────────────────────────────┐
 │ jobs.ts → media.ts → runner-client   │  HTTP     │ media-runner.ts: schema + policy check    │
 │   writes source.bin under /work/job  │──over────▶│   → runMediaTool → ffmpeg / ffprobe       │
 │   reads clip.mp4 back               │  /work/.media-runner/runner.sock (0600)              │
 └──────────────────────────────────────┘           └──────────────────────────────────────────┘
                 └────────────── shared volume `work` (/work) only ──────────────┘
```

- **One image, two commands.** `media` runs the worker image with
  `scripts/creator/media-runner.ts`; no new image, no new build, the same FFmpeg that the
  release checks verify.
- **What `media` gets** (`deploy/staging/compose.yaml`, asserted by
  `scripts/staging/check-compose-credentials.sh`, a CI step): no `env_file`; only
  `MEDIA_RUNNER_LISTEN`, `MEDIA_RUNNER_WORK_ROOT`, `MEDIA_RUNNER_CONCURRENCY`;
  `network_mode: none`; `read_only: true` with a 64 MB `/tmp` tmpfs; no capability,
  `no-new-privileges`, default seccomp/AppArmor; PID cap 256, 2 GB memory without swap, 2
  CPUs; its own PID and IPC namespaces; the `work` volume and nothing else (no Docker socket,
  no host path). User `node` (uid 1000), like the worker, so both can use the job files.
- **The runner refuses to start** (exit 78, variable names logged, never values) when its
  environment holds anything that looks like a credential (`runner-env.ts`: `DATABASE`,
  `SECRET`, `KEY`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, `AWS_*`, `S3_*`, `PG*`, `*_URL`, …).
  A misconfiguration that gives it the worker's env file stops it instead of exposing them.
- **The runner re-checks every request** (`runner-protocol.ts`) — never trusting the worker:
  an allowlist of the exact options the worker builds, with the expected value shapes;
  `-f` only among the pinned formats (`mov`, `matroska`, `mp3`, `wav`, `ogg` — never
  `lavfi`, `concat`, `hls`); `-vf` only the worker's own crop/scale/subtitles chain, the
  subtitles file only `subtitles.srt` in the job directory; `-protocol_whitelist file`
  exactly once; every input and output a `file:` path inside `/work` (no `..`, `/proc`,
  device or URL); `cwd` inside `/work`; build queries (`-version`, `-encoders`,
  `-filters`) only as exactly those. Timeout ≤ 6 h, stdout ≤ 4 MB, request ≤ 256 KB,
  2 runs at a time.
- **Kills on disconnect.** The worker's abort (job cancelled, lease lost, SIGTERM) closes the
  request; the runner kills FFmpeg (SIGKILL). The run's own timeout kills it too.
- **No fallback, three ways.**
  1. `runMediaTool` (the local spawn) refuses whenever `CREATOR_MEDIA_RUNNER_SOCKET` is set.
  2. A worker with `NODE_ENV=production` and no `CREATOR_MEDIA_RUNNER_SOCKET` refuses to
     start; the preflight fails `media_isolation` the same way.
  3. While the runner does not answer `/health`, the worker claims no job (no attempt is
     spent), logs the transition once and reports the failed phase `media_runner` in its
     heartbeat. A runner lost mid-job fails the step as `unavailable` →
     `ffmpeg_failed`, **retryable** (not a customer-file error).
- **Development and tests** keep the local path (no socket set). In production the local
  path is unreachable by construction.

## 3. Alternatives considered

| Option                                                                          | Why not                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Strip FFmpeg's environment only                                                 | Already done since Pass 8; does not stop `/proc/<pid>/environ` (measured)                                                                  |
| FFmpeg as another uid in the worker container                                   | Needs `CAP_SETUID`/a setuid helper — contradicts `cap_drop: ALL` and `no-new-privileges`; same network and filesystem                      |
| `unshare`/bubblewrap/nsjail inside the worker                                   | Needs user namespaces, blocked by Docker's default seccomp profile (which we keep on); would mean `seccomp=unconfined` or extra privileges |
| Secrets through files read once, then environment cleared                       | `/proc/1/environ` keeps the initial environment; files stay readable by the same uid                                                       |
| A separate media **service** with its own queue/storage access                  | Needs its own S3 credentials (moves the problem), a queue protocol, more code and operations                                               |
| **A separate container, no credentials, socket on the scratch volume (chosen)** | Smallest change that is provably credential-free: same image, one Compose service, one socket, files already on a shared volume            |

## 4. What was proven (local, synthetic secrets)

Unit (`tests/unit/media-runner-policy.test.ts`): every command the worker builds (15
captured from `media.ts`) passes the policy; 29 hostile argument lists are refused with the
expected reason; credential names are found and values never printed; the local path
refuses and spawns nothing; `unavailable` is retryable; preflight fails in production
without a runner.

Integration with real FFmpeg (`tests/integration/media-runner.test.ts`, 8 tests): socket
mode 0600; probe → render with Arabic subtitles → verify through the runner; a file outside
`/work` and a network URL refused, nothing written; a damaged file fails as a failed run; a
timeout and an abort kill FFmpeg (no child left); FFmpeg's environment and the runner's
own (`/proc/$PPID/environ`) carry no credential name; a runner given `DATABASE_URL` and
`AUTH_SECRET` exits 78 naming them without their values; a runner that is down is
`unavailable`. Worker loop (`creator-operations.test.ts`): a queued job stays queued with
0 attempts while the runner is down, `media_runner` in the heartbeat, then runs once it
answers.

Mutation testing: 19 mutants on the policy, the local guard, the env refusal, the runner
(policy re-check, disconnect kill, socket mode), the client, the preflight, the worker gate
and the failure classification — **19 killed**.

Container cycle on the release images: `LAUNCH_HARDENING_PASS_42.md` § 4.

## 5. Cost, performance, operations

- **Cost:** none — no new service to pay for, no new image to build or scan; the same host.
  Memory budget: the runner holds FFmpeg's memory (2 GB cap); the worker no longer does.
- **Performance** (this sandbox, median): ffprobe 64 → 67 ms; a 10 s 720p→9:16 render 1358
  → 1406 ms (within run-to-run noise). One local socket round trip per FFmpeg run.
- **Operations:** one more long-running service (`media`); the worker starts only once it is
  healthy (`depends_on: service_healthy`), and `up -d app worker scheduler` starts it.
  Logs: JSON lines (`flexibx-media-runner`): refusals with the reason, failed runs with the
  code — never arguments' contents beyond the reason, never environment values. Alert: the
  existing worker heartbeat (`failedPhases` contains `media_runner`) — add it to the alert
  rules when the alert destination (R-7) is chosen.
- **Rollback:** previous image tag as usual (`up -d --remove-orphans` stops `media`); a
  pre-Pass-42 worker runs FFmpeg locally again (the old exposure returns).

## 6. What remains (honest residual risk)

- **No CVE is fixed.** The 65 FFmpeg CVEs (61 fixed only in Ubuntu Pro ESM, 4 deferred) are
  still in the image. Ubuntu Pro (option A) is complementary and needs the owner's approval.
- **Integrity, not secrecy:** a compromised FFmpeg can read and alter other jobs' scratch
  files in `/work` (same uid, shared volume) — customer media in flight, not credentials.
  Each job's directory is mode 0700 under uid 1000, which both containers share. Closing
  this needs per-job volumes or uids (a later step, not needed for credential isolation).
- **Denial of service:** a crafted file can still burn the runner's CPU/memory up to its caps
  and timeouts; the worker's job then fails or times out as before.
- **Kernel escape** from the container is out of scope (default seccomp, no capabilities, no
  new privileges reduce it; they do not remove it).
- **Same image as the worker:** the runner container has the application's source files
  (no secrets in them — `.env`, `deploy/` and tests are not in the image; verified).
