# Creator Studio — staging validation plan (Passes 10–13)

Status on 2026-10-19:

- **Prepared:** configuration, a preflight command, monitoring and this plan.
- **Deployable (Pass 13, § 10):** `deploy/staging/compose.yaml` runs the app, the worker and
  a scheduler from the three images, with migrate / check / backup jobs, and
  `pnpm staging:check` gates the trial. All three images were built and the whole cycle
  run in containers on one machine.
- **Run on one machine (Pass 12, § 9):** the plan against a staging-like stack. Repeatable
  with `scripts/staging/local-stack.sh`.
- **Not executed on hosted infrastructure:** no staging environment, bucket or
  credentials exist yet. Nothing below has been verified there.

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

1. **Images**, all from one commit: `docker compose -f deploy/staging/compose.yaml build`
   (app `runner`, `worker`, `ops`). The worker build fails by itself unless its FFmpeg
   passes `scripts/creator/check-media-tools.sh` (version 6 or later, libx264, aac, libopus,
   libass, ffprobe, the subtitle font, a real smoke encode).
2. **Database:**
   - confirm the target is the staging database, never production;
   - take a backup: `docker compose … run --rm backup` (copy it off the host);
   - `docker compose … run --rm migrate` (`prisma migrate deploy`, as the unprivileged
     user);
   - the gate below runs `db-verify.sh --no-row-counts` (migrations with checksums, the 502
     indexes and constraints, integrity checks including disabled guard triggers).
3. **Start:** `docker compose … up -d app worker scheduler`. The scheduler starts once the
   app is healthy and calls the tick every 2 minutes and video retention daily.
4. **Gate:** `docker compose … run --rm check` (`pnpm staging:check --send-test-alert` in
   the worker image). It must print `STAGING CHECK PASSED`:
   - environment: required variables set and the app's own startup validation (names,
     never values);
   - database (as above); media tools, scratch space, private bucket, signed links,
     multipart, CORS and lifecycle (`creator:preflight`, probe objects only, never a
     provider);
   - app readiness; ops-status: worker heartbeat, scheduler, stuck jobs, deletions,
     clean-up, disk, alert delivery; one test alert delivered.

   Exit 1 (`FAILED`) names what is wrong; exit 2 (`INCOMPLETE`) means a check could not run
   there — not a pass. Fix and run it again.

5. Run `pnpm creator:retention-report` once (ops image): starting counts, deletes nothing.

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
