# Creator Studio — operations runbook (Passes 8–10)

The Creator Studio turns one uploaded video or audio file into short clips:

1. **Upload:** create a project and upload a file.
2. **Analyze:** a background job checks the file and reads it with ffprobe.
3. **Transcribe:** the audio is extracted and transcribed, and clips are suggested from
   the transcript text and timestamps (rules, not AI).
4. **Translate** (optional).
5. **Review:** a person edits and approves clips.
6. **Export:** an approved clip is cut, reframed (9:16, 16:9 or 1:1) and optionally
   given burned-in subtitles. The result is a verified MP4 in private storage, downloaded
   through a short-lived link.

Code: `src/server/creator/`. Pages: `/{locale}/w/{slug}/studio`. Architecture:
[`ARCHITECTURE.md` § 23](../ARCHITECTURE.md).

## 1. What is real and what is simulated

| Part                                                           | Status                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Upload: one signed PUT up to 64 MiB, resumable multipart above | Real. Tested with in-memory storage and a local S3 stand-in; never a real bucket  |
| Checksums (SHA-256 per part or file, checked by the worker)    | Real                                                                              |
| File check (magic bytes, ffprobe, duration and size limits)    | Real FFmpeg/ffprobe                                                               |
| Audio extraction, cut, crop/scale, burned subtitles, MP4 check | Real FFmpeg (libx264, AAC, libass), tested on small synthetic files               |
| Transcription and translation                                  | OpenAI adapter written and tested against mocks; **off until the owner approves** |
| Project deletion, storage clean-up, data export                | Real (deletion queue with retries; JSON export)                                   |
| Clip suggestions                                               | Rules on the transcript (`rules-v1`): questions, numbers, hook words, length      |
| Credits                                                        | Real holds, capture and release. Simulated work is never charged                  |

- **The simulator is labelled everywhere.** Each simulated line reads "Simulated line n:
  …" or "نص محاكاة رقم n: …". Transcripts, clips and job steps carry `simulated = true`
  and show a "Simulated" badge, and the project page shows a notice. Subtitle files are
  named `…-simulated.srt` (VTT files also get a NOTE).
- **The simulator is refused in production** (`NODE_ENV=production`), like the other
  test providers. The one exception is the local end-to-end run (`FLEXIBX_TEST_PROVIDERS`
  with a localhost `APP_URL`).
- **The real provider (OpenAI) is off by default** and has never been called from this
  repository: every test uses a mocked `fetch`. Turning it on is an owner decision (§ 8),
  enforced by configuration: `CREATOR_AI_PROVIDER=openai` is refused at start-up unless
  `CREATOR_EXTERNAL_PROCESSING=approved` and `OPENAI_API_KEY` are set.
- **External processing is shown and confirmed.** With an external provider, the project
  page names the provider, model and region, and each transcription or translation
  request needs a ticked confirmation that the audio or text is sent to it
  (`creator_external_consent_required` otherwise). The job records
  `externalProcessing: "confirmed"`.

## 2. Configuration

