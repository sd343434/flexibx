# Creator Studio — staging validation plan (Passes 10–15)

Status on 2026-10-19:

- **Prepared:** configuration, a preflight command, monitoring and this plan.
- **Deployable (Pass 13, § 10):** `deploy/staging/compose.yaml` runs the app, the worker and
  a scheduler from the three images, with migrate / check / backup jobs, and
  `pnpm staging:check` gates the trial. All three images were built and the whole cycle
  run in containers on one machine.
- **Run on one machine (Pass 12, § 9):** the plan against a staging-like stack. Repeatable
  with `scripts/staging/local-stack.sh`.
- **Smaller images, whole cycle re-run (Pass 14, § 11):** worker 1.22 GB and ops 1.08 GB
  (were 2.62 / 2.06 GB); the cycle re-run on them with a resumed multipart upload, burned
  subtitles, a lease left to expire on its own, a worker outage alerted while the alert
  destination refused, and measured backup / restore times.
- **Pass 15 (§ 12):** a database environment marker that `migrate` and the gate assert;
  digest-pinned base images and a required release tag; AWS infrastructure as Terraform
  (`deploy/staging/aws`, validated, not applied); a scheduling defect found on the stack
  and fixed (internal endpoints refused a steady scheduler for 10 of every 22 minutes).
- **Not executed on hosted infrastructure:** no staging environment, bucket or
  credentials exist yet (checked again in Pass 15). Nothing below has been verified
  there.

The owner must approve and provide every resource in § 1 before the trial. No paid
resource is created by this repository.

Operations runbook: [`CREATOR_STUDIO.md`](CREATOR_STUDIO.md).

## 0. Success criteria (all must hold, recorded with evidence)

| #   | Criterion                                                                                                                   | Evidence                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| S1  | `pnpm creator:preflight` passes on the worker host (no FAIL lines)                                                          | Its output, attached to the trial record          |
| S2  | Migrations applied to the staging database only, `prisma migrate status` clean, `db-verify.sh` schema objects match         | Command output                                    |
| S3  | A 300 MB+ file uploads in parts, is paused, the page reloaded, the same file picked, the upload resumes and completes       | Screen recording; `creator_source_parts` rows     |
| S4  | The worker verifies every part's SHA-256 and analyses the file (VERIFIED)                                                   | Project page; job steps                           |
| S5  | An export renders, downloads through a link that expires (≤ 15 min), and the object cannot be read without a signature      | `curl` of the bare object URL (403); link expiry  |
| S6  | A person of another workspace gets 404 for the project, the download route and the data export                              | Requests and responses                            |
| S7  | Cancel during an export, then delete the project: holds released, files removed, project purged; audit and ledger rows kept | Queries in § 6                                    |
| S8  | A storage outage during deletion (revoked key) is retried and completes after the key is restored                           | `creator_storage_deletions` attempts / completion |
| S9  | Killing the worker mid-job: ops-status warns, a new worker takes the job over after the lease, nothing is charged twice     | ops-status output; ledger                         |
| S10 | ops-status creator checks are `ok` at the end, and its output holds no names, ids, keys or text                             | ops-status JSON                                   |

**AI provider during the trial:** `CREATOR_AI_PROVIDER=disabled`, or `simulated` in a
non-production `NODE_ENV`. OpenAI is enabled only after the owner's separate decision
(§ 8 of the operations runbook). No customer media is used: the team's own synthetic or
licensed test files only.

## 1. Resources the owner provides (none exist today)

1. **Hosting for two processes:**
   - the web app (`docker build -t flexibx .`);
   - the worker (`docker build --target worker -t flexibx-worker .`): 2 vCPU, 2 GiB RAM,
     and a scratch volume of at least 3× the largest allowed source at `/work`.
   - The worker needs no inbound port. Logs go to the platform's log service.
2. **A staging PostgreSQL 16 database:** separate from any production database, with the
   roles of `DATABASE_ROLES.md`, and backups on.
3. **A private S3-compatible bucket for staging only:**
   - no public access;
   - a key limited to that bucket (Get, Put, Delete, multipart, ListMultipartUploadParts,
     and GetBucketCors / GetBucketLifecycleConfiguration for the preflight).
4. **The scheduler call** for the automation tick (alerts and ops-status), as in
   `DEPLOYMENT.md`.
5. **An alert destination** (`ALERT_WEBHOOK_URL`) and someone who receives it.
6. **Secrets** in the platform's secret store, never in images or the repository:
   `DATABASE_URL`, `S3_*`, `AUTH_SECRET`, `ENCRYPTION_KEY`, `AUTOMATION_CRON_SECRET`.

