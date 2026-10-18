# Creator Studio — operations runbook (Pass 8)

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

| Part                                                           | Status                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Upload (signed PUT, size and type limits, expiry)              | Real. Tested with in-memory storage and S3 signing; never against a real bucket |
| File check (magic bytes, ffprobe, duration and size limits)    | Real FFmpeg/ffprobe                                                             |
| Audio extraction, cut, crop/scale, burned subtitles, MP4 check | Real FFmpeg (libx264, AAC, libass), tested on small synthetic files             |
| Transcription and translation                                  | **No real provider.** `disabled` (default) or `simulated` (tests and demos)     |
| Clip suggestions                                               | Rules on the transcript (`rules-v1`): questions, numbers, hook words, length    |
| Credits                                                        | Real holds, capture and release. Simulated work is never charged                |

- **The simulator is labelled everywhere.** Each simulated line reads "Simulated line n:
  …" or "نص محاكاة رقم n: …". Transcripts, clips and job steps carry `simulated = true`
  and show a "Simulated" badge, and the project page shows a notice. Subtitle files are
  named `…-simulated.srt` (VTT files also get a NOTE).
- **The simulator is refused in production** (`NODE_ENV=production`), like the other
  test providers. The one exception is the local end-to-end run (`FLEXIBX_TEST_PROVIDERS`
  with a localhost `APP_URL`).
- A real provider needs a separate decision covering which service, the data processing
  agreement, the region, the cost, and an explicit authorization to send user media to
  it (production readiness register, § 13). No paid API is called, and no user file
  leaves the server.

## 2. Configuration

| Variable                       | Default                   | Meaning                                                                                           |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `CREATOR_AI_PROVIDER`          | `disabled`                | `disabled`: upload, checking and manual clips only. `simulated`: test-only, refused in production |
| `CREATOR_MAX_UPLOAD_MB`        | 500 (1–500)               | Largest source file                                                                               |
| `CREATOR_MAX_DURATION_SECONDS` | 3600 (10–14400)           | Longest source media                                                                              |
| `CREATOR_FFMPEG_PATH`          | `ffmpeg`                  | FFmpeg binary (needs libx264, AAC and libass)                                                     |
| `CREATOR_FFPROBE_PATH`         | `ffprobe`                 | ffprobe binary                                                                                    |
| `CREATOR_FFMPEG_THREADS`       | 2 (1–16)                  | Threads per FFmpeg run                                                                            |
| `CREATOR_WORK_DIR`             | the system temp directory | Where per-job scratch directories are created                                                     |

Fixed in `src/server/creator/config.ts`:

- **Upload:** the URL is valid for 15 minutes; an unfinished upload expires 5 minutes
  after that.
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
job with a lease, so two workers never run the same job.

**At start,** the worker removes scratch directories older than 6 hours left behind by a
crashed run.

**Every 5 minutes,** it expires abandoned uploads and deletes their objects.

**Requirements for each worker host:**

- FFmpeg 6 or later, with libx264, AAC and libass, plus a font for subtitles (DejaVu
  Sans).
- The same `DATABASE_URL` and storage settings as the app.
- No inbound network access.
- **Memory:** the source file is read into memory once (as large as
  `CREATOR_MAX_UPLOAD_MB`), plus FFmpeg's own use. Plan for at least 2 GiB per worker
  with the 500 MB limit.
- **Disk:** about 3× the largest source per running job, in `CREATOR_WORK_DIR`.

**Safety of the FFmpeg runs:**

- FFmpeg and ffprobe run with an argument array and `shell: false`.
- The environment holds only `PATH` and `LC_ALL`, so no secrets reach them.
- Inputs are read with `-protocol_whitelist file` and `file:` paths, so FFmpeg has no
  network access.
- Output size is capped with `-fs`.
- On a timeout, a cancel or a lost lease, the process is killed with SIGKILL and the
  scratch directory is deleted.

## 4. Object storage (S3 / Wasabi)

The browser uploads straight to the bucket with a signed `PUT` that fixes the
`Content-Type` and `Content-Length`. The bucket therefore needs a CORS rule for the app's
origin:

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

**Not supported:** multipart or resumable uploads. A failed upload is started again, and
the incomplete one expires.

The in-app upload route (`PUT /api/w/{slug}/studio/uploads/{id}`) exists only for the
in-memory test store. It returns 404 everywhere else.

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

## 7. Not done yet

- A real transcription or translation provider (needs a decision and authorization).
- Multipart or resumable uploads, and streaming the source to disk (removes the memory
  bound).
- Retention for sources and exports. They are kept until a person deletes the project,
  and project deletion is not exposed yet.
- An `ops-status` check for creator jobs that stay queued (no worker running).
- Running the worker in any hosted environment.