| Variable                             | Default                   | Meaning                                                                                                              |
| ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CREATOR_AI_PROVIDER`                | `disabled`                | `disabled`: upload, checking and manual clips only. `simulated`: test-only, refused in production. `openai`: see § 8 |
| `CREATOR_EXTERNAL_PROCESSING`        | unset                     | `approved`: the owner's recorded approval to send media and text to the external provider                            |
| `OPENAI_API_KEY`                     | unset                     | Shared with the AI Studio. Never logged or shown                                                                     |
| `CREATOR_OPENAI_TRANSCRIPTION_MODEL` | `whisper-1`               | The model must return segment timestamps (`verbose_json`)                                                            |
| `CREATOR_OPENAI_TRANSLATION_MODEL`   | `OPENAI_MODEL`            | Responses API model used for translation (`store: false`)                                                            |
| `CREATOR_PROVIDER_TIMEOUT_MS`        | 120000 (10 s–300 s)       | One provider request                                                                                                 |
| `CREATOR_MAX_UPLOAD_MB`              | 2000 (1–2000)             | Largest source file (multipart above 64 MiB)                                                                         |
| `CREATOR_MAX_ACTIVE_UPLOADS`         | 3 (1–20)                  | Open uploads per workspace (and one per project)                                                                     |
| `CREATOR_UPLOAD_SESSION_HOURS`       | 24 (1–72)                 | How long a resumable upload can be continued before it expires and its parts are removed                             |
| `CREATOR_MAX_RUNNING_JOBS`           | 2 (1–20)                  | Jobs of one workspace running at the same time across all workers (one busy workspace cannot take every worker)      |
| `CREATOR_RETENTION_SOURCE_DAYS`      | unset (1–3650)            | PROPOSED source retention: only reported by `pnpm creator:retention-report`, nothing is deleted by age (§ 11)        |
| `CREATOR_RETENTION_EXPORT_DAYS`      | unset (1–3650)            | PROPOSED export retention: reported only, as above                                                                   |
| `CREATOR_MAX_DURATION_SECONDS`       | 3600 (10–14400)           | Longest source media                                                                                                 |
| `CREATOR_FFMPEG_PATH`                | `ffmpeg`                  | FFmpeg binary (needs libx264, AAC and libass)                                                                        |
| `CREATOR_FFPROBE_PATH`               | `ffprobe`                 | ffprobe binary                                                                                                       |
| `CREATOR_FFMPEG_THREADS`             | 2 (1–16)                  | Threads per FFmpeg run                                                                                               |
| `CREATOR_WORK_DIR`                   | the system temp directory | Where per-job scratch directories are created                                                                        |

Fixed in `src/server/creator/config.ts`:

- **Upload:** a single-PUT URL is valid for 15 minutes, and that upload expires 5 minutes
  after that. A multipart upload stays open for `CREATOR_UPLOAD_SESSION_HOURS`; each part
  URL is valid for 15 minutes and is signed again on demand. Parts are 16 MiB (more for
  very large files, at most 10 000 parts).
- **Leases and retries:** a 2-minute lease renewed every 30 s, a 60-minute deadline per
  job, and 3 attempts with backoff starting at 30 s.
- **Step timeouts:** VERIFY 5 min, TRANSCRIBE 10 min, SUGGEST 1 min, TRANSLATE 5 min,
  RENDER 10 min. Each is kept below the 15-minute window after which abandoned credit
  holds are released.
- **Clips and exports:** clips last 1 s–10 min, and exported files are at most 500 MiB.

**Credit prices are provisional** (`src/server/billing/pricing.ts`), per started minute:

| Feature                 | Credits per minute |
| ----------------------- | ------------------ |
| `creator_transcription` | 2                  |
| `creator_translation`   | 1                  |
| `creator_export`        | 1                  |

The page shows the estimate before anything is requested. No plan price was changed and
no automatic top-up exists.

## 3. Running the worker

The web app never runs FFmpeg. Media work is done by a separate process:

```bash
pnpm creator:worker      # tsx scripts/creator/worker.ts; SIGTERM / SIGINT stop it between jobs
```

**One job at a time per process.** Scale out by running more processes: each claims a
job with a lease, so two workers never run the same job. A workspace runs at most
`CREATOR_MAX_RUNNING_JOBS` jobs at once across all workers; the check and the claim share
a per-workspace advisory lock, so two workers cannot both take the last slot. A worker
that died frees its slot when its lease expires.

**Container image:** `docker build --target worker -t flexibx-worker .` (Debian trixie,
FFmpeg from the distribution, scratch volume `/work`). **Before the first job on a new
host,** run `pnpm creator:preflight` there (`STAGING_CREATOR_STUDIO.md` § 3).

**At start,** the worker removes scratch directories older than 6 hours left behind by a
crashed run.

**Every minute,** on its own timer (also while a long job runs), it records its heartbeat
(`system_heartbeats`, job `creator-worker`). The heartbeat checks the scratch disk: less
free space than the largest allowed job needs (2× `CREATOR_MAX_UPLOAD_MB` + 256 MiB) is
reported as the phase `disk_low`. Between jobs, it also expires abandoned uploads
(queueing their objects and multipart uploads for deletion) and runs the storage
deletion sweep (§ 9). A failure of either is reported in the next heartbeat.

**Requirements for each worker host:**

- FFmpeg 6 or later, with libx264, AAC and libass, plus a font for subtitles (DejaVu
  Sans).
- The same `DATABASE_URL` and storage settings as the app.
- No inbound network access.
- **Memory:** the source is streamed to disk (never held in memory whole); plan for
  FFmpeg's own use, about 1 GiB per worker.
- **Disk:** about 3× the largest source per running job, in `CREATOR_WORK_DIR`. Before a
  download the worker checks the free space and fails the step with `worker_disk_full`
  (retryable) instead of filling the disk.

**Safety of the FFmpeg runs:**

- FFmpeg and ffprobe run with an argument array and `shell: false`.
- The environment holds only `PATH` and `LC_ALL`, so no secrets reach them.
- Inputs are read with `-protocol_whitelist file` and `file:` paths, so FFmpeg has no
  network access.
- Output size is capped with `-fs`.
- On a timeout, a cancel or a lost lease, the process is killed with SIGKILL and the
  scratch directory is deleted.

## 4. Object storage (S3 / Wasabi)

The browser uploads straight to the bucket:

- **Up to 64 MiB:** one signed `PUT` that fixes the `Content-Type` and `Content-Length`.
- **Above 64 MiB:** an S3 multipart upload. The server creates it, signs one `UploadPart`
  URL per part (bound to the part's exact length) and, at the end, lists the parts
  (`ListParts`) and completes the upload. The browser never needs to read the `ETag`
  header, so it does not have to be exposed.

The bucket therefore needs a CORS rule for the app's origin:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 600
  }
]
```

