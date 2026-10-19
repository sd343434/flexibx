# Creator Studio — staging validation plan (Passes 10–12)

Status on 2026-10-19:

- **Prepared:** configuration, a preflight command, a worker image target, monitoring
  and this plan.
- **Run on one machine (Pass 12, § 9):** the whole plan against a staging-like stack — the
  production build, a separate worker process, its own database and a private
  S3-compatible bucket. Repeatable with `scripts/staging/local-stack.sh`.
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

1. Build the three images from one commit: `flexibx`, `--target migrate`,
   `--target worker`. The worker build fails by itself unless its FFmpeg passes
   `scripts/creator/check-media-tools.sh`: version 6 or later, libx264, aac, libopus,
   libass, ffprobe, the subtitle font and a real smoke encode.
2. **Database:**
   - confirm the target is staging (`SELECT current_database()` through the ops image);
   - take a backup (`db-backup.sh`);
   - run the `migrate` image once;
   - check that `prisma migrate status` is clean;
   - run `db-verify.sh` against the expected schema objects. Never point this at
     production.
3. **Worker host:**
   - run `docker run --env-file … -v work:/work flexibx-worker pnpm creator:preflight`
     (one-off command; the worker itself runs `node` as PID 1 so `docker stop` reaches it).
     It writes and deletes only random probe objects under the reserved workspace
     `00000000-0000-0000-0000-000000000000`, and never calls a provider;
   - it must print `PREFLIGHT PASSED`. Fix every FAIL first (FFmpeg build, scratch
     space, bucket privacy, link lifetime, multipart, CORS, lifecycle).
4. Start the worker (one container), then the web app. Check `/api/health`.
5. Start the scheduler. Within 5 minutes, `ops-status` shows a fresh
   `creator_worker_last_seen_age_seconds` and the tick's checks.
6. Run `pnpm creator:retention-report` once: it records the starting counts and deletes
   nothing.

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
  image.
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
