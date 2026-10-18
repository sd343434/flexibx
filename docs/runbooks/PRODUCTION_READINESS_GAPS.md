# Production-readiness gap register

Status reviewed in Pass 3.2 (2026-10-17) at HEAD `8820d9e` plus the Pass 3.2 fix; first
written in Pass 2.4. This register lists what still stands
between the current code and a production launch, with the evidence for each item. It
does not mark anything complete on the strength of documentation: an item closes only
with the verification named in its row. Infrastructure decisions are kept in
[`PHASE_D_1_INFRASTRUCTURE_DECISIONS.md`](PHASE_D_1_INFRASTRUCTURE_DECISIONS.md) and the
staging checklist in [`PHASE_D_3_STAGING_READINESS.md`](PHASE_D_3_STAGING_READINESS.md);
they are summarized here, not repeated.

**Verdict: not production-ready.** Automated tests pass, but no hosting, credentials,
real provider or restore has been exercised, and the decisions in § 6 are open.

Each item also carries one of four evidence states: **implemented and tested** (code
and automated tests in this repository), **documented, not exercised** (procedure written,
never run against real infrastructure), **blocked** (on infrastructure or an owner
decision), **requires approval** (a paid, real-provider or production action).

Severity: **Blocker** = launch must not happen while open; **High** = must be closed or
explicitly accepted before launch; **Medium** = accept with monitoring or close before
scale; **Low** = tracked.

## 0. Launch blockers by stage (Pass 3.2)

Stages: **private pilot** = internal team only, synthetic data, test Facebook Pages, no
customer data; **supervised pilot** = a few named customers, real data, every outbound
action supervised; **GA** = general availability. "Mocked" means exercised only against
local stand-ins (stand-in Graph API, fake AI/video providers, in-memory storage, test
mail outbox) — never evidence that the real provider works.

| Blocker                                                   | Status and evidence                                                                                                                                                                                                                                                                                                                                                    | External action or decision                                                                                                         | Safe verification                                                                                                    | Blocks                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Hosting, region, staging environment (A2, A4)             | **Blocked** on decision; nothing provisioned                                                                                                                                                                                                                                                                                                                           | Choose provider and region; name the account owner and reviewer                                                                     | Staging stack per D.3 § 5                                                                                            | Private pilot                                             |
| Managed PostgreSQL with PITR                              | **Blocked**; migrations validated only on disposable local databases (32 migrations, no drift, Pass 3.2)                                                                                                                                                                                                                                                               | Provision staging and production instances                                                                                          | `migrate deploy` on staging; restore drill (§ 5.1)                                                                   | Private pilot (staging), supervised pilot (restore drill) |
| Secrets manager, key custody (D.3 § 2.6)                  | **Blocked**; no secrets created                                                                                                                                                                                                                                                                                                                                        | Create per-task secrets; name two custodians per key                                                                                | Task starts with secrets injected, none in images (ops image check in CI)                                            | Private pilot                                             |
| Object storage (S3/Wasabi)                                | **Mocked only** (in-memory and local HTTP stand-ins)                                                                                                                                                                                                                                                                                                                   | Create a bucket and a restricted key                                                                                                | `STORAGE_PROVIDERS.md` § 8 round trip on staging                                                                     | Private pilot                                             |
| Scheduler (automation tick)                               | **Implemented and locally tested** (lock, budget, alerts); external trigger not configured                                                                                                                                                                                                                                                                             | Configure the 5-minute trigger and its timeout                                                                                      | One tick, then two concurrent ticks on staging; read the alerts                                                      | Private pilot                                             |
| Email delivery (Resend)                                   | **Mocked only** (test outbox; refused in production)                                                                                                                                                                                                                                                                                                                   | Verify a sending domain (SPF/DKIM/DMARC)                                                                                            | Send to test inboxes from staging                                                                                    | Private pilot (sign-up recovery), supervised pilot        |
| Meta: Page publishing (text and photo), replies, ads      | **Mocked only** (stand-in Graph API); photo caption reconciliation assumes Meta lists photo posts in `published_posts` with the caption as message (unverified)                                                                                                                                                                                                        | Meta app in development mode with test Pages; then App Review for customer Pages                                                    | Supervised publish of a text and a photo post to a test Page; lose an answer on purpose (network cut) and resolve it | Private pilot (test Pages), supervised pilot (App Review) |
| AI and video providers                                    | **Mocked only** (fake providers refused in production)                                                                                                                                                                                                                                                                                                                 | Choose providers; set spend caps                                                                                                    | Supervised calls on staging with caps                                                                                | Supervised pilot                                          |
| Monitoring and alert destination, on-call (A6)            | **Implemented** (alert sink, ops status); destination not connected; payload review open (D.3 R9)                                                                                                                                                                                                                                                                      | Choose the destination and on-call names                                                                                            | Trigger a test alert from staging                                                                                    | Supervised pilot                                          |
| Restore drill on managed database                         | **Documented, not exercised** (scripts tested with fakes and local throwaway databases)                                                                                                                                                                                                                                                                                | Staging database and custodians                                                                                                     | Drill per `BACKUP_RESTORE.md` §§ 4–5, timed and recorded                                                             | Supervised pilot                                          |
| Data residency and legal review (A1)                      | **Blocked** on legal advice                                                                                                                                                                                                                                                                                                                                            | Legal review of residency, terms, privacy notice                                                                                    | Signed-off decision record                                                                                           | Supervised pilot                                          |
| Pilot go/no-go (A8)                                       | **Blocked** on owner decision                                                                                                                                                                                                                                                                                                                                          | Named approver                                                                                                                      | Decision record                                                                                                      | Supervised pilot                                          |
| Payments and subscriptions                                | **Not implemented** (credits are provisional; no payment provider)                                                                                                                                                                                                                                                                                                     | Choose a payment provider and pricing                                                                                               | —                                                                                                                    | GA (pilots use admin credit grants)                       |
| Instagram publishing                                      | **Not implemented**                                                                                                                                                                                                                                                                                                                                                    | Public media hosting decision; `instagram_content_publish` and App Review                                                           | —                                                                                                                    | GA (feature gap only)                                     |
| Orphaned storage objects                                  | **Designed, not implemented** (§ 3.1)                                                                                                                                                                                                                                                                                                                                  | Approve `s3:ListBucket` and the procedure                                                                                           | Dry-run report on staging bucket                                                                                     | GA                                                        |
| Prisma tooling advisories                                 | Dev and migration tooling only (§ 2)                                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                   | Re-check on 2026-10-22                                                                                               | GA hygiene                                                |
| Campaign results (reach, engagement, clicks, sales, ROAS) | **Implemented for person-entered data** (Pass 5, § 10) **and for Meta Insights** (Pass 6, § 11): Page and Instagram account numbers, and the lifetime numbers of Page posts Flexibx published, read through the workspace's Meta connection into VERIFIED observations; **mocked only** (stand-in Graph API); ad spend and Instagram media are not linked to campaigns | Add the insights permissions to the Meta app, App Review for customer accounts, `META_INSIGHTS_ENABLED=true` and the tick's trigger | Manual sync of a test Page and Instagram account in staging, compared with Meta Business Suite (§ 11)                | GA (supervised pilot works with imported numbers)         |

