# Flexibx — AI-Generated Video Retention Policy

**Status: implemented and reviewed. NOT production-ready yet.** Open prerequisites
(§8):

- the hosting platform is undecided and no scheduler is configured (§4);
- storage, backup, replication, provider and log retention are unverified (§5);
- production alerting is not configured (§6);
- the 30-day metadata period and the endpoint rate limit are implemented and tested
  (§9).

Uncommitted, awaiting review. Revised 2026-10-09: reconciled with the approved
operational decisions (§9).

## 1. Policy

| Item                          | Rule                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention period (approved)   | Every successfully generated AI video is kept for **exactly 7 days = 168 hours** from its successful-generation timestamp.                                                                                                                                                                                                                                                              |
| Timestamps                    | `succeeded_at` is the database clock (`statement_timestamp()`) when the video is recorded. Prisma omits the column, so the application server's clock is never used. It can never change. `expires_at = succeeded_at + 168 h` is recomputed by a trigger on every write. A value more than 1 s in the future is rejected.                                                               |
| Daylight saving               | The 168 hours are absolute. A DST change does not shorten or lengthen the period; only the displayed wall-clock time moves.                                                                                                                                                                                                                                                             |
| What is deleted               | Every stored object of the video: the video, its thumbnail, processed derivatives (e.g. 9:16 / 1:1) and temporary files.                                                                                                                                                                                                                                                                |
| Access after expiry           | From the exact expiry instant (database clock), downloads are refused with a 404, even if the deletion job is late or has not run.                                                                                                                                                                                                                                                      |
| What is kept                  | The video record as job, cost and audit metadata: title, provider, model, provider job id, duration, resolution, cost, timestamps, and one deletion tombstone per file. No file is kept by the application beyond the deletion time. See §5 for what the infrastructure may still hold.                                                                                                 |
| Metadata retention (approved) | **30 days after the video's files were deleted.** After that the video record and its file tombstones are purged. Implemented: `METADATA_RETENTION_DAYS = 30` (`src/server/videos/retention-policy.ts`), measured from `files_deleted_at` (database clock); the exact 30-day boundary is tested. Audit log entries follow the audit-log retention policy, which is a separate decision. |
| Warnings (approved)           | **In-app notices are the warning mechanism** (§2). **Email reminders remain disabled.** The 48 h / 24 h reminder code exists but is off: `VIDEO_EXPIRY_EMAILS` stays unset and no email provider is configured. Do not enable either without a new decision.                                                                                                                            |

Constants: `src/server/videos/retention-policy.ts`.

Database rules: the migrations `video_retention`, `video_retention_clock_tolerance`,
`video_retention_hardening` and `video_retention_statement_clock`.

## 2. Customer-facing notices (Arabic and English)

| Where                                                         | What                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI videos page**, top (`/{locale}/w/{workspace}/ai/videos`) | The standing notice: videos are deleted automatically after 7 days to conserve workspace storage, deletion includes thumbnails and processed versions, deleted videos cannot be recovered, download beforehand, and the time zone used. |
| **AI videos page**, per video                                 | The expected **deletion date and time** in the workspace time zone, hours remaining, a stage badge (available / deleted within 48 h / within 24 h / being deleted / deleted) and a **Download** button while available.                 |
| **Before generation** (`BeforeGenerationNotice`)              | The retention rule and the deletion date a video generated now would get (now + 168 h, in the workspace time zone), with the instruction to download before then.                                                                       |
| **AI Studio** banner                                          | Shown when available videos are deleted within 48 hours: "N AI videos will be deleted within 48 hours. Download any you want to keep." Links to the AI videos page.                                                                     |
| Activity feed                                                 | Retention events are attributed to "Flexibx", not to "Someone".                                                                                                                                                                         |

**The pre-generation notice and video generation:** no video-generation form exists
yet; the pipeline is not built. The notice is a ready component, rendered today on the
AI videos page. **It is a Phase 4 requirement that the video generation form renders
`BeforeGenerationNotice` above its submit button.** That form is not built yet.

**English** (videos page):

> **Videos are deleted automatically after 7 days**
> To conserve workspace storage, every AI-generated video — with its thumbnail and any
> processed versions — is deleted automatically 7 days (168 hours) after it was
> generated. Deleted videos cannot be recovered.
> Download any video you want to keep before its deletion time shown below.
> Times are shown in the workspace time zone: Asia/Riyadh (GMT+3).
>
> **Before you generate a video** — AI videos are kept for 7 days to conserve workspace
> storage, then deleted automatically together with their thumbnails and processed
> versions. Deleted videos cannot be recovered. A video generated now will be deleted
> on Friday, October 16, 2026 at 12:30 PM (GMT+3). Download it before then.

