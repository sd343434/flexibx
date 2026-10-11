# Runbook — Generated Video Retention

Policy: [AI_VIDEO_RETENTION_POLICY.md](../AI_VIDEO_RETENTION_POLICY.md).

Code:

- `src/server/videos/retention-job.ts`
- `src/server/videos/retention-runtime.ts`
- `src/app/api/internal/video-retention/route.ts`

**Status:** these alerts are **specified, not configured** (open prerequisite).

- **Owner (approved): the future production operator**, not yet named. They create the
  alerts on the monitoring platform chosen with the (still undecided) hosting platform,
  and record their name and the date in the policy checklist (§8).
- No monitoring or alerting platform exists in this repository.

**Approved decisions this runbook follows:**

- files expire 7 days after generation;
- metadata is kept 30 days after file deletion (implemented);
- endpoint limit of 12 requests per 10 minutes, POST and GET combined (implemented;
  window behavior in §4);
- orphans are cleaned up manually;
- email reminders are disabled.

## 1. Signals

| Signal            | Where                                                                                                                              | Fields                                                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run log           | App logs (pino JSON), message `video_retention.run`; level `info` / `warn` / `error`                                               | `videoRetention.status` (`completed`/`partial`/`skipped`/`storage_unavailable`), `.stoppedAtDeadline`, `.storageUnavailableFiles`, `.deletion.{claimed,deleted,failed,interrupted}`, `.purged`, `.backlog.{overdue,oldestOverdueExpiresAt,alerting}`, `severity` |
| Scheduler result  | The scheduler's job history                                                                                                        | HTTP status of `POST /api/internal/video-retention` (200 = ran or skipped; 503 = storage provider unavailable, see `docs/STORAGE_PROVIDERS.md` §6)                                                                                                               |
| Probe             | `GET /api/internal/video-retention` with the bearer secret                                                                         | `backlog.overdue`, `backlog.oldestOverdueExpiresAt`, `backlog.alerting` (read-only, cheap)                                                                                                                                                                       |
| Per-video history | `audit_logs`, actions `video.files_deleted`, `video.deletion_failed` (`alert: true` from the 5th attempt), `video.metadata_purged` | ids, attempts, counts — no keys or titles                                                                                                                                                                                                                        |

**Severity rules** (`src/server/videos/retention-observability.ts`):

- **error** when any video has failed deletion 5 or more times (`backlog.alerting > 0`),
  or the oldest overdue video expired 24 h or more ago.
- **warn** when a deletion failed in this run, or anything is overdue (expired more
  than 1 h ago, files not yet deleted).
- **info** otherwise.

## 2. Alerts to configure

| ID   | Condition                                                                                                                | Severity              | Action      |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------- |
| VR-1 | No `video_retention.run` log line for **45 min** (3 missed 15-minute runs), or the scheduler reports a non-2xx response  | Page (business hours) | §3.1        |
| VR-2 | Any `video_retention.run` at level **error**                                                                             | Page                  | §3.2 / §3.3 |
| VR-3 | `video_retention.run` at level **warn** for **4 consecutive runs** (1 h)                                                 | Ticket                | §3.2        |
| VR-4 | Probe `backlog.overdue > 0` with `oldestOverdueExpiresAt` older than **24 h**                                            | Page                  | §3.3        |
| VR-5 | `status: "skipped"` on **8 consecutive runs** (a run is stuck holding the lock for 2 h; the lock times out after 10 min) | Ticket                | §3.4        |
| VR-6 | Storage usage of the `generated-videos/` prefix grows while overdue = 0 (orphans outside the database)                   | Ticket (weekly)       | §3.5        |

## 3. Procedures

### 3.1 Job not running (VR-1)

1. Check the scheduler: is the job enabled, and when did it last run? What was the HTTP
   status?
2. `404` → `VIDEO_RETENTION_CRON_SECRET` is missing in the app or differs from the
   scheduler's secret. Fix the secret in both places (it must be ≥ 32 characters).
3. `5xx` → read the app logs for `videos.retention.run` errors; usually the database or
   environment.
4. Trigger one run by hand:
   `curl -fsS -X POST -H "Authorization: Bearer $SECRET" https://<app>/api/internal/video-retention`
5. Customer impact while the job is down: expired videos already return 404 to
   customers, but storage is not reclaimed.

### 3.2 Deletions failing (VR-2 / VR-3)

1. List the failing videos (read-only SQL):
   ```sql
   SELECT id, workspace_id, deletion_attempts, last_deletion_error, next_deletion_attempt_at, expires_at
   FROM generated_videos WHERE status = 'DELETING' ORDER BY deletion_attempts DESC LIMIT 50;
   ```