## 1. CI verification

| Item                          | Status                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Required action                                                                                                                  | Safe verification                                                                                                                                                   | Separate approval                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| CI on the current branch head | **Verified green** for `7f0f169` (run 38) and `05654ea` (run 37)                                                                       | GitHub Actions runs 37 and 38 (`CI`, push, 2026-10-16): jobs _Lint, typecheck, unit tests_ (frozen install, `prisma validate`, phase-status validation, `format:check`, typecheck, lint, unit), _Integration, build, e2e_ (PostgreSQL service, migrations applied and status verified, integration, build, Playwright E2E), _Docker image builds_ (`--target runner`, not pushed), _Secret scan_ (gitleaks 8.24.3 with `.gitleaks.toml` and `.gitleaksignore`) — all success                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Keep CI required on the branch that is deployed                                                                                  | Re-check the run of the exact commit being deployed                                                                                                                 | No                                                 |
| Secret-scan range             | **Medium**                                                                                                                             | On push, gitleaks-action scans the pushed commits (the run for `05654ea` used `--log-opts=-1` for a one-commit push), not the whole history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Before launch, scan the full history once with the deployed config                                                               | `gitleaks detect --redact --exit-code=2` on a full clone (Pass 2.4: no leaks; the one historical fake key in `48cce4c` is suppressed by its exact fingerprint only) | No                                                 |
| `.gitleaksignore` scope       | Verified narrow                                                                                                                        | One fingerprint (`commit:file:rule:line`); Pass 2.2 proved the same literal in a new commit, on the same line or in another file, is still reported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Keep it to exact fingerprints; never add a file, path or rule exception there                                                    | Re-run the proof in a scratch clone if the file changes                                                                                                             | No                                                 |
| `ops` image                   | **High** until the first CI run of the Pass 2.5 commit is green; then implemented and tested (build), not exercised against a database | Pass 2.5: CI job _Docker image builds_ now also builds `--target ops` (not pushed) and runs `scripts/ops/check-ops-image.sh` in it with `--network none` and no credentials: non-root user, `psql`/`pg_dump`/`pg_restore` major version 16, `pnpm` runs offline as that user, no `.env*`/pgpass files under `/app`, `/home`, `/etc`, `/tmp`, no secret variables in the image environment, ops scripts parse. The check was exercised locally against stand-in images (pass, and each failure: root, client 15, unreadable pnpm cache, baked `.env.production`, `DATABASE_URL` set). The real `ops` image could not be built in the development environment: Docker Hub returned `429 Too Many Requests` and `deb.debian.org` / `apt.postgresql.org` are refused by the egress proxy (`CONNECT tunnel failed, response 403`). Fixed while reviewing: `pnpm` in the `migrate` and `ops` images would have downloaded pnpm at job time (corepack's cache was in root's home, unreadable by `node`); `COREPACK_HOME=/corepack` keeps it in the image | Confirm the CI run of the Pass 2.5 commit; then run one `ops` job in staging (`psql -c 'select 1'` against the staging database) | CI job log; staging task output                                                                                                                                     | Yes — staging (A5 done in code; A2/A4 for staging) |
| Production build contents     | Verified for the Docker image                                                                                                          | `.next/standalone/node_modules` contains no Prisma CLI, test runner, linter, `openai`, `tsx`, `deepmerge-ts`, `mysql2` or `braces`; no test-only markers in client bundles. Next.js copies a local `.env` into `.next/standalone/` — `.dockerignore` excludes `.env*`, so the image is clean, but a standalone folder built on a workstation would carry that workstation's `.env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Deploy only images built by CI from a clean context; never copy a locally built `.next/standalone` to a server                   | Inspect the image: `docker run --rm --entrypoint ls <image> -a /app` shows no `.env`                                                                                | No                                                 |

## 2. Dependency advisories (`pnpm audit`, 2026-10-16)