**Arabic** (videos page):

> **تُحذف الفيديوهات تلقائيًا بعد 7 أيام**
> توفيرًا لمساحة التخزين في مساحة العمل، يُحذف كل فيديو أنشأه الذكاء الاصطناعي — مع صورته
> المصغّرة وأي نسخ معالَجة منه — تلقائيًا بعد 7 أيام (168 ساعة) من إنشائه. لا يمكن استعادة
> الفيديوهات المحذوفة.
> نزّل أي فيديو تريد الاحتفاظ به قبل موعد حذفه الموضّح أدناه.
>
> **قبل أن تُنشئ فيديو** — نحتفظ بفيديوهات الذكاء الاصطناعي 7 أيام توفيرًا لمساحة تخزين
> مساحة العمل، ثم تُحذف تلقائيًا مع صورها المصغّرة ونسخها المعالَجة. لا يمكن استعادة
> الفيديوهات المحذوفة. الفيديو الذي يُنشأ الآن سيُحذف في {التاريخ} ({المنطقة الزمنية}).
> نزّله قبل ذلك الموعد.

## 3. How deletion works

One run of `runVideoRetention` (`src/server/videos/retention-job.ts`) does three things:

1. **Reminders** (only if enabled, §1).
   - Claims due videos with `FOR UPDATE SKIP LOCKED`, sets the reminder marker and
     sends to the requester. The requester must still be a member whose role can view
     content.
   - A failed send releases the claim, so a later run retries while the window is open.
   - Delivery is at most once: a crash after the claim and before the send skips that
     reminder.
2. **Deletion.**
   - Claims expired videos: status `DELETING`, `deletion_attempts + 1` and a 10-minute
     lease, with `SKIP LOCKED`. Overlapping runs never process the same video, and a
     crashed run's claim is retried after the lease.
   - For each file not yet deleted:
     - checks the key belongs to the video's workspace;
     - deletes the object (idempotent) from the storage provider recorded on the file
       row ([`STORAGE_PROVIDERS.md`](STORAGE_PROVIDERS.md) §6); a provider that cannot be
       resolved counts as a failed attempt and is retried — never another provider;
     - sets the file's `deleted_at`.
   - All files gone → a conditional `DELETING → DELETED` transition and one
     `video.files_deleted` audit entry.
   - Any failure → a retry at 5 min, 10, 20 … capped at 6 h, and a
     `video.deletion_failed` audit entry (`alert: true` from the 5th attempt). Only the
     remaining files are retried.
3. **Metadata purge.** Deletes `DELETED` records older than the metadata period and
   writes their `video.metadata_purged` audit entries in one transaction. The approved
   period is 30 days, measured from `files_deleted_at`.

**Database guards** (hardening migration):

- files can only be added to an `AVAILABLE` video, and the insert takes a share lock,
  so the job can never miss a file that is being added;
- a video record whose files are not all deleted cannot be deleted — directly, or by a
  workspace hard delete cascading to it — so objects are never orphaned without a
  record;
- a file row that is not tombstoned cannot be deleted.

**Orphaned storage objects** — objects with no database record, e.g. after a pipeline
crash between upload and recording — are **handled manually (approved)**. There is no
automatic sweeper by decision. Procedure: runbook §3.5.

**Tenant safety:**

- candidate selection is the only cross-workspace (system) query;
- everything afterwards goes through the tenant-guarded client;
- storage keys are constrained to `workspaces/{workspace_id}/` and re-checked before
  each delete;
- audit metadata and endpoint responses contain counts, ids and timestamps only — no
  storage keys, titles, prompts or email addresses.

## 4. Production scheduling — documented, NOT configured

**Production platform: undecided (approved status — open prerequisite).**

- There is no deployment manifest (Fly, Render, Vercel, Kubernetes, ECS, …). The README
  ships a Docker image "for any container platform", and storage is "S3-compatible
  (AWS S3, R2 …)".
- The scheduler therefore cannot be configured from here. Nothing below is configured
  anywhere until an operator records it in the checklist (§8).