## 2. Bucket configuration

**CORS** (the browser PUTs parts and single files to signed URLs):

```json
[
  {
    "AllowedOrigins": ["https://staging.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 600
  }
]
```

Use the staging origin exactly; no `*`. Exposing `ETag` is not needed (the server lists
the parts).

**Lifecycle**, as a second line behind the worker's own clean-up:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "workspaces/" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 }
    }
  ]
}
```

**Access:** block all public access and set no bucket policy granting anonymous reads.
Downloads are signed links of at most 15 minutes (2 minutes for exports).

## 3. Deploy order

On a Docker host (any container platform runs the same five services):
`deploy/staging/compose.yaml`, environment in `deploy/staging/staging.env` (from
`staging.env.example`; git-ignored, kept in the host's secret store).

0. **Release tag:** `export FLEXIBX_TAG=<commit sha>` — required (the Compose file refuses
   to render without it); an immutable tag, never `latest` or `staging`. On AWS the image
   repositories reject a re-used tag (`deploy/staging/aws`).
1. **Images**, all from one commit: `docker compose -f deploy/staging/compose.yaml build`
   (app `runner`, `worker`, `ops`; base images pinned by digest, the commit in the
   `org.opencontainers.image.revision` label). The worker build fails by itself unless its FFmpeg
   passes `scripts/creator/check-media-tools.sh` (version 6 or later, libx264, aac, libopus,
   libass, ffprobe, the subtitle font, a real smoke encode).
2. **Database:**
   - once per database, an administrator marks it (ops image):
     `scripts/ops/db-environment.sh mark staging --confirm-database <name>`. The
     `migrate` job and the gate refuse an unmarked or differently marked database; a
     restored copy is unmarked until marked on purpose;
   - take a backup: `docker compose … run --rm backup` (copy it off the host);
   - `docker compose … run --rm migrate` (`prisma migrate deploy`, as the unprivileged
     user);
   - the gate below runs `db-verify.sh --no-row-counts` (migrations with checksums, the 502
     indexes and constraints, integrity checks including disabled guard triggers).
3. **Start:** `docker compose … up -d app worker scheduler`. The scheduler starts once the
   app is healthy and calls the tick every 2 minutes and video retention daily.
4. **Gate:** `docker compose … run --rm check` (`staging:check --send-test-alert` in the
   worker image, run by `node` — the job images carry no pnpm since Pass 36). It must print
   `STAGING CHECK PASSED`:
   - environment: required variables set and the app's own startup validation (names,
     never values);
   - database: marked `staging` (`database_environment`), then as above; media tools, scratch space, private bucket, signed links,
     multipart, CORS and lifecycle (`creator:preflight`, probe objects only, never a
     provider);
   - app readiness; ops-status: worker heartbeat, scheduler, stuck jobs, deletions,
     clean-up, disk, alert delivery; one test alert delivered.

   Exit 1 (`FAILED`) names what is wrong; exit 2 (`INCOMPLETE`) means a check could not run
   there — not a pass. Fix and run it again.

5. Run `creator:retention-report` once (ops image): starting counts, deletes nothing. The
   job images carry no pnpm (Pass 36): in them a `pnpm <script>` of package.json runs as
   `node --import tsx --import ./scripts/video-retention/register.mjs <its .ts file>`:

   ```bash
   docker run --rm --env-file staging.env <registry>/ops:<tag> node --import tsx \
     --import ./scripts/video-retention/register.mjs scripts/creator/retention-report.ts
   ```

## 4. Test script (in order; record each result)

1. **Upload, pause and resume (S3, S4):**
   - Sign in as user A (workspace A) and create a project.
   - Pick a 300 MB+ test video and pause at about 40 %.
   - Reload the page, pick the same file and resume. Only the missing parts are sent
     (watch the network panel).
   - Wait for VERIFIED.
2. **Checksum (S4):**
   - Upload a file whose parts are tampered with, using a test client that declares one
     SHA-256 and sends other bytes.
   - The source is rejected with `checksum_mismatch` and its object is removed.
3. **Export and link (S5):**
   - Make and approve a clip (manual bounds), export 9:16 and download it.
   - Copy the link and wait 3 minutes: it must fail.
   - Request the object URL without its query string: 403.
4. **Isolation (S6):** as user B (workspace B), request A's project page, the export
   download route, the subtitles route and `/studio/projects/{id}/data`. Each must be 404.
5. **Cancel, delete and clean-up (S7, S8):**
   - Start an export and cancel it while rendering.
   - Revoke the bucket key's DeleteObject permission.
   - Delete the project (type its name). The deletion rows record attempts and
     `last_error_code`.
   - After 2 or more attempts, `creator_storage_deletions_overdue` warns.
   - Restore the permission. The next sweep completes and the project is purged.
6. **Worker failure (S9):**
   - While an export renders, stop the worker container (SIGKILL).
   - `creator_jobs_lease_expired` and the worker age warn.
   - Start a new worker. After the 2-minute lease it resumes the job.
   - Check the ledger: one capture for that export.
7. **Disk (S9):** run the worker with a scratch volume smaller than 2× the largest source
   plus 256 MiB. `creator_worker_disk_low` is critical, and a job fails with
   `worker_disk_full` (retried), not with a full disk.
8. **Monitoring payload (S10):** save the `ops-status` JSON and grep it for the project
   name, file name, user e-mail and storage key prefix. None may appear.

## 5. Watching the trial

- `GET /api/internal/ops-status` (bearer secret): every check named in the operations
  runbook § 10, plus `alert_delivery_failed`. A warning there means the alert webhook
  refused deliveries.
- Worker logs: job ids, failure codes, durations, free-disk numbers. Never text, file
  names or keys (tested in `creator-operations.test.ts`).

## 6. Evidence queries (staging database, read only)

```sql
-- S7: holds of the deleted project's jobs are released or captured, never HELD
SELECT status, count(*) FROM credit_holds WHERE feature LIKE 'creator_%' GROUP BY status;
-- S7/S8: the deletion record (keys only) and its attempts
SELECT reason, attempts, last_error_code, completed_at IS NOT NULL AS done
FROM creator_storage_deletions ORDER BY created_at DESC LIMIT 20;
-- S7: audit kept after the purge
SELECT action, created_at FROM audit_logs
WHERE action LIKE 'creator.project_%' ORDER BY created_at DESC LIMIT 10;
```

## 7. Rollback and recovery

- **App or worker misbehaves:** scale the worker to 0. Queued jobs wait, and running jobs
  are taken over when a worker returns (leases). Roll the web app back to the previous
  image: images are tagged per release (`FLEXIBX_TAG`); set the previous tag and run
  `docker compose … up -d app worker scheduler` (no database change, migrations being
  backward-compatible: DEPLOYMENT.md § 1).
- **A migration must be undone:** migrations are forward-only. Restore the pre-deploy
  backup into a NEW database (`BACKUP_RESTORE.md`), verify it, then switch
  `DATABASE_URL`. Never restore over the live staging database.
- **Bucket misconfigured** (public reads found): block public access first, then rotate
  the bucket key. Probe and test objects are removed with their projects. The preflight's
  own probes are removed by the preflight itself.
- **End of the trial:** delete the test projects through the app (this exercises the
  deletion path), then run `creator:retention-report` and record the final counts.

## 8. After the trial

Record the results against S1–S10 in the readiness register (`PRODUCTION_READINESS_GAPS.md`
§ 15). An item moves from "prepared" to "verified on staging" only with its evidence. A
production launch still needs the decisions listed there: hosting, data region, the AI
provider, retention, and CI running again.

## 9. Pass 12: the plan run on one machine (staging-like)

What ran (2026-10-19), all local, synthetic media only, no AI provider, no paid resource:

- **Database:** a separate PostgreSQL 16 database, migrated from empty
  (`prisma migrate deploy`; `migrate status` clean; `migrate diff` empty).
- **Bucket:** SeaweedFS in Docker on 127.0.0.1, one identity limited to the bucket, no
  anonymous access, CORS and lifecycle rules of § 2 applied and read back.
- **Web app:** `pnpm build` with `NODE_ENV=production`, run as the standalone server.
  Mail used `MAIL_TRANSPORT=test-outbox` with `FLEXIBX_TEST_PROVIDERS=allow`, which the
  app honours only while `APP_URL` is local; a hosted staging needs `resend` (owner).
- **Worker:** a separate process started with the image's command (`node` as PID 1).
- **Scheduler and alerts:** the tick and ops-status endpoints called with their secrets; a
  local receiver as `ALERT_WEBHOOK_URL` (plain http is accepted only for this machine).

| #   | Result on the staging-like stack                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `pnpm creator:preflight`: PREFLIGHT PASSED, 15 checks (FFmpeg 6, scratch, private bucket, 120 s links, multipart, CORS, lifecycle)     |
| S2  | Migrations from empty; status clean; diff empty. Restore drill: DRILL PASSED (14 checks)                                               |
| S3  | Multipart upload cut off mid-part, then resumed: only missing parts sent (acceptance suite, 3 × 5 MiB parts). 300 MB+ by hand: not run |
| S4  | Every part's SHA-256 verified, file VERIFIED; a part with a wrong hash rejected (`checksum_mismatch`) and removed from the bucket      |
| S5  | Export through the app: 303 → 120 s link, 200; bare object URL 403; tampered and expired links 403                                     |
| S6  | Another account: export and data routes 404; no session: 401; services refuse every cross-workspace call                               |
| S7  | Cancel + retry and delete: holds released or captured once; bucket empty under the workspace prefix; project purged; audit kept        |
| S8  | Revoked key: deletions stay open with attempts and an error code; after the key works again they complete and the project is purged    |
| S9  | SIGTERM mid-render: FFmpeg killed, job handed back, next worker completes it, one capture. Low disk: ops-status 503 and critical alert |
| S10 | ops-status creator checks ok at the end; ops-status, alerts and worker/app logs hold no names, file names, keys, links or e-mails      |

**Repeat it:** `TEST_DATABASE_URL=… scripts/staging/local-stack.sh` runs the bucket part
(S3–S8, S10 for the services) in about a minute and removes its container. CI runs the same
script. The HTTP, worker-process and alert parts above were driven by hand.

**Still for hosted staging:** the owner's resources (§ 1), a real alert destination, a
300 MB+ browser upload with pause and reload (S3), transcription with the provider the
owner approves (the simulator is refused in production by design), and the worker image
built by CI.

## 10. Pass 13: the deployment path run in containers

What ran (2026-10-19), all on one machine, synthetic media only, no AI provider, no paid
resource. "Hosted" is still not proven: these are the production images and the Compose
file, not the owner's infrastructure.

- **Images:** app (454 MB), worker (2.6 GB) and ops (2.1 GB) built from one commit. The
  worker build ran the media check itself (FFmpeg 6.1.1, libx264, aac, libopus,
  subtitles, smoke encode); worker and ops run as uid 1000, contain no `.env`, keys, tests
  or Next.js output; the ops image's own check passes offline.
- **Gate:** before deployment it FAILED as it should (empty database, no app); after
  migrate + start: `STAGING CHECK PASSED`, 33 checks, test alert delivered — also through
  `docker compose run --rm check`.
- **Database through the ops image:** migrate as the unprivileged user; `db-verify`
  VERIFIED (37 migrations, 502 objects); backup → restore into a new database → verify
  with the manifest: VERIFIED.
- **Cycle against the containers:** two accounts signed up through the pages of the app
  container; upload by signed URL; worker container verified and rendered; owner
  download 303 → 200 (720×1280, 4.0 s), bare object 403, other account 404, no session 401.
- **Worker stops:** `docker stop` while FFmpeg rendered: 0.15 s, exit 0, job handed back
  (QUEUED, attempt not counted, hold released), finished after restart, one capture.
  `docker kill` (SIGKILL) mid-render: the job kept its lease; once the lease ran out a new
  worker took it over (attempt 2), one capture. ops-status flags a lease only 15 minutes
  past expiry (by design; covered by the integration tests), which this run did not wait
  for.
- **Alerts:** destination refusing → tick still 200 in 0.2 s, `alert_delivery_failed`;
  destination back → redelivered, warning cleared.
- **Restarts:** app and worker restarted → readiness 200, heartbeat fresh, ops-status ok.
- **Deletion:** the worker container's sweep removed all 6 objects; project purged; audit
  kept. Container logs, alerts and gate output: no names, keys, links or e-mails.
- **Compose itself:** `migrate`, `up` (app healthy in 6 s, scheduler tick and retention
  200), `check` PASSED, `backup` OK, `stop` → worker exit 0.

**Defects found and fixed in this pass:** the ops image could not run `prisma migrate` as
its user (schema engine for its OpenSSL missing; now fetched at build time and checked by
`check-ops-image.sh`); the app healthcheck ignored `PORT`; the scheduler started before the
app was healthy.

**Local-only adjustments (not in the repository):** the sandbox's TLS proxy CA in a derived
Dockerfile, base images from `mirror.gcr.io`, host networking for a database and bucket on
127.0.0.1, and SeaweedFS with small volumes (this session's disk). The test mail outbox
(`FLEXIBX_TEST_PROVIDERS=allow`, local `APP_URL` only) stood in for a mail provider.

## 11. Pass 14: smaller images, the cycle again, hosted launch still blocked

Run on 2026-10-19 on one machine, from the Pass 14 images and `deploy/staging/compose.yaml`
(local override: host networking for a database and bucket on 127.0.0.1). Synthetic media
only; no AI provider was called; nothing paid was created.

**Hosted launch: not possible in this pass.** Checked before starting:

- no hosting credentials in the session (the AWS variables present are placeholders of the
  session's proxy; gcloud has no account);
- the connected Vercel account has no Flexibx project; the Supabase projects belong to
  another product (`fofify`, `fofify-staging`) and were not touched;
- D-2 (AWS) is decided, but no account, database, bucket or secrets were provided.

What the owner provides to launch it is § 1; the launch itself is § 3 (Compose on a host,
or the same five services on a container platform).

**Images (final, measured):**

| Image   | Pass 13 | Pass 14 | Budget (CI) | Notes                                                                                         |
| ------- | ------- | ------- | ----------- | --------------------------------------------------------------------------------------------- |
| app     | 454 MB  | 426 MB  | 500 MB      | musl builds of sharp's libvips dropped (glibc image)                                          |
| worker  | 2.62 GB | 1.22 GB | 1400 MB     | 67 of 553 packages (112 MB); FFmpeg's Ubuntu dependencies are 460 MB of the rest              |
| ops     | 2.06 GB | 1.08 GB | 1250 MB     | 252 packages (380 MB, mostly the Prisma CLI); no npm, no headers                              |
| migrate | ≈2.5 GB | 1.08 GB | —           | now the ops image with `prisma migrate deploy` as its command (was a copy of the build stage) |

How: `scripts/docker/job-deps.mjs` traces, with esbuild, every package the job commands
load (through the app's code into node_modules) and copies only those, with their regular
dependencies, from the lockfile's install; the CLIs that run commands (tsx, Prisma) keep
their full closure. Each image runs `--verify` in its own build. Kept on purpose: ≈ 180 MB
of Mesa/LLVM that Ubuntu's FFmpeg needs through SDL (`libavdevice`) — hard package
dependencies; removing them by force would break the package database and security
updates. A static FFmpeg build would drop them: a supply-chain decision for the owner.

Every image: uid 1000/1001, no `.env` (only `.env.example`), no keys, dumps, media,
tests, `.next` or docs; ops self-check passes offline; every documented command ran
against the staging database (migrate, migrate status, tick, retention, retention report,
`admin:mfa-reset` → `NOT_FOUND`, `admin:grant` refusing a code on the command line).

**Gate:** before migrating: FAILED (database, preflight, app, ops-status). After deploy with
the simulator configured: FAILED on `preflight.ai_provider` only — the simulator can never
pass a staging gate. After recreating app and worker with `CREATOR_AI_PROVIDER=disabled`:
`STAGING CHECK PASSED`, 33 checks, test alert delivered.

**Cycle (against the containers):**

| Step                                       | Result                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts                                   | Two accounts signed up and in through the pages of the app container                                                                                                                                                              |
| Multipart upload, 47.7 MiB, 3 parts        | Part 2 cut off half way; completing refused (`CONFLICT`); storage reported `[1]`; parts 2–3 resumed; worker verified size, file and per-part SHA-256                                                                              |
| Analysis (worker container)                | 1280×720 H.264 + audio, 12.0 s, in 2 s                                                                                                                                                                                            |
| Transcript                                 | Declared simulator (`simulated=true`, local stack only)                                                                                                                                                                           |
| Export, 9:16 with burned subtitles         | 720×1280 H.264 + AAC 48 kHz, 8.000 s; subtitle band 10 552 near-white pixels vs 39 in the source; SRT/VTT served                                                                                                                  |
| Access                                     | Owner: download 303 → signed link 200. Bare object 403, tampered signature 403. Other account 404 everywhere; no session 401; PUT to upload routes 404                                                                            |
| `docker stop` mid-render                   | 0.45 s, exit 0; job handed back (QUEUED, attempt not counted, hold released); finished after restart; one capture                                                                                                                 |
| SIGKILL mid-render, lease left alone       | Job RUNNING with its lease until 13:19:29; ops-status `ok` until 15 min past it; at 13:35:20 the tick alerted `creator_jobs_lease_expired` (critical); new worker took over (attempt 2) and finished; one capture; next tick `ok` |
| Worker outage + alert destination refusing | With a job waiting: stale-worker alert at 14:04 refused (500), tick unaffected, `alert_delivery_failed`; destination back → both alerts delivered at 14:06, warning cleared; worker back → waiting export done in 41 s, `ok`      |
| Restarts                                   | App, worker and scheduler recreated: healthy in 6 s, readiness 200, gate PASSED                                                                                                                                                   |
| Deletion                                   | 5 objects queued → bucket empty (no open uploads), no rows left, audit kept (`created`, `deletion_requested`, `purged`)                                                                                                           |
| Logs                                       | App, worker, scheduler, alerts, gate output: no names, keys, signed links, e-mails, transcript text or bearer tokens                                                                                                              |

Note: a stopped worker with nothing queued is not alerted, by design
(`creator_worker_last_seen_age_seconds` is a warning only while jobs wait); the first job
to arrive raises it at the next tick, because the heartbeat is already stale.

**Backup / restore** through the ops image: backup 0.6 s, restore into a new database
1.1 s, verify 1.1 s (`VERIFIED`; same 132 triggers, 300 indexes, 356 constraints); drill
PASSED. Throughput on a 1.08 GB synthetic database: dump 32 s, restore 20.5 s. RTO / RPO:
`BACKUP_RESTORE.md` § 8.

## 12. Pass 15: hardening the path, a scheduling defect fixed, the cycle again

Local again (2026-10-19, one machine, Compose with the local override, synthetic media,
declared simulator, no paid resource). **Not hosted:** no credentials or approved
resources exist (checked: the session's AWS variables are proxy placeholders, gcloud has
no account; nothing was created in any account).

**Deployment path:**

- `scripts/ops/db-environment.sh` marks a database (`flexibx-environment=staging`, its
  comment) and asserts it. The `migrate` job asserts before migrating; the gate has a new
  first database check, `database_environment`. Verified: migrate on an unmarked database
  → exit 1 (`database … is unmarked, expected staging`); gate FAILED on the same; after
  marking, migrate applied all 37 migrations in 3.2 s. pg_dump does not keep the marker, so
  a restored copy must be marked deliberately (verified).
- Base images pinned by digest; `FLEXIBX_TAG` required (Compose refuses to render
  without it); the commit as an OCI label on every runtime image; `deploy/` kept out of
  the images.
- `deploy/staging/aws` (Terraform): host, RDS PostgreSQL 16 with 7-day PITR, private
  bucket, ECR (immutable tags), Secrets Manager container, scoped IAM. `terraform validate`
  passes (provider 6.69.1); never applied. Owner inputs: its README.

**Defect found and fixed — internal endpoints refused a steady scheduler.** On this stack
the scheduler's tick answered 429 for 10-minute stretches (15:13–15:21, 15:34–15:40),
so no recovery and no alerts ran; a worker outage with a job waiting went unalerted.
Cause: Better Auth's limiter resets a count only after `window` seconds without an
allowed request, so any caller steadier than one call per window gets `max` calls and is
then refused until it pauses (not a rolling window). It hit `automation-tick`,
`video-retention` and `ops-status` (an uptime monitor polling every minute would have been
refused for 10 minutes every hour). Fix: those three buckets count in fixed windows (two
alternating keys by window parity — `fixedWindowSlot`), same approved limits, two stored
rows per bucket. Integration tests (real limiter and database, faked clock): 45 minutes of
once-a-minute calls never refused, still 12 per window, Better Auth's rule documented on
an unchanged bucket; both mutants killed. Live after redeploy: 30 consecutive ticks, all 200.

**Cycle on the Pass 15 images:**

| Step                                          | Result                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts                                      | Two accounts through the app container's pages                                                                                                                                     |
| Multipart 47.7 MiB, 3 parts                   | Part 2 cut off; completing refused (`CONFLICT`); storage reported `[1]`; resumed; size, file and per-part SHA-256 verified by the worker                                           |
| Analysis, transcript, export                  | 1280×720 H.264 + audio, 12 s; declared simulator; 720×1280 H.264 + AAC, 8.000 s, subtitles burned (10 552 vs 39 pixels)                                                            |
| Access                                        | Owner 303 → 200; bare object, tampered signature, tampered expiry 403; other account 404; no session 401; upload PUT 404 for both                                                  |
| `docker stop` mid-render                      | 446 ms, exit 0; handed back (attempt not counted, hold released); finished after restart                                                                                           |
| SIGKILL, lease left alone                     | Lease ended 15:06:14; alert `creator_jobs_lease_expired` delivered 15:22:11; takeover (attempt 2); next tick `ok`                                                                  |
| Outage + refusing destination (after the fix) | Stale-worker alert refused (500) at 16:11:40, tick unaffected, `alert_delivery_failed`; delivered at 16:13:40 after recovery; waiting export done 8 s after the worker returned    |
| Charges                                       | 5 exports → 5 captures, 2 releases (the handed-back and the killed attempts): none twice                                                                                           |
| Deletion                                      | 6 objects → bucket empty, no rows left, audit kept                                                                                                                                 |
| Restart, gate                                 | Recreated with `CREATOR_AI_PROVIDER=disabled`: healthy in 7 s; `STAGING CHECK PASSED`, 34 checks, test alert delivered. With the simulator: FAILED on `preflight.ai_provider` only |
| Logs                                          | App, worker, scheduler, alerts, gate output: nothing sensitive                                                                                                                     |

Backup / restore at 1 GB on the real schema: BACKUP_RESTORE.md § 9.

## 13. Pass 16: release hardening, the cycle again, a backup-job defect fixed

Local again (2026-10-19, one machine, Compose with the local override, SeaweedFS as the
bucket, synthetic media, **declared simulator** for the transcript; no paid resource).
**Not hosted:** no credentials or approved resources exist; nothing was created. What
the owner must decide first: RELEASE_READINESS_DECISIONS.md. Restoring the service after
an incident: SERVICE_RESTORE.md.

**Defect found and fixed — the Compose `backup` job could not write its volume.** On a
fresh host the `backups` named volume is created owned by root, and the ops image runs as
`node`: `mkdir: cannot create directory '/backups/staging': Permission denied`, exit 1.
Pass 15 had measured backups by running the script directly, so the job itself had never
run. Fix: the ops image creates `/backups` owned by `node`, mode 700 (a new named volume
takes the directory's owner); the ops-image self-check now fails when `/backups` is not
writable (it failed on the old image, passes on the new one). After the fix the job wrote
the dump, manifest and checksums, files mode 600, directories 700.

**Hardening in this pass:** container logs rotate (json-file, 10 MB × 5 per service, in
Compose and in the host's Docker daemon); the worker and ops images no longer carry the
development-process state file (`.phase-status.json`) — the ops-image self-check refuses
`.git`, `deploy`, agent state and Terraform state; the Terraform audit
(deploy/staging/aws/README.md § Audit).

**Cycle on the Pass 16 images** (app 426 MB, worker 1.22 GB, ops 1.08 GB; app runs as
`flexibx`, worker and ops as `node`; label `revision` set):

| #   | Step                                | Result                                                                                                                                                                                                                                           |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–2 | Images                              | Built; non-root; no `.env`, credentials, `.git`, `deploy/` or agent state in them (self-check + listing); media tools check OK                                                                                                                   |
| 3   | Migrate on an unmarked database     | Refused, exit 1. Compose also refuses to render without `FLEXIBX_TAG`                                                                                                                                                                            |
| 4   | Mark, migrate                       | `MARKED`; 37 migrations in 4.4 s                                                                                                                                                                                                                 |
| 5   | App, worker, scheduler, gate        | App healthy in 6 s; gate FAILED only on `preflight.ai_provider` while the simulator was configured (by design)                                                                                                                                   |
| 6   | Multipart upload 154 MiB, 10 parts  | Part 2 cut off; completing refused (`CONFLICT`); storage reported `[1]`; parts 2–10 resumed; size and SHA-256 of the file and of every part verified by the worker (VERIFIED in 5 s)                                                             |
| 7   | Transcript, export                  | Transcript from the **simulator** (stored `simulated = true`); export 720×1280 H.264 + AAC 48 kHz, 8.000 s, subtitles burned (17 547 bright pixels in the subtitle band)                                                                         |
| 8   | Access and signed links             | Owner 303 → signed link 200; other account 404; no session 401; unsigned object, tampered signature, same signature on another key, and the link after its 120 s expiry: all 403                                                                 |
| 9   | SIGKILL mid-render, no restart      | Lease ended on its own (2 min); takeover after the worker returned (attempt 2); export READY; one hold captured for that step — the ledger moved by exactly the two exports' price                                                               |
| 10  | Outage + refusing alert destination | ~14 min without a worker, one export waiting: `creator_worker_last_seen_age_seconds` alerts offered and refused (500), `alert_delivery_failed` raised; destination back → both delivered (200); worker back → both exports READY; next tick `ok` |
| 11  | Project deletion                    | 4 objects → bucket empty; no source, export or transcript rows left; audit (`project_created`, `deletion_requested`, `purged`) and the ledger kept                                                                                               |
| 12  | Backup → restore → verify           | `backup` job (after the fix) 0.76 s; restore into a **separate** database 1.1 s; `VERIFIED` 1.2 s (77 tables, 502 schema objects, 37 migrations); migrate refused on the unmarked copy, accepted after marking; same counts as the source        |
| 13  | Logs                                | App, worker, scheduler, alerts, gate and cycle output: no secret, signed URL, storage key, e-mail or customer text; no error-level line. Scheduler: 27 ticks, all 200, none 429                                                                  |
| —   | Final gate                          | Recreated with `CREATOR_AI_PROVIDER=disabled`: `STAGING CHECK PASSED`, 34 checks, 0 failed, 0 not run, test alert delivered                                                                                                                      |

Local stack torn down afterwards (containers, volumes, bucket, databases, throwaway role
and the generated secrets removed).

## 14. Pass 17: what changed in the images

- **App image on Ubuntu 24.04** (the job images' base) with only the `node` binary of the
  pinned Node image: no npm, npx or corepack. Their bundled packages were 14 of the app
  image's HIGH/CRITICAL scanner findings; Debian's OS packages were most of the rest.
  389 MB (was 426). Verified: healthy, runs as `flexibx`, readiness 200 against a
  PostgreSQL 16 database, `/en` and `/ar/sign-in` 200.
- **Security updates at build:** every Ubuntu stage runs `apt-get upgrade` from Ubuntu's
  signed archive (the base stays pinned by digest).
- **pnpm 10.34.6** (was 10.28.0; same major and lockfile; fixes the advisories reported
  against 10.28.0) — the copy in the worker and ops images runs offline.
- **Checks every build:** `scripts/docker/check-image-contents.sh` and
  `scripts/docker/scan-images.sh` (Trivy, pinned by digest), in CI's Docker job.
  The Pass 17 images: 0 fixable HIGH/CRITICAL findings (details: RELEASE_READINESS_DECISIONS.md R-9).

## 15. Pass 18: the gate on the release images

pnpm 10.34.7 (was 10.34.6: it bundles the fixed `http-cache-semantics` 4.3.0). On the
Pass 18 images, on the local Compose stack (SeaweedFS, local PostgreSQL 16, alert
receiver; not hosted, 2026-10-20): `migrate` refused on the unmarked database; the gate
FAILED before the deploy (`database_environment`); after marking, 37 migrations applied;
app healthy in 5 s; scheduler ticks 200; **`STAGING CHECK PASSED`, 34 pass, 0 fail,
0 not run**, test alert delivered; app runs as `flexibx`, worker and scheduler as `node`,
all labelled with the build's revision. The `backup` job, a refused restore over the
source, a `VERIFIED` restore into a separate database, and `migrate` refused on that
unmarked copy: BACKUP_RESTORE.md § 12. Release process: RELEASE_PIPELINE.md.

## 16. Pass 19: the gate on the images of one release commit

The three images were built and verified by `scripts/release/build-and-verify.sh` from
commit `3e41054` (tag = the full SHA; every check passed: revision label, contents, size
budgets 389 / 1229 / 1089 MB, ops self-check, media tools, vulnerability scan). On the
local Compose stack with `FLEXIBX_TAG` = that SHA (SeaweedFS, local PostgreSQL 16, alert
receiver; **not hosted**, 2026-10-20): `migrate` refused the unmarked database and the gate
FAILED before the deploy (`database_environment`, 4 pass / 5 fail); after marking, the 37
migrations applied; app healthy in 6 s; scheduler ticks 200 (automation tick, video
retention); **`STAGING CHECK PASSED`, 34 pass, 0 fail, 0 not run**, test alert delivered
to the local receiver; app runs as `flexibx`, worker and scheduler as `node`, all three
labelled `3e41054…`. Then through the ops image: `backup` (77 tables), a restore naming the
source database refused (exit 2), a restore into a separate database `RESTORED` and
`VERIFIED` (row counts of 77 tables, 502 indexes and constraints, 37 migrations), and
`migrate` refused on that unmarked restored copy. The simulator (SeaweedFS) and the local
alert receiver stand in for S3 and a paging service: this is not evidence about AWS.