None of these packages is in the production image (checked in `.next/standalone`).

| Package (version)    | Severity                                                   | Path                                                          | Affected / fixed                   | Exposure                                                                           | Required action                                                                               | Approval                           |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| `deepmerge-ts` 7.1.5 | High (GHSA-ggr8-5vv4-36mx)                                 | `prisma` → `@prisma/config`                                   | `<8.0.0` / `8.0.0`                 | Development and migration tooling only (`prisma` CLI, also in the `migrate` image) | Upgrade `prisma`, `@prisma/client`, `@prisma/adapter-pg` together to **7.10.1** (ships 8.0.2) | No (patch), but see the gate below |
| `mysql2` 3.15.3      | High (GHSA-3f6p-5ww8-9rcr), Moderate (GHSA-rgwj-5xj2-c3m3) | `prisma` (exact pin)                                          | `<3.22.0` and `≤3.23.0` / `3.23.1` | As above; the code never connects to MySQL                                         | Same upgrade (7.10.1 ships 3.24.4). No override: it would contradict Prisma's exact pin       | As above                           |
| `braces` 3.0.3       | High (GHSA-vfj7-8cjw-p6xm)                                 | `@next/eslint-plugin-next` → `fast-glob` 3.3.1 → `micromatch` | `≤3.0.3` / none published          | Lint only, over this repository's own files                                        | None available; re-check upstream                                                             | No                                 |

**Gate for the Prisma upgrade:** 7.10.1 was published 2026-10-15 19:25 UTC; on
2026-10-16 it was the only 7.x patch and npm's `latest` tag pointed at a prerelease
(`8.0.0-rc.23`), so it was not adopted yet. Re-check on or after **2026-10-22**: if no
7.10.2 or regression report has appeared, upgrade the three packages together, then run
`pnpm install --frozen-lockfile`, `db:validate`, migrations on a disposable database,
the full unit and integration suites, build and E2E. Never take 8.x prereleases.

Pass 2.5 re-check (2026-10-16, ~19 h after 7.10.1): `pnpm audit` unchanged (3 high,
1 moderate, all the rows above); `prisma` `latest` still `8.0.0-rc.23`, `@prisma/client`
and `@prisma/adapter-pg` `latest` `7.10.1`, no 7.10.2. Not upgraded: no new evidence, and
the dated gate (2026-10-22) has not been reached. Next review trigger: 2026-10-22, or
earlier if an advisory reaches a package in the runtime image.

Pass 7 re-check (2026-10-18): `pnpm audit` unchanged (3 high, 1 moderate: the rows
above). **Trial upgrade to 7.10.1** in an isolated copy of the tree (never this checkout's
`node_modules`): install, `prisma generate`, `db:validate`, typecheck, lint, unit (1061/1061),
the full integration suite on a disposable database (842/842) and build all passed, and
`pnpm audit` then reports only `braces`. **Not adopted yet:** the lockfile shows that
7.10.1 also moves Prisma's bundled engines to an 8.1.0-based build
(`@prisma/engines-version 8.1.0-1.d1b3f37…`), i.e. the migration engine that runs
production migrations changes in a patch release three days old; the advisories reach
development and migration tooling only, never the production image. Keep the dated gate
(2026-10-22): if no 7.10.2 or regression report has appeared, apply exactly this change
(three version pins and the regenerated lockfile) and run the gates above plus a
migration on a copy of a real backup (§ 5.1).

## 3. Storage

| Item                                | Severity                                                                                        | Evidence                                                                                                                                                                                                                                                                                                     | Required action                                                      | Safe verification                  | Approval                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| Orphaned objects                    | **Medium** (cost and data hygiene, not exposure: objects are only served through database rows) | (a) `putOrCleanUp` deletes the key after a failed or timed-out write, but storage can complete an in-flight write after that delete, or the cleanup can fail; (b) `deleteMedia` removes the row first, so a failed object delete leaves only a log line ("Could not remove a deleted asset's stored object") | Design below; implement only with the listed permission and approval | Dry-run report on a staging bucket | **Yes** — needs `s3:ListBucket` and a real-provider run |
| Real-provider behaviour (S3/Wasabi) | **Blocker** for using Wasabi; High for any provider                                             | All storage tests use in-memory or local HTTP stand-ins; `STORAGE_PROVIDERS.md` § 8 lists the open checks (account, bucket, region, key scope, round trip, checksum defaults)                                                                                                                                | Supervised round trip on a staging bucket                            | § 8 checks with a restricted key   | **Yes** — paid operation                                |

### 3.1 Orphan reconciliation — design (not implemented)

What the data supports today: every object key is
`workspaces/{workspaceId}/{category}/{uuid}.{ext}`, written only by media uploads
(`content-media`) and generated videos (`generated-videos`); each is recorded once in
`media_assets.storage_key` or `generated_video_files.storage_key` (unique), together with
its `storage_provider`. Rows of deleted video files stay as tombstones (`deleted_at`),
so their keys stay known. What it does not support: the storage layer has no listing
operation, and an object's age is known only from the provider's `LastModified`.

Minimum design, all of it dry-run first:

1. A `list(prefix)` operation on the storage service (ListObjectsV2, paginated, bounded
   per run), used only by an operator CLI — no scheduler.
2. Per provider, per known category prefix: candidates are keys that match the key
   pattern, whose `LastModified` is older than a grace period well above the longest
   write (put deadline for 500 MiB is 530 s; use **24 h**), and that appear in **no** row
   of either table for that provider (tombstones included).