The production image (Next.js standalone) contains only the compiled server, so
`pnpm video:retention` is not available in production. Production uses the endpoint:

| Method + path                        | Purpose                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/internal/video-retention` | One run. **Single flight across all instances** (Postgres advisory lock): a call during a run returns `200 {status:"skipped"}`. |
| `GET /api/internal/video-retention`  | Read-only backlog probe for monitoring.                                                                                         |

**Contract (platform-independent):**

| Item                | Value                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                | `Authorization: Bearer $VIDEO_RETENTION_CRON_SECRET` (≥ 32 chars, platform secret store). Unset secret, or a wrong/missing token, gives the same 404. Compared in constant time. |
| Schedule            | `*/15 * * * *` (UTC) — a conservative operational margin, not a measured production requirement (production run time and capacity have not been measured).                       |
| Timeout             | 120 s client timeout. The lock-holding transaction times out after 10 min; a run stops starting new work after 8 min (§7).                                                       |
| Retries             | At most 1, after ≥ 60 s. Retries are safe (idempotent, single flight).                                                                                                           |
| Concurrency         | Any; the server enforces one run at a time.                                                                                                                                      |
| Success             | HTTP 200 (`completed` or `skipped`). Anything else is a failure (runbook VR-1).                                                                                                  |
| Reachability        | The scheduler must reach the app over HTTPS, or over the private network; keep `/api/internal/*` off any public CDN cache (responses are `no-store`).                            |
| Storage permissions | `s3:DeleteObject` (and `s3:DeleteObjectVersion` if versioning is used) on the media bucket.                                                                                      |
| Email               | `VIDEO_EXPIRY_EMAILS` unset (decided: in-app notices only).                                                                                                                      |

**Abuse exposure:**

- Without the secret, a caller learns nothing and causes one hash comparison per request.
- With the secret, the worst case is back-to-back single-flight runs, each bounded to
  200 items per phase.
- **Rate limit: 12 requests per 10 minutes — approved and implemented.**
  - Bucket `video-retention` in `src/server/auth/rate-limit-policy.ts`, enforced
    through the existing Better Auth 1.7.7 limiter (`rate_limits` table, atomic
    conditional increments, so it holds across instances). POST and GET share one
    quota: monitoring probes count toward it.
  - The secret is checked first: unauthenticated requests get a 404 and consume
    nothing. Above the limit: the standard `429 RATE_LIMITED` error (no extra headers).
  - Window behavior: neither a fixed window nor a conventional sliding window. Each
    allowed request increments the counter and restarts the 10-minute timer; the
    counter resets only after 10 minutes with no allowed request. Rejected (429)
    requests neither count nor restart the timer.
  - Consequence: any chain of authenticated calls (POST and GET) spaced less than 10
    minutes apart may contain at most 12 allowed requests; further calls get 429 until
    10 minutes pass after the last allowed one. A 15-minute schedule with at most one
    retry ~1 minute later leaves a quiet gap of ≥ 13 minutes, so the counter resets
    before each scheduled run — provided probes and manual calls do not fill that gap.
    Probes every 10 minutes or more often can chain with the schedule and cause 429s
    on scheduled runs.
  - [Assumption] Timestamps come from each app server's clock; instances are assumed
    NTP-synchronized. Cross-instance behavior is not tested.
  - The single-flight lock is unchanged.
- Unauthorized attempts appear as `videos.retention.run` 404 warnings in the request
  logs.

**Platform-specific configurations** (choose one — operator decision):

- **Kubernetes CronJob.**
  - Image `curlimages/curl` with args
    `-fsS --max-time 120 --retry 1 --retry-delay 60 -X POST -H "Authorization: Bearer $(SECRET)" http://flexibx-web:3000/api/internal/video-retention`.
  - `schedule: "*/15 * * * *"`, `concurrencyPolicy: Forbid`, `backoffLimit: 0`; the
    secret comes from a Secret.
- **Fly.io.** A scheduled Machine (`fly machine run curlimages/curl --schedule hourly`
  is the minimum granularity of `--schedule`). For 15 minutes, use a cron Machine
  (supercronic) or an external scheduler.
- **Render.** A Cron Job service with schedule `*/15 * * * *` and command `curl …` as
  above. The secret is an environment group variable.
- **AWS (ECS/App Runner).** EventBridge Scheduler `rate(15 minutes)`, targeting an API
  destination with the `Authorization` header from Secrets Manager.
