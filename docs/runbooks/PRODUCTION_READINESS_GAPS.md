# Production-readiness gap register

Status at HEAD `05654ea` (2026-10-16), Pass 2.4. This register lists what still stands
between the current code and a production launch, with the evidence for each item. It
does not mark anything complete on the strength of documentation: an item closes only
with the verification named in its row. Infrastructure decisions are kept in
[`PHASE_D_1_INFRASTRUCTURE_DECISIONS.md`](PHASE_D_1_INFRASTRUCTURE_DECISIONS.md) and the
staging checklist in [`PHASE_D_3_STAGING_READINESS.md`](PHASE_D_3_STAGING_READINESS.md);
they are summarized here, not repeated.

**Verdict: not production-ready.** Automated tests pass, but no hosting, credentials,
real provider or restore has been exercised, and the decisions in § 6 are open.

Severity: **Blocker** = launch must not happen while open; **High** = must be closed or
explicitly accepted before launch; **Medium** = accept with monitoring or close before
scale; **Low** = tracked.

## 1. CI verification

| Item                          | Status                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Required action                                                                                                | Safe verification                                                                                                                                                   | Separate approval                   |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| CI on the current branch head | **Verified green** for `05654ea`               | GitHub Actions run 37 (`CI`, push, 2026-10-16): jobs _Lint, typecheck, unit tests_ (frozen install, `prisma validate`, phase-status validation, `format:check`, typecheck, lint, unit), _Integration, build, e2e_ (PostgreSQL service, migrations applied and status verified, integration, build, Playwright E2E), _Docker image builds_ (`--target runner`, not pushed), _Secret scan_ (gitleaks 8.24.3 with `.gitleaks.toml` and `.gitleaksignore`) — all success | Keep CI required on the branch that is deployed                                                                | Re-check the run of the exact commit being deployed                                                                                                                 | No                                  |
| Secret-scan range             | **Medium**                                     | On push, gitleaks-action scans the pushed commits (the run for `05654ea` used `--log-opts=-1` for a one-commit push), not the whole history                                                                                                                                                                                                                                                                                                                          | Before launch, scan the full history once with the deployed config                                             | `gitleaks detect --redact --exit-code=2` on a full clone (Pass 2.4: no leaks; the one historical fake key in `48cce4c` is suppressed by its exact fingerprint only) | No                                  |
| `.gitleaksignore` scope       | Verified narrow                                | One fingerprint (`commit:file:rule:line`); Pass 2.2 proved the same literal in a new commit, on the same line or in another file, is still reported                                                                                                                                                                                                                                                                                                                  | Keep it to exact fingerprints; never add a file, path or rule exception there                                  | Re-run the proof in a scratch clone if the file changes                                                                                                             | No                                  |
| `ops` image                   | **High** (blocks role cutover and backup jobs) | CI builds only `--target runner`; the `ops` target was never built (package mirrors blocked in the development environment; D.3 R2)                                                                                                                                                                                                                                                                                                                                  | Build `--target ops` in CI (not pushed)                                                                        | CI job succeeds; `psql --version` inside the image                                                                                                                  | Yes — engineering item A5 (D.3 § 7) |
| Production build contents     | Verified for the Docker image                  | `.next/standalone/node_modules` contains no Prisma CLI, test runner, linter, `openai`, `tsx`, `deepmerge-ts`, `mysql2` or `braces`; no test-only markers in client bundles. Next.js copies a local `.env` into `.next/standalone/` — `.dockerignore` excludes `.env*`, so the image is clean, but a standalone folder built on a workstation would carry that workstation's `.env`                                                                                   | Deploy only images built by CI from a clean context; never copy a locally built `.next/standalone` to a server | Inspect the image: `docker run --rm --entrypoint ls <image> -a /app` shows no `.env`                                                                                | No                                  |

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

## 5. Operations (from D.3; still open in the code at this HEAD)

| Item                                         | Severity                         | Evidence                                                                           | Required action                                              | Approval                   |
| -------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------- |
| Tick time limit                              | **High**                         | `scripts/automation/tick.ts` has no overall deadline and no advisory lock (D.3 R4) | Wrap the task in a timeout; alarm on long runs               | Yes — engineering item A5  |
| Managed PostgreSQL, PITR restore, key escrow | **Blocker**                      | Nothing provisioned; restore drill never run on a managed instance (D.3 R3, R5)    | Staging rehearsal per D.3 § 5                                | Yes — provider, custodians |
| Secrets manager and key rotation             | **Blocker** / accepted by design | No secrets created; no key versioning (D.3 § 2.6, R7)                              | Create per-task secrets; document the incident-only rotation | Yes — provider             |
| Alert payload review                         | Medium                           | Payload `details` not yet reviewed for personal data (D.3 R9)                      | Review before connecting a destination                       | Yes — destination          |

## 6. Decisions that block staging (none assumed)

From D.3 § 7 and D.1 § 15.4, all still open: **A1** data residency (with legal advice),
**A2** hosting provider and region, **A3** staging budget and billing-alarm recipient,
**A4** account owner, IaC tool and reviewer, two custodians per credential, **A5**
engineering items (`ops` image in CI, tick time limit), **A6** monitoring and alert
destination with on-call names, **A7** real Meta and email connections, **A8** pilot
go/no-go.

## 7. What this pass verified (and how)

- CI run 37 for `05654ea`: all four jobs green (GitHub Actions API).
- Full-history gitleaks with the repository config: no leaks.
- `pnpm audit`: the four advisories above, unchanged.
- `.next/standalone` contents: no development tooling; the only `.env` value found in the
  local build was the documented MinIO development default, copied by Next.js from the
  workstation `.env` (excluded from Docker builds by `.dockerignore`).
- No deployment, no persistent-database operation, no paid API call and no real
  Meta/S3/Wasabi operation was performed.