3. Output a report (key, size, age, workspace id) and nothing else. Deletion is a
   separate, explicit operator step per reviewed report, re-checking each key against the
   database immediately before deleting it; never by prefix, never bucket-wide.
4. Tests: a local S3 stand-in with referenced, unreferenced-but-young, and
   unreferenced-old objects; only the last are reported.

Prerequisites before writing it: the key scope decision (`s3:ListBucket` on the bucket),
a staging bucket, and approval of the procedure.

## 4. External services never exercised for real

| Service                                | Severity                                 | Evidence                                                                                                                                                                                            | Required action                                                           | Approval           |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------ |
| Meta (Ads, Pages, Instagram, WhatsApp) | **Blocker** for launching those features | Fake Graph API in every test; redirect URIs and webhooks not registered (`ADS_WHATSAPP_LIVE_TEST_SETUP.md` § 0, D.3 § 2.7); no Meta App Review exists yet (`PHASE_D_READINESS_ASSESSMENT.md`, § C1) | Supervised test with test accounts and minimum spend, kill switches ready | **Yes** (A7)       |
| Email (Resend)                         | **Blocker** for sign-up and recovery     | Stubbed HTTP client only; no sending domain verified                                                                                                                                                | Verify a staging subdomain (SPF/DKIM/DMARC), send to test inboxes         | **Yes** (A7)       |
| OpenAI / video provider                | High                                     | Deterministic fake providers in tests and E2E                                                                                                                                                       | Supervised calls with spend caps on staging                               | **Yes** — paid API |

## 5. Operations (from D.3)