2. Check storage access with the app's credentials:
   - `s3:DeleteObject` permission (plus `s3:DeleteObjectVersion` if versioning is
     enabled);
   - bucket name and region;
   - Object Lock or a legal hold on the bucket. Locked objects cannot be deleted: remove
     Object Lock from the media bucket — **never** bypass it per object without a legal
     decision.
3. Once fixed, do nothing else: the job retries automatically (backoff capped at 6 h).
   To retry sooner, reset the backoff:
   ```sql
   UPDATE generated_videos SET next_deletion_attempt_at = NULL WHERE status = 'DELETING';
   ```
4. Never mark a video `DELETED` by hand. Database constraints refuse it without
   `files_deleted_at`, and the files would be orphaned.

### 3.3 Expired files accumulating (VR-4)

1. Run §3.1 (is the job running?) and §3.2 (is it failing?).
2. Throughput: each run handles 200 videos per phase. If `overdue` keeps growing while
   runs complete without failures, trigger extra runs by hand: up to about 10 calls in a
   burst (leaving room for the scheduler), then make no calls for 10 minutes. Calls
   less than 10 minutes apart — scheduled, manual or probe — chain toward the 12-call
   limit (§4). Keep the 15-minute schedule; it is a conservative margin, not a
   measured requirement. The single-flight lock makes extra runs safe.
3. Record the incident: customers were told files are deleted after 7 days. If objects
   stayed in storage materially longer, inform the owner (possible notice obligation).

### 3.4 Runs always skipped (VR-5)

A run holds the advisory lock. The holding transaction times out after 10 minutes, so
persistent skips most likely mean a session is stuck. A run stops starting new work
after 8 minutes and reports `status: "partial"` (logged at `warn`; the next run
continues). Repeated `partial` runs mean the backlog or storage latency needs more
time than one run has: check storage latency and §3.3 (policy §7).

```sql
SELECT pid, state, now() - xact_start AS age, left(query, 80)
FROM pg_stat_activity WHERE query ILIKE '%pg_try_advisory_xact_lock%';
```

Terminate a stuck backend with `SELECT pg_terminate_backend(<pid>)` (this releases the
lock), then check storage latency.

### 3.5 Storage orphans (VR-6) — manual procedure (approved)

Objects under `workspaces/*/generated-videos/` or `generated-images/` with no
`generated_video_files` row, or whose row has `deleted_at` set, are orphans. Typical
causes:

- a pipeline crash between upload and `recordGeneratedVideo`;
- bucket versioning (noncurrent versions).

Remediation:

- compare an inventory listing with the table;
- delete orphans older than 7 days;
- fix versioning or lifecycle per the policy doc §5.

Orphan cleanup is **manual by decision**; there is no automated sweeper, and none is
planned. The production operator runs this procedure when VR-6 fires, or at least
monthly. Record each cleanup (date, object count, bytes) in the operations log.

## 4. Safe operations

- **Re-running the job:** always safe (idempotent, single flight).
- **Request budget:** the approved endpoint limit is **12 requests per 10 minutes**
  (scheduled runs, retries, manual triggers and probes combined). It is **enforced**:
  - POST and GET share one quota; monitoring probes count toward it;
  - calls above it get `429 RATE_LIMITED`; unauthenticated calls get 404 and count
    for nothing;
  - it is neither a fixed nor a conventional sliding window: each allowed call
    increments the counter and restarts a 10-minute timer, and the counter resets only
    after 10 minutes with no allowed call. Rejected calls neither count nor restart
    the timer;
  - so any chain of calls spaced less than 10 minutes apart may contain at most 12
    allowed calls. The 15-minute schedule with at most one retry ~1 minute later
    leaves a ≥ 13-minute gap and resets the counter before each run — unless probes or
    manual calls fill that gap;
  - keep probes at least 10 minutes from other calls in practice (e.g. every 30
    minutes); probes every 10 minutes or more often can chain with the schedule and
    cause 429s on scheduled runs;
  - the 15-minute interval is a conservative operational margin, not a measured
    requirement: production run time and throughput have not been measured;
  - a 429 on a scheduled run is harmless: the next scheduled run catches up.

- **Scheduler retries:** safe. At most 1 retry, after ≥ 1 minute.
- **Email reminders:** disabled (approved). Do not set `VIDEO_EXPIRY_EMAILS=enabled`.
- **Rotating `VIDEO_RETENTION_CRON_SECRET`:**
  1. set the new value in the app and redeploy;
  2. update the scheduler;
  3. expect 404s in between (VR-1 may fire briefly).