**Object keys** are generated on the server, under
`workspaces/<workspaceId>/creator-sources/…` and `…/creator-exports/…`. A database CHECK
enforces this prefix.

**Downloads** are redirects to a signed `GET` that is valid for 2 minutes. The bucket
stays private.

**Resuming:** the browser keeps the upload's id (not the file) in local storage. After a
reload or a lost connection, the person picks the same file again; the page asks the
server which parts storage already holds (`ListParts` is the source of truth) and sends
only the missing ones. Pause, resume and cancel are on the upload panel.

**Checksums:** the browser computes the SHA-256 of each part (or of the whole file for a
single PUT) and declares it before the URL is signed. The worker re-reads the stored file
in one streaming pass and compares every part; a mismatch rejects the file
(`checksum_mismatch`) and deletes it. The real type is then checked from the magic bytes
and ffprobe as before.

**SDK checksums are disabled for presigned URLs.** The AWS SDK adds a CRC32 checksum to
signed URLs by default, which a browser cannot satisfy. The client sets
`requestChecksumCalculation` / `responseChecksumValidation` to `WHEN_REQUIRED`; a test
checks that signed URLs carry no checksum parameters.

**Lifecycle rule (recommended):** add a bucket rule that aborts incomplete multipart
uploads after 3 days, as a second line of defence behind the worker's clean-up.

The in-app upload routes (`PUT /api/w/{slug}/studio/uploads/{id}` and
`…/uploads/{id}/parts/{n}`) exist only for the in-memory test store. They return 404
everywhere else.

## 5. Failures and what to do

Job failure codes are shown on the page (translated). Retryable failures are retried
automatically up to 3 attempts. After that, a person can press **Retry**, which resumes
the same job from its first unfinished step; finished steps are not repeated and not
charged again.