- **Any host with cron.**
  `*/15 * * * * curl -fsS --max-time 120 --retry 1 --retry-delay 60 -X POST -H "Authorization: Bearer $VIDEO_RETENTION_CRON_SECRET" https://<app>/api/internal/video-retention`

These platform notes are not verified against each provider's current documentation;
confirm before use.

## 5. Application deletion vs. permanent erasure

**What the application guarantees:**

- downloads stop at the expiry instant;
- the job issues `DeleteObject` for every object of the video and records it;
- the video record is purged 30 days after its files were deleted.

**What it cannot guarantee — infrastructure copies (verified: none of these can be
checked from this repository).** Operator checks O1–O9:

| ID  | Check                                                       | How                                                                                   | Required result                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Bucket versioning                                           | `aws s3api get-bucket-versioning --bucket <b>` / `mc version info` / provider console | Not enabled; or O2 in place. With versioning on, a delete only adds a delete marker.                                                  |
| O2  | Lifecycle for noncurrent versions and delete markers        | `aws s3api get-bucket-lifecycle-configuration`                                        | `NoncurrentVersionExpiration: 1 day` + `ExpiredObjectDeleteMarker: true` on `workspaces/` (if versioning is on).                      |
| O3  | Object Lock / retention / legal hold                        | `aws s3api get-object-lock-configuration`                                             | Disabled on the media bucket (locked objects cannot be deleted; the job would alert forever).                                         |
| O4  | Replication                                                 | `aws s3api get-bucket-replication`                                                    | None, or delete-marker replication on and the same lifecycle on replicas.                                                             |
| O5  | Bucket backups / snapshots (incl. provider backup products) | Backup plan inventory                                                                 | Media prefixes excluded, or their backup retention recorded and disclosed.                                                            |
| O6  | Storage provider internal retention                         | Provider data-deletion documentation                                                  | Recorded (time until deleted data is unrecoverable).                                                                                  |
| O7  | Database backups / PITR retention                           | DB provider console (e.g. backup retention days)                                      | Recorded. Backups keep video **metadata** (titles, costs) — not files — until they expire; purged rows survive in backups until then. |
| O8  | Log retention                                               | Log platform settings                                                                 | Recorded. Logs hold counts, ids and timestamps only.                                                                                  |
| O9  | Generation provider copies                                  | Provider terms (provider doc V3/V4)                                                   | Recorded; outside Flexibx's control.                                                                                                  |

**Customer wording** while any of O1–O9 is unverified — including backups, replication,
provider copies and log retention: "Videos are deleted from Flexibx after 7 days."
Never "permanently erased" or "permanently deleted". Backup, replica or provider copies
can exist until their own retention ends. The in-app notices (§2) say videos "are
deleted" and "cannot be recovered" (meaning: by the customer through Flexibx). They make
no permanent-erasure claim.

**Development defaults** (not production): the local SeaweedFS in `docker-compose.yml`
has no versioning configured. The local Postgres has no backups.

## 6. Operations

Alerts, signals and procedures: [runbooks/VIDEO_RETENTION_RUNBOOK.md](runbooks/VIDEO_RETENTION_RUNBOOK.md).
They are specified, not configured on any monitoring platform.

**Alert ownership (approved): the future production operator.** That operator is not
yet named; production alerting stays an open prerequisite until they configure the
alerts and record themselves in §8.

## 7. Known limitations (accepted for now)

- Downloads are read into memory before being sent. This is fine for short clips (a few
  MB); long videos need streaming or short-lived signed URLs capped at the expiry time.
- The AI videos page lists up to 500 stored videos per workspace and the 20 most recent
  deletions.
- Reminder delivery is at most once (see §3).
- `succeeded_at` accepts up to 1 s of clock tolerance on insert, which can extend
  retention by at most 1 s.