| Item                                         | Severity                                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Required action                                                                                                                                                                                    | Approval                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Tick single flight and time budget           | Closed in code (Pass 2.5) — **implemented and tested**; not exercised on a real scheduler                           | `runScheduledAutomationTick` runs under a PostgreSQL advisory lock (`pg_try_advisory_xact_lock`, own 3-connection pool, transaction timeout 9 min): an overlapping tick runs nothing and returns `status: "skipped"` with warning `automation_tick_overlap`; the lock is released on commit, failure, timeout or a dropped session. A 4-minute budget starts no further phase once spent (`status: "partial"`, `skippedPhases`, warning `automation_tick_over_budget`); skipped phases run on the next tick. Tests: `tests/integration/automation-tick-lock.test.ts` (overlap, release after failure/timeout, killed session, budget, alerts; mutants without the lock or the budget fail). No DB migration, no schedule change. Residual: a phase already running is not interrupted at the budget (each phase keeps its own per-item bounds); the platform task timeout remains the outer limit | Set the task runner's timeout above 9 min only if ticks are run as tasks; route the two warnings to the alert destination; verify in staging: one tick, then two concurrent ticks, read the alerts | Yes — A6 (alert destination)          |
| Managed PostgreSQL, PITR restore, key escrow | **Blocker**                                                                                                         | Nothing provisioned; restore drill never run on a managed instance (D.3 R3, R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Staging rehearsal per D.3 § 5                                                                                                                                                                      | Yes — provider, custodians            |
| Restore scripts                              | Implemented and tested (fake tools, local throwaway databases); **documented, not exercised** on managed PostgreSQL | Pass 2.5 review of `db-restore.sh`: checksum verified before connecting, exact `--confirm-target` against `current_database()`, refusal of a target with any `public` table, `pg_restore --single-transaction --exit-on-error` into the confirmed name only, credentials only as libpq variables and a 0600 password file. No defect found; failure modes and the no-partial-restore guarantee are now spelled out in `BACKUP_RESTORE.md` § 4. Tests never reach a real database (`tests/unit/ops-db-scripts.test.ts` uses fake `pg_dump`/`psql`/`pg_restore`)                                                                                                                                                                                                                                                                                                                                    | Staging restore drill, prerequisites in § 5.1; evidence: drill record per `BACKUP_RESTORE.md` § 5                                                                                                  | Yes — staging database and custodians |
| Secrets manager and key rotation             | **Blocker** / accepted by design                                                                                    | No secrets created; no key versioning (D.3 § 2.6, R7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Create per-task secrets; document the incident-only rotation                                                                                                                                       | Yes — provider                        |
| Alert payload review                         | Medium                                                                                                              | Payload `details` not yet reviewed for personal data (D.3 R9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Review before connecting a destination                                                                                                                                                             | Yes — destination                     |

### 5.1 Staging restore drill — prerequisites

1. A staging managed PostgreSQL 16 instance and a second, empty database on it (A2, A4).
2. The `ops` image built by CI from the commit under test (§ 1).
3. Per-task secrets for the owner (backup) role and the restore target (D.3 § 2.6), never
   production credentials.
4. Synthetic or seeded data only — no customer data in staging (A1).
5. A private location for the dump with encryption at rest and a retention rule.
6. The drill steps of `BACKUP_RESTORE.md` §§ 4–5 (backup → restore with
   `--confirm-target` → `db-roles.sql` → `db-verify.sh` → manual checks), plus PITR into a
   new instance, timed; the record (times, counts, verify output) attached to the ops log.
7. A named operator and reviewer (A4, A6).

### 5.2 Product workflow: content scheduling and Facebook publishing (Pass 3.0)

Fixed and tested (integration on a disposable database with a stand-in Graph API; no
real Meta call):

- Rescheduling content (content page or calendar) left its queued post at the old time;
  unscheduling and "mark as published" left the post to go out anyway (it was cancelled
  later with a wrong reason). Waiting posts now follow the content in the same
  transaction; in-flight or unconfirmed posts are never touched, and content with such a
  post cannot be deleted.
- "Publish now" held approved content until its planned date and implied instant
  publishing. It is now "Queue for the next run" and queues for the next scheduler tick.
- A due post held by the server (sending switched off, Meta not set up, no or expired
  connection, emergency stop, scheduler not running) showed only "Scheduled"; the content
  page now names the reason and where to fix it. Error codes without a message
  (`missed_window`, `rate_limited`, ads token codes) showed "Something went wrong"; every
  stored code now maps to an actionable message in Arabic and English.

### 5.3 Content review and publishing (Pass 3.1)

| Item                                                                                                                                           | State                                                       | Evidence / blocker                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request changes with a reason; review history; resubmission                                                                                    | **Implemented and locally tested**                          | `content_reviews` (migration `20261016120000_content_reviews`, not applied to any persistent database); integration tests for the reason, blank/too-long refusals, roles (EDITOR/VIEWER refused, CLIENT/MANAGER allowed), another workspace, two concurrent reviewers, database immutability; E2E: request changes → author sees the reason → resubmit → approve |
| Facebook photo posts (first attached JPEG/PNG ≤ 4 MiB, uploaded as bytes)                                                                      | **Tested only with a mocked provider** (stand-in Graph API) | Migration `20261016130000_social_post_images`; integration tests: upload body, caption with link, no storage URL sent, refusals at queue time, image missing/unreadable/not an image → certain failure before any call, lost answer → uncertain → found by caption, never uploaded twice. Never sent to the real Graph API                                       |
| Publication states on the content page (queued / scheduled / on hold / publishing / published with post id / failed / uncertain / cancelled)   | **Implemented and locally tested**                          | Pure `publicationDisplayState` (unit tests per state); only a confirmed outcome reads as published                                                                                                                                                                                                                                                               |
| Real Meta photo publishing: `pages_manage_posts` on the app, caption lookup of photo posts in `published_posts`, Meta's size/format acceptance | **Blocked** on a real Meta app and App Review               | Needs a supervised test on a test Page (§ 4)                                                                                                                                                                                                                                                                                                                     |
| Instagram publishing                                                                                                                           | **Not implemented** (out of scope)                          | Needs `instagram_content_publish`, a public image URL for the Instagram API, and App Review: requires a decision on public media hosting                                                                                                                                                                                                                         |
| Publication timing                                                                                                                             | **Depends on infrastructure**                               | The external scheduler's interval (every 5 minutes by design); unchanged                                                                                                                                                                                                                                                                                         |

Still open from 3.0: publishing is only as timely as the external scheduler.

### 5.4 Pass 3.2 audit

- **Fixed:** reconciling an `UNCERTAIN` Page post took the first Page post with the same
  text in the lookup window. With two such posts (two items with the same body, or a
  manual post) it could mark the wrong one as ours — a false success. The lookup now
  returns every match; matches already recorded on another of the workspace's posts are
  set aside; exactly one remaining candidate → published, none → confirmed not published,
  several → stays `UNCERTAIN` (`social_cannot_verify`) for a person to check on the Page.
  Regression tests in `social-manager.test.ts`; two mutants (no ambiguity guard, no
  exclusion of recorded ids) fail them.
- Residual: a post by someone else with the same text within ±5 minutes, while ours was
  never published, is indistinguishable by text and would be taken as ours. Meta gives no
  stronger key for a lost answer; accepted for the pilot, checked in the supervised test.
- Checked without finding defects: review decisions are written only by
  `transitionContent` (one path; append-only in the tenant guard, including the nested
  `ContentItem.reviews` relation; immutable by trigger); content status changes only there
  and in the publisher after a confirmed outcome; provider ids are rendered
  left-to-right-isolated everywhere they appear (publishing card, ads, WhatsApp).

## 6. Decisions that block staging (none assumed)

From D.3 § 7 and D.1 § 15.4, all still open: **A1** data residency (with legal advice),
**A2** hosting provider and region, **A3** staging budget and billing-alarm recipient,
**A4** account owner, IaC tool and reviewer, two custodians per credential, **A6** monitoring and alert
destination with on-call names, **A7** real Meta and email connections, **A8** pilot
go/no-go. **A5** (engineering: `ops` image in CI, tick time limit) is done in code in
Pass 2.5; it closes when the CI run of that commit is green.

Still not complete, and not marked so without the named evidence: real-provider
validation (Meta, email, AI, S3/Wasabi), managed PostgreSQL, monitoring destination,
secrets management, a restore drill on real infrastructure, Meta App Review, data
residency and legal review, pilot approval.

## 7. What Pass 2.5 verified (and how)

- CI run 38 for `7f0f169`: success (GitHub Actions API).
- Tick lock and budget: integration tests on a disposable PostgreSQL 16 database; two
  mutants (lock bypassed, budget disabled) each fail two tests.
- `ops` image check script: exercised against stand-in containers; the real image build
  was blocked locally (Docker Hub 429, Debian/PGDG mirrors refused by the proxy) and is
  left to CI.
- `pnpm audit` and Prisma releases re-checked: unchanged, not upgraded (§ 2).
- No deployment, no persistent-database operation, no paid API call and no real
  Meta/S3/Wasabi operation was performed.

## 8. What Pass 2.4 verified

- CI run 37 for `05654ea`: all four jobs green (GitHub Actions API).
- Full-history gitleaks with the repository config: no leaks.
- `pnpm audit`: the four advisories above, unchanged.
- `.next/standalone` contents: no development tooling; the only `.env` value found in the
  local build was the documented MinIO development default, copied by Next.js from the
  workstation `.env` (excluded from Docker builds by `.dockerignore`).

## 9. Pass 4: campaign content plans (what works today)

- **Implemented and tested locally** (unit, integration on disposable PostgreSQL 16, E2E
  in Arabic and English): campaign → brief → AI-proposed or hand-written posts → edits →
  approval → content drafts (each once) → the existing review workflow → progress and
  next steps on the campaign page. Roles: managers and above plan and approve; editors,
  viewers and clients read; content creation still follows its own permissions. Tenant
  isolation in the services and in database triggers; stale versions refused; concurrent
  conversion creates each draft once; AI failures leave the plan unchanged. Ten mutants
  of the critical rules each fail a test. Migration `20261017120000_campaign_plans` was
  applied to disposable databases only, with no schema drift.
- **Mocked only**: AI proposals (fake provider; its text is labelled as sample data on
  the page). Facebook publishing outcomes shown in progress come from the existing
  publisher, still validated only against the stand-in Graph API (§ 0).
- **Not implemented**: engagement and business results (no analytics provider);
  publishing to Instagram, WhatsApp campaigns from a plan or email (these channels are
  planned in Flexibx and published outside it); automatic queuing of approved items
  (a person queues each one from its content page).
- **Not verified**: CI (GitHub Actions jobs blocked before execution since run 43); any
  real provider; production readiness.

## 10. Pass 5: marketing intelligence (what works today)

- **Implemented and tested locally** (unit tests, integration tests on disposable
  PostgreSQL 16, E2E in Arabic and English; architecture § 21):
  - **Import.** Managers import campaign results as CSV. Every row is validated, and
    problems are reported by row number. A repeated submission, a duplicate row or a
    conflicting value never adds or overwrites a number. Imports can be voided, and
    observations are append-only history.
  - **Dashboard.** It shows recorded totals per campaign with their source, budget
    against recorded spend in the same currency, goals measured in a metric, a trend,
    content comparison, freshness and import history.
  - **Recommendations.** Rule-based, with evidence (period, sample size, sufficiency,
    numbers), suggested action and limits. Thresholds are documented on the page. With
    too little data, the answer is "more data needed".
  - **Decisions.** Review, dismiss with a reason, snooze, reopen. Every decision is
    versioned and audited.
  - **Draft from a recommendation.** It is created once, as a `DRAFT` that goes through
    the normal approval workflow.
  - **Roles and isolation.** Viewers and clients read; managers and above import, void
    and decide. Tenant isolation is enforced in the services and by database triggers.
  - **Concurrency.** Imports of one workspace are serialized.
  - **Test strength.** Twelve mutants of the critical rules each fail a test (advisory
    lock, conflict versus overwrite, simulated data excluded, same-currency spend, the
    comparison minimum, version check, settled `ACTED`, voided imports, cross-workspace
    filter, non-actionable kinds, future periods).
  - **Migration.** `20261018090000_marketing_intelligence` was applied to disposable
    databases only, with no schema drift.
- **Mocked only.** The provider path (`MetricsProvider`) is exercised with the
  deterministic `test-fixture` adapter: success, unavailable, timeout, malformed and
  contradictory batches. Its numbers are `SIMULATED`: labelled "Simulated (not real)",
  shown apart from recorded numbers and never used in recommendations. The adapter is
  refused in production and no UI triggers it.
- **Not implemented:**
  - fetching from Meta Page or Instagram insights, ads insights, email or web analytics;
  - scheduled syncs;
  - currency conversion;
  - de-duplicated reach across periods (reach is added per period and labelled as such);
  - attribution, forecasts or causal analysis (deliberately absent);
  - per-workspace threshold settings;
  - a CSV export.
- **Limitations to accept or close:**
  - Person-entered numbers are only as accurate as their source. The page labels them
    "Entered by a person".
  - Findings are associations between recorded numbers, not causes.
  - Below-target compares against a straight pro-rata pace.
  - A workspace's observations are read up to 20,000 rows per request; the page says
    when that limit was hit.
  - Deleting a content item deletes its observations.
- **Before a real provider (requires approval; nothing below was attempted):**

  | Item                        | Requirement                                                                                                                                                                                                                                                           | Safe verification                                                                                                                                                                              |
  | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Meta Page insights          | Page token with insights permissions (at the time of writing `read_insights` and `pages_read_engagement`; confirm against Meta's current documentation), granted through App Review for customer Pages; metric names and their deprecations checked at implementation | Meta app in development mode with a test Page; fetch one week read-only; compare with Meta's own figures; store as `VERIFIED` only after the database check is relaxed in a reviewed migration |
  | Instagram insights          | Professional account linked to a Page; `instagram_manage_insights` through App Review                                                                                                                                                                                 | Same, with a test professional account                                                                                                                                                         |
  | Ads insights (spend, CTR)   | `ads_read` on the ad account (already requested for advertising, § 4)                                                                                                                                                                                                 | Read the insights of a paused test campaign with zero spend                                                                                                                                    |
  | Token storage and refresh   | Encrypted with the existing `ENCRYPTION_KEY` scheme; expiry and revocation handled as a failed import, never as zeros                                                                                                                                                 | Revoke the test token and confirm a `FAILED` import with its code                                                                                                                              |
  | Rate limits and scheduling  | Provider call budget per workspace; the scheduler tick (§ 0) to run syncs                                                                                                                                                                                             | Two concurrent syncs on staging: one batch stored, the other recognized                                                                                                                        |
  | Retention and data deletion | A retention rule for observations; the Meta data-deletion callback extended to them                                                                                                                                                                                   | Deletion request on staging removes the workspace's provider observations                                                                                                                      |

- **Not verified:** CI (GitHub Actions jobs blocked before execution since run 43); any
  real provider; production readiness.

## 11. Pass 6: Meta Insights integration (what works today)

- **Implemented and tested locally.** Unit tests, integration tests on disposable
  PostgreSQL 16 with the real Meta clients against a stand-in Graph API, and E2E in
  Arabic and English (architecture § 22). What is covered:
  - **Connection and permissions.** The existing Meta connection asks for the insights
    permissions when `META_INSIGHTS_ENABLED=true`. The OAuth state is bound to the
    person, workspace and platform: a forged state, or another member's, is refused
    before any exchange.
  - **Sources.** People with `social.manage` choose which of the workspace's Pages and
    Instagram accounts are read.
  - **Syncs.** A run is started by a manager ("Sync now") or by the scheduled tick. It
    reads a Page's or Instagram account's daily views, reach and interactions (stored at
    account level, never as a campaign's result) and the lifetime numbers of Page posts
    Flexibx published for a campaign's content (linked to that content and campaign).
  - **Data accuracy.** Revisions are stored beside the earlier values; the latest counts
    once. Meta's number and a person's number for the same content and metric are never
    added together. A real zero, a missing value and a metric Meta does not offer are
    kept distinct.
  - **Failure handling.** One run per source at a time (a lease, plus a database index).
    Runs are bounded and resumable, and a dead runner's run is closed. Rate limits and
    transient errors are retried with backoff and jitter.
  - **Losing access.** An expired token, a missing permission, a Page gone from the grant
    or an Instagram account unlinked from its Page stop the source with a clear status.
    Disconnecting Meta and Meta's deauthorize and data-deletion callbacks turn every
    source off.
  - **Roles and isolation.** Viewers and clients read, managers sync, admins choose
    sources. Tenant isolation holds in the services and in database triggers.
  - **No token leaks.** No token reaches a run, an import, an audit entry or a stored
    number (checked by a test).
  - **Mutation checks.** Fifteen mutants of the critical rules each fail a test.
  - **Migration.** `20261019090000_meta_insights_sync` was applied to disposable
    databases only, with no schema drift.
- **Hardening review (after the first Pass 6 commit), with tests written first:**
  - A run that read only part of what was due (a limit hit after some reads, or a
    published post gone from Meta) showed as "up to date". It now shows as "partly read"
    with its reason. A gone post is not retried hourly.
  - The pause before a retry could take a run up to 8 s past its 90 s deadline. The pause
    now ends at the deadline.
  - Separate from Pass 6: an existing two-factor integration test
    (`tests/integration/admin-mfa.test.ts`) failed when a 30-second TOTP boundary fell
    between enrollment and sign-in. It recomputed "the enrollment code" from the clock,
    which then yields a different, never-used code that rightly signs in. This was
    reproduced deterministically with a pinned clock. The test now keeps and replays the
    exact code used to enroll. The sign-in and replay-refusal behaviour is unchanged.
- **Never exercised against real Meta.** No Meta app, token or account was used. The
  metric names follow Meta's 2025 changes as reported by secondary sources, because
  Meta's documentation site could not be reached from the build environment. Confirm
  them against the Graph version in use; a renamed metric shows as "not offered", never
  as zero.
- **Not implemented:**
  - Instagram media insights linked to content (Flexibx does not publish to Instagram).
  - Ad spend in campaign results (no reliable link from an ad plan to a campaign).
  - Currency conversion.
  - Reach de-duplicated across days (reach is added per day and labelled so).
  - Picking Pages in the Insights page itself (Pages are listed by the Social Manager's
    Page sync).
  - An insights-only Meta grant (the connection still requires `ads_read`).
- **Decisions open:**
  - Whether Meta-derived numbers are deleted when Meta sends a data-deletion request.
    Today the sources stop and the numbers stay; they are Page and post metrics with no
    personal data.
  - A retention period for observations.
- **Before real use (requires approval; nothing below was attempted):**

  | Item                 | Requirement                                                                                                                                                                                                        | Safe verification                                                                                                                                                          |
  | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Meta app permissions | `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights` added to the app (and to the Login for Business configuration when `META_CONFIG_ID` is set)            | App in development mode; an app role connects a test Page and a test Instagram professional account; the Insights page shows "Meta is connected" and no missing permission |
  | App Review           | Each permission above approved for customer Pages (with screencasts of this read-only use), plus Business Verification                                                                                             | Approval record; then one supervised customer Page                                                                                                                         |
  | Metric names         | `page_media_view`, `page_total_media_view_unique`, `page_post_engagements`, `post_media_view`, `post_total_media_view_unique`, `post_clicks`, `views`, `reach`, `total_interactions` valid on `META_GRAPH_VERSION` | One manual sync of a test Page and a test account in staging; compare a week with Meta Business Suite; any name listed as "not offered" is checked in Meta's changelog     |
  | Scheduler            | The tick's external trigger (§ 0) running every 5 minutes                                                                                                                                                          | Enable one source in staging; after a day, a SCHEDULED run with SUCCEEDED and a new coverage end                                                                           |
  | Token expiry         | Long-lived user tokens last about 60 days; a person reconnects                                                                                                                                                     | Revoke the test token in Meta; the next sync is FAILED `token_expired`, the connection asks to reconnect, nothing is retried automatically                                 |
  | Rate limits          | Meta's per-app and per-Page budgets with many workspaces                                                                                                                                                           | Staging run with several test Pages; read the run records for `rate_limited` and the retry spacing                                                                         |
  | Data deletion        | Decision above; the data-deletion callback is already registered for advertising                                                                                                                                   | Deletion request from a test user turns sources off (and deletes numbers, if so decided)                                                                                   |

- **Not verified:** CI (GitHub Actions jobs blocked before execution since run 43); any
  real Meta call; production readiness.

## 12. Pass 7: operational reliability — status by evidence

Pass 7 (2026-10-18) fixed and tested the scheduler, monitoring and restore findings in
[`OPERATIONAL_RELIABILITY.md`](OPERATIONAL_RELIABILITY.md). Each launch-relevant area by
the strongest evidence that exists today. States: **A** implemented and proven locally;
**B** implemented, not proven in an external environment; **C** needs an account or
service; **D** needs a legal or security approval; **E** needs a supervised production
test; **F** not implemented.

| Area                             | State     | Evidence / what is missing                                                                                                                                                                                                       |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler tick behaviour         | A, then E | Single flight, per-item time budget, lease renewal and fenced writes for video jobs, late-answer safety for replies, failed social steps reported: integration-tested. Never run by a real scheduler.                            |
| Scheduler trigger                | C         | No scheduler is configured (no hosting). `AUTOMATION_CRON_SECRET` and the call are documented (ARCHITECTURE).                                                                                                                    |
| No duplicate external actions    | A, then E | Claims by lease / compare-and-set, unknown outcomes never re-sent, a taken-over video runner cannot charge twice: tested against stand-ins only.                                                                                 |
| Operator status (`ops-status`)   | A         | 11 new checks (hung / partial tick, retention, stuck leases, overdue video jobs, Insights failures, video provider failures); secret, 404, 429 and no-customer-data tested.                                                      |
| External alerting                | B, C      | Webhook delivery, throttle and the new give-back on failed delivery are tested with fakes; no destination is configured, and an external uptime monitor (the only alert when the scheduler itself stops) has no account.         |
| Backup / restore scripts         | A         | Checksum-verified dump and manifest, confirmed empty target, one transaction, verification of counts, integrity, restore checks, schema objects and migrations: unit-tested and drilled locally (OPERATIONAL_RELIABILITY § 3.1). |
| Off-site backups and PITR        | C         | Needs the managed database / storage decision (§ 6, PHASE_D_1).                                                                                                                                                                  |
| Restore drill, RTO / RPO         | E         | Only a local drill on seed data. No production-sized restore, no measured RTO, no RPO from real PITR.                                                                                                                            |
| Secrets storage                  | C         | Environment variables only; no secret manager chosen.                                                                                                                                                                            |
| Application and database hosting | C         | Not chosen (§ 6).                                                                                                                                                                                                                |
| CI (GitHub Actions)              | C         | Not proven: every run since #43 (latest #47, `9fca28e`) failed in 2–3 s with 0 billable ms, before a runner was allocated — an account-level block, not a code failure. Local gates are not a substitute.                        |
| Meta app review and permissions  | C, D      | No real Meta app call was ever made; Graph v26.0 metric names and permissions unverified (§ 11); App Review not started.                                                                                                         |
| Data residency and legal         | D         | Region, DPA, privacy policy and retention periods need an owner's legal decision (§ 6).                                                                                                                                          |
| Dependency advisories            | B         | Prisma 7.10.1 upgrade verified in isolation, deferred to the 2026-10-22 gate (§ 2); `braces` has no fix upstream.                                                                                                                |
| Planning task retry overlap      | F (low)   | A timed-out planning task may start its retry while its AI call (bounded by `AI_TIMEOUT_MS`) is finishing; the abort signal is not passed into the AI call.                                                                      |

## 13. Pass 8: Creator Studio — status by evidence

Pass 8 (2026-10-18) added the Creator Studio pipeline ([`CREATOR_STUDIO.md`](CREATOR_STUDIO.md)).
States as in § 12.

| Area                                     | State     | Evidence / what is missing                                                                                                                                                            |
| ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload, checking, limits, expiry         | A, then B | Integration-tested with the in-memory store; E2E through the in-app test route. Never run against a real bucket (CORS rule in the runbook, § 4).                                      |
| FFmpeg analysis, cut, reframe, subtitles | A         | Real FFmpeg 6.1 in the integration suite on small synthetic files; output verified by ffprobe. CI now installs FFmpeg (unproven while CI is blocked, § 12).                           |
| Worker, leases, timeouts, cancel         | A         | Lease loss, takeover, step timeout with SIGKILL, cancel and resume: integration-tested. Never run as a hosted process.                                                                |
| Credits (hold / capture / release)       | A         | No double charge on lease loss or retry, release on failure and cancel, insufficient credits: integration-tested. Prices are provisional (`pricing.ts`) and need an owner's approval. |
| Transcription and translation            | C, D      | **Simulator only** (labelled; refused in production). A real provider needs a choice, a DPA, a data region and explicit authorization to send user media. Default `disabled`.         |
| Clip suggestions                         | A         | Rule-based (`rules-v1`) on transcript text and timing; no AI. Quality on real speech unmeasured until a real transcript exists.                                                       |
| Large files                              | F         | Single signed PUT, at most 500 MB; no multipart or resumable upload; the worker holds the source in memory once.                                                                      |
| Retention of sources and exports         | F         | Kept until the project is deleted; deletion is not exposed yet. Needs a retention decision.                                                                                           |
| Monitoring of creator jobs               | F         | No `ops-status` check for queued jobs without a worker.                                                                                                                               |