| Code                                                                                                                  | Meaning / action                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `upload_missing`, `size_mismatch`, `type_mismatch`, `unsupported_format`, `unreadable_media`, `too_large`, `too_long` | The uploaded file was rejected and its object deleted. The person uploads another file |
| `no_audio` / `no_video`                                                                                               | Nothing to transcribe / nothing to export                                              |
| `provider_disabled`                                                                                                   | `CREATOR_AI_PROVIDER=disabled`                                                         |
| `credits_insufficient`, `credits_cap`                                                                                 | Nothing was charged. Add credits or wait for the daily window, then retry              |
| `step_timeout`, `deadline_reached`                                                                                    | Check the worker host's load and the media size                                        |
| `ffmpeg_failed`, `render_invalid`                                                                                     | Check the worker log (code and the last stderr lines only; no media content is logged) |
| `storage_unavailable`                                                                                                 | Storage error; retried automatically                                                   |
| `checksum_mismatch`                                                                                                   | The stored bytes differ from what the browser hashed. The file is rejected and deleted |
| `worker_disk_full`                                                                                                    | Not enough free space in `CREATOR_WORK_DIR`; retried. Add disk or lower concurrency    |
| `provider_rate_limited`, `provider_unavailable`, `provider_timeout`                                                   | Retried (the adapter already retried twice). Persistent: check the provider's status   |
| `provider_auth`                                                                                                       | The API key is wrong or revoked. Not retried                                           |
| `provider_rejected`                                                                                                   | The provider refused the input (format, size). Not retried                             |
| `provider_outcome_unknown`                                                                                            | A request was sent and no answer arrived: see below. **Not retried automatically**     |
| `project_deleted`                                                                                                     | The project was deleted while the job was queued or running                            |
| `max_attempts`                                                                                                        | All attempts used. Retry by hand after fixing the cause                                |

**Stuck jobs:**

- A job whose worker died keeps its lease for at most 2 minutes. After that, any worker
  takes it over and resumes it.
- A late write from the old worker is refused because every write checks the lease
  token.
- The credit hold of an interrupted step is released by the stale-hold sweep (15
  minutes) or when the step is retried.

**Cancel:** cancelling releases the held credits, marks an export CANCELLED and stops a
running FFmpeg within one heartbeat.

**Provider outcome unknown.** When a request to the provider was sent but the connection
dropped or the request timed out, the provider may have done (and billed) the work. The
job fails with `provider_outcome_unknown`, its credit hold is released, and it is not
retried by itself. Pieces already transcribed are kept as a checkpoint on the step, so a
person's **Retry** pays the provider only for the pieces still missing. The
`creator_provider_outcome_unknown_24h` check counts these.

## 6. Data and isolation

- Every row carries `workspace_id`. The guarded Prisma client requires it, and database
  triggers refuse cross-workspace and cross-project references and changes to
  `workspace_id`.
- Project events are append-only.
- Pages and routes resolve the workspace from the session membership. Another
  workspace's ids return 404.
- Roles:
  - viewing needs `content.view`;
  - upload, processing, export and cancel need `content.create`;
  - editing segments and clips needs `content.edit`;
  - approving a clip needs `content.approve`.
- **Export requires an approved clip.** Changing the bounds or framing of an approved
  clip returns it to review.

## 7. Credits and costs

- **Estimate first.** The page shows the credit estimate before transcription,
  translation or export is requested (unchanged prices, § 2).
- **One hold per real step attempt,** captured in the fenced transaction that stores the
  result; released on failure, cancel, lost lease or deletion. Simulated work takes no
  hold.
- **No double charge on retries.** A step's partial results (transcribed pieces,
  translated batches) are saved as a checkpoint on the step, fenced by the lease. A retry
  or a takeover by another worker continues from the checkpoint and the customer is
  charged once, when the step succeeds.
- **Local and provider costs are recorded separately** on each step:
  `local_processing_ms` (worker time), and `provider_audio_seconds`,
  `provider_input_tokens`, `provider_output_tokens` and `provider_cost_micro_usd`
  (estimated from the documented per-minute price; the provider's invoice is the source
  of truth). Simulated steps record no provider cost.

## 8. Turning on the real provider (owner decision)

The adapter is `src/server/creator/providers/openai.ts`:

- **Transcription:** `POST /v1/audio/transcriptions`, model `whisper-1`,
  `response_format=verbose_json`, segment timestamps, with the language given as an ISO
  code (Arabic is supported). Audio is cut into 10-minute Opus pieces (24 kbit/s, well
  under the 25 MB request limit); media longer than 2 hours is refused.