- **Long runs and single flight — reproduced, mitigated.** The advisory lock lives in a
  Prisma interactive transaction with a 10-minute timeout. Reproduced locally (installed
  Prisma 7.10): on timeout Prisma rolls the transaction back, which releases the lock,
  but does not stop the run's work, so a second run could start. Mitigation (implemented
  and tested):
  - a run stops starting new phases, claims or deletes after an 8-minute budget
    (`RUN_TIME_BUDGET_MS`) and reports `status: "partial"`;
  - each storage delete is aborted after 30 s (`STORAGE_DELETE_TIMEOUT_MS`) and counts
    as unconfirmed (retried);
  - videos are claimed one at a time, with the 10-minute lease counted from the claim;
  - a failure is recorded only while the video is still that run's claim;
  - `files_deleted_at` is set after storage confirmed every delete;
  - the deadline is checked again right before each claim, so no claim starts after it;
  - a video left mid-way only because of the deadline is handed back without counting
    an attempt, so deadline stops cannot trigger the repeated-failure alert (genuine
    failures and timeouts still count);
  - the run uses its own database pool: PostgreSQL cancels any statement after 3 s
    (`statement_timeout`) and waiting for a connection fails after 3 s. Application
    routes keep the default pool.

  Calculated bound — not an enforced or measured guarantee: the lock query (3 s, runs
  after the lock's timer starts) + 8 min budget + one 30 s storage delete + at most 8
  statements × 3 s + 4 connection waits × 3 s = 9 min 9 s, under the 10-minute lock
  timeout (`worstCaseRunMs()`). Each term is enforced separately (PostgreSQL
  `statement_timeout`, the pool's connection timeout, the storage timer); the sum holds
  only under the assumptions below. Compatibility of the `statement_timeout` connection
  setting with the production database path (e.g. a connection pooler) is unverified:
  the platform is undecided. It does **not** cover: email reminders
  (no send timeout; disabled), a database or network that stops answering
  (`statement_timeout` is enforced by the server), or process pauses. An adapter that
  ignores the abort may still complete its delete later (harmless: retried, idempotent).
  The lock timeout remains the backstop. Production run duration has not been measured.

## 8. Production-readiness checklist (open prerequisites)

The owner of every operational item is the future production operator (approved). Fill
in the name and date when done.

| Item                                                                                                                     | Status                           | Owner / done |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------ |
| Hosting platform chosen                                                                                                  | **Open** (undecided)             |              |
| Scheduler configured per §4 (`*/15 * * * *`)                                                                             | **Open**                         |              |
| `VIDEO_RETENTION_CRON_SECRET` set in app + scheduler                                                                     | **Open**                         |              |
| One manual run observed (`status: completed`) in production                                                              | **Open**                         |              |
| Production run duration and throughput measured (§7; long-run single flight mitigated by the run budget)                 | **Open**                         |              |
| Alerts VR-1…VR-6 configured (runbook §2)                                                                                 | **Open**                         |              |
| Storage checks O1–O6 recorded (versioning, lifecycle, Object Lock, replication, backups, provider retention)             | **Open**                         |              |
| Database backup retention (O7), log retention (O8), generation-provider copies (O9) recorded                             | **Open**                         |              |
| 30-day metadata retention implemented in code and tests (§9)                                                             | Done (implemented, tested)       |              |
| 12 requests / 10 min rate limit implemented and tested (§9)                                                              | Done (implemented, tested)       |              |
| Email reminders                                                                                                          | Disabled (approved) — no action  |              |
| Orphan cleanup                                                                                                           | Manual (approved) — runbook §3.5 |              |
| Storage provider checks for Wasabi, if it becomes the write provider ([`STORAGE_PROVIDERS.md`](STORAGE_PROVIDERS.md) §8) | **Open**                         |              |

## 9. Approved operational decisions (2026-10-09)

| Decision                                              | Documentation | Implementation                                                                                                                                                                           |
| ----------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video files expire 7 days after successful generation | Reflected     | Implemented and tested (168 h database rule).                                                                                                                                            |
| Metadata kept 30 days after files are deleted         | Reflected     | Implemented: `METADATA_RETENTION_DAYS = 30`; unit test and an integration test of the exact 30-day boundary.                                                                             |
| Retention endpoint limit: 12 requests per 10 min      | Reflected     | Implemented: `video-retention` bucket (12 / 600 s) checked after the secret on POST and GET (one shared quota); integration tests cover the limit, ordering, concurrency and the window. |
| Orphaned storage objects handled manually             | Reflected     | Manual procedure only (runbook §3.5); no sweeper by design.                                                                                                                              |
| Alert ownership: the future production operator       | Reflected     | Operator not yet named; alerts not configured.                                                                                                                                           |
| Production platform remains undecided                 | Reflected     | No deployment manifest; scheduler not configured.                                                                                                                                        |
| Email reminders remain disabled                       | Reflected     | Implemented: off by default (`VIDEO_EXPIRY_EMAILS` unset; production mailer unconfigured).                                                                                               |