- **Translation:** the Responses API (`store: false`), 40 lines per request as JSON
  data, with the count and order of lines validated. Timings are kept from the source.
- **Retries:** 429 and 5xx responses and connection errors before the request was sent
  are retried twice with backoff (honouring `Retry-After`). 401/403 is `provider_auth`,
  other 4xx is `provider_rejected`. No key, audio or text is logged; logs carry status
  codes and failure codes only.
- **Consent is bound to what the person saw** (Pass 10). The job records the provider
  id and region shown when the person confirmed. The worker sends nothing when the
  configured provider or its region differs: the job fails with
  `external_consent_missing` and the person asks again. A retry or another worker
  cannot widen it. The confirmation is in the audit log (`creator.processing_requested`:
  actor, time, `externalConsent`, `region`), for transcription and translation.

**Facts NOT verified from official sources (2026-10-19).** The OpenAI documentation and
pricing domains (`platform.openai.com`, `openai.com`) do not resolve from the build
environment. The model names, the 25 MB request limit, the Arabic support, the retention
statement and the price below come from the adapter's design and third-party
material. The owner must check each one on OpenAI's official pages, from a normal
network, before approval, and record the date checked.

**What the owner must decide and record before setting
`CREATOR_EXTERNAL_PROCESSING=approved`:**

1. The OpenAI organisation and project that will be billed, with a usage limit.
2. Data processing terms: OpenAI's DPA, and whether the account has zero data retention
   (public documentation states the audio endpoints do not retain data and are not used
   for training; this must be confirmed for the account in use).
3. Region: by default processing happens in the US. Data residency options depend on the
   account.
4. The price: about USD 0.006 per audio minute for `whisper-1` (third-party sources; the
   official pricing page could not be reached from the build environment). Update
   `OPENAI_WHISPER_MICRO_USD_PER_SECOND` if it differs.
5. The customer-facing privacy notice: customers must be told that audio and transcripts
   are sent to OpenAI.

Then, in staging first: set `CREATOR_AI_PROVIDER=openai`, `CREATOR_EXTERNAL_PROCESSING=approved`
and `OPENAI_API_KEY`, run one short test file of the team's own (never customer media),
and compare the recorded `provider_cost_micro_usd` with the usage dashboard.

**Decision record (to fill in; nothing is enabled until it is complete):**

| Item                                          | Decision | By / date |
| --------------------------------------------- | -------- | --------- |
| Billed OpenAI organisation and project        |          |           |
| Monthly usage limit set on that project       |          |           |
| DPA signed; zero data retention status        |          |           |
| Processing region accepted                    |          |           |
| Price per minute checked on the official page |          |           |
| Privacy notice text published                 |          |           |
| Staging test with the team's own file         |          |           |

## 9. Deleting a project, and data export

**Deleting** (`content.edit`; the person types the project name):

1. The project row is locked and set to `DELETING`. A database trigger refuses new
   sources, jobs, transcripts, clips and exports for it from then on.
2. Credit holds of its jobs are released; a running worker loses its next fenced write
   and stops with `project_deleted` (nothing is charged).
3. Every stored object (sources, open multipart uploads, exports) is written to
   `creator_storage_deletions` in the same transaction, and the content rows are
   deleted.
4. The worker's sweep deletes each object, retrying with backoff (1 minute doubling up
   to 6 hours) and recording the last error code. Once every object is confirmed gone,
   the project row is purged.

The page shows "deleting" and, if storage keeps failing, "storage clean-up is being
retried". **Kept on purpose:** the audit log (`creator.project_deletion_requested`,
`creator.project_purged`), the credit ledger, and the deletion queue rows (storage keys
only) as the record of what was removed.

**Stuck deletion:** `creator_storage_deletions_failing` (6 or more attempts) is critical.
Look at `last_error_code` in `creator_storage_deletions`, fix storage access, and the next
sweep continues; nothing needs to be reset by hand.

**Data export** (`content.edit`): `GET /api/w/{slug}/studio/projects/{id}/data` returns
one JSON document (`flexibx.creator-project.v1`) with the project, sources (metadata),
transcripts and segments, clips, exports, jobs with steps and credits charged, and
events. Media files are downloaded separately. Each export is audited
(`creator.project_data_exported`).

## 10. Monitoring

`ops-status` (and its alerts, through the existing tick) includes counts and ages only,
never names, ids, keys or text:

| Check                                   | Level                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `creator_worker_last_seen_age_seconds`  | warning if work is queued and the worker has not reported for 10 minutes                         |
| `creator_jobs_queued`                   | informational                                                                                    |
| `creator_oldest_queued_job_age_seconds` | warning after 15 minutes                                                                         |
| `creator_jobs_lease_expired`            | critical                                                                                         |
| `creator_jobs_past_deadline`            | warning                                                                                          |
| `creator_exports_failed_24h`            | warning above the threshold                                                                      |
| `creator_provider_failures_24h`         | warning above the threshold                                                                      |
| `creator_provider_outcome_unknown_24h`  | warning                                                                                          |
| `creator_uploads_not_cleaned`           | warning                                                                                          |
| `creator_storage_deletions_overdue`     | warning                                                                                          |
| `creator_storage_deletions_failing`     | critical                                                                                         |
| `creator_worker_disk_low`               | critical: the latest heartbeat reports less free scratch space than the largest job needs        |
| `creator_worker_cleanup_failed`         | warning: upload expiry or the deletion sweep failed since the previous heartbeat                 |
| `creator_worker_disk_full_24h`          | warning: steps failed with `worker_disk_full` in the last day                                    |
| `creator_project_deletions_stuck`       | warning: a deleted project whose files are not all removed after a day                           |
| `alert_delivery_failed`                 | warning: the tick's last alert delivery was refused (2-hour window; cleared by a successful one) |

The worker's age is measured from its last heartbeat, whatever it reported: a beat with
failed phases proves the worker is alive. Those phases are the separate checks above. An
alert that cannot be delivered cannot report itself. The tick therefore stores the
outcome (`ops_check_results` row `alert-delivery`), and an external uptime monitor polling
`ops-status` sees `alert_delivery_failed`. A failed delivery never stops the tick or the
worker.

## 11. Retention (proposed, not enforced)

**Today:**

- Sources and exports are kept until their project is deleted.
- The worker removes its scratch directories after 6 hours, or at the end of each job.
- Abandoned uploads expire with their session (`CREATOR_UPLOAD_SESSION_HOURS`).
- Deleted projects are removed as in § 9.

**A retention policy by age is the owner's decision.** Until it is approved, nothing is
deleted by age:

- `CREATOR_RETENTION_SOURCE_DAYS` and `CREATOR_RETENTION_EXPORT_DAYS` feed only
  `pnpm creator:retention-report`. It prints counts and bytes, in total and beyond the
  proposed age, and nothing else (no ids, names or keys).
- Enforcement will be a separate change. It will queue the objects through
  `creator_storage_deletions` as a project deletion does, and keep the audit and ledger
  records.

To decide: how long to keep sources after the last export, how long to keep exports, and
whether customers are told in advance (as for generated videos).

## 12. Not done yet

- The real provider has never been called (no approval, no key). Its documentation and
  price were not reachable from the build environment (§ 8).
- Nothing has run in a hosted environment: no real bucket (CORS, multipart, lifecycle
  rule), no hosted worker. The staging plan is ready (`STAGING_CREATOR_STUDIO.md`).
- The worker image target has not been built here. Its `apt-get` step needs
  `deb.debian.org`, which this build environment's network policy refuses (Pass 11).
  Since Pass 11 its build runs `scripts/creator/check-media-tools.sh` and fails without a
  suitable FFmpeg. The script itself is tested against the real FFmpeg and against
  deliberately broken wrappers (`media-tools-check.test.ts`). CI builds and checks the
  image once CI runs again.
- Retention by age (§ 11).
- A very long file (2 hours) may need more than one 10-minute TRANSCRIBE attempt. The
  checkpoint makes the retry continue, but this has not been measured against the real
  provider.
