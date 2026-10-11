# Storage providers (provider-independent storage, Wasabi as the intended initial provider)

Status: **implemented and tested with test doubles only. Not verified against a real Wasabi
account.** No bucket, region, endpoint or credential has been chosen or used. Do not treat
Wasabi as production-ready until the checks in §8 are recorded. Platform admin access has
**mandatory production blockers** (§9): MFA and fresh-session checks are NOT enforced yet.

## 1. Model

Application code uses the `StorageService` interface (`src/server/storage/storage.ts`):
`put`, `delete`, `getObject`, `getSignedUploadUrl`, `getSignedDownloadUrl`, `publicUrl`
and the optional `checkAccess` (a read-only bucket HEAD). Providers are adapters behind it:

| Provider id | Adapter                                    | Configuration                                                                                    |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `LEGACY_S3` | `S3StorageService`                         | `S3_*` environment variables (the original store; SeaweedFS locally).                            |
| `WASABI`    | `createWasabiStorage` → `S3StorageService` | Region, endpoint, bucket from the admin page; access keys from `WASABI_*` environment variables. |

`STORAGE_DRIVER=test-memory` replaces both with separate in-process stores (automated
tests only).

**Every object row records its provider** (`media_assets.storage_provider`,
`generated_video_files.storage_provider`, enum `StorageProvider`). A `StorageRouter`
(`src/server/storage/providers.ts`) resolves it:

- **Reads and deletes** go to the provider recorded on the row (`forProvider`).
- **New writes** go to the platform write provider (`writeTarget()`), which is recorded
  on the new row in the same operation.
- A provider that is not fully configured is **never replaced by another**: the router
  fails with `SERVICE_UNAVAILABLE` instead of reading, writing or deleting elsewhere.

Adding a provider later = one enum value (migration), one adapter, one router branch,
its settings and admin section.

## 2. Existing objects (legacy strategy)

- The migration `20261010090000_storage_providers` backfills every existing row to
  `LEGACY_S3` (column default). Nothing is assumed to be on Wasabi.
- The migration `20261010100000_storage_provider_required` then **drops that default**:
  every new object row must state the provider it was written to. An insert that omits it
  fails (NOT NULL) instead of silently claiming `LEGACY_S3` — a mislabelled row would send
  deletes to a store that does not hold the object, and a delete of a missing key
  "succeeds", hiding the error. The Prisma field is required (no `@default`).
- `storage_provider` and `storage_key` are **immutable** (database triggers), so a row can
  never be re-pointed at a provider that does not hold its object.
- The write provider stays `LEGACY_S3` until a platform administrator changes it.
- Changing the write provider **moves no data**. Objects stay where they were written and
  remain readable and deletable there. Copying existing objects between providers is a
  separate data migration that does not exist yet; it must be planned, tested and
  verified separately (it would need copy → verify → a provider-change step that the
  immutability trigger currently forbids on purpose).

## 3. Platform storage settings

Table `platform_storage_settings` (single row, `id = 1`): `write_provider`, Wasabi's
**non-secret** `wasabi_region`, `wasabi_endpoint`, `wasabi_bucket`, and `version`
(incremented by every change). A CHECK constraint refuses `write_provider = 'WASABI'`
unless all three are set.

**Concurrency** (`storage-admin.ts`, `providers.ts`):

- A settings save locks the row `FOR UPDATE` and decides under that lock — including the
  count of objects on Wasabi — then increments `version`.
- A write-provider change is a compare-and-set on `version` (and `write_provider`): if
  anything changed while its connection checks ran (e.g. a new bucket was saved), it is
  refused as `stale` — new files never go to a location that was not checked.
- An upload writes the object, then — in the same transaction that inserts its row —
  `StorageWriteTarget.confirm(tx)` share-locks the settings row and verifies Wasabi's
  location is still the one the object was written to. If it changed, the insert is
  refused (`CONFLICT`) and the object is removed again; a save waiting on the lock sees the
  committed row and refuses to move the location. **The future video pipeline must call
  `confirm(tx)` in the transaction that runs `recordGeneratedVideo`** (the fake-provider core does: `src/server/videos/generation/`; no real-provider pipeline exists
  yet; media uploads do this today).

Secrets are **never stored in the database**: `WASABI_ACCESS_KEY_ID` and
`WASABI_SECRET_ACCESS_KEY` come only from the server environment. The admin page shows
only whether they are present. Malformed keys count as missing.

Validation (`wasabiSettingsSchema`): region like `xx-name-1`; the endpoint must be an
`https` origin (no path, port, query or credentials) whose host is **the documented S3
service URL of that region**: `s3.<region>.wasabisys.com`, and for `us-east-1` also
`s3.wasabisys.com` (Wasabi, "Service URLs for Wasabi's Storage Regions"). A mismatched
pair is refused (`endpoint_region_mismatch`); Wasabi's console, IAM and STS hosts and the
short regional aliases are not accepted. S3 bucket naming rules apply. Confirm the URL
for the chosen region in the Wasabi console.

**Location lock:** region, endpoint and bucket cannot change while Wasabi is the write
provider or still holds objects — that would strand them. Moving Wasabi's location is a
data migration (§2).

## 4. Internal admin area

`/{locale}/admin` → Storage (`src/app/[locale]/admin/`), for **platform administrators
only** (Flexibx staff; not a workspace role, no self-service, no customer access).

- **Who:** `users.is_platform_admin = true` **and** a verified email, re-read from the
  database on every page and action (`src/server/admin/platform-admin.ts`). Revoking the
  flag takes effect on the next request.
- **How the flag is set:** only by an operator, directly in the database (§5). It cannot
  be set through any request (`input: false` in Better Auth, tested), by sign-up or seed,
  and a static test fails if application code writes it.
- **Everyone else** — signed-out visitors included — gets the standard 404 for every
  page, and `NOT_FOUND` for every action, before any input is validated (no field details
  leak). The pages are `noindex`.
- **Actions** (`src/server/admin/storage-admin-actions.ts`), each audited where it
  changes something (`storage.settings_updated` with field names only;
  `storage.write_provider_changed` with `from`/`to`; platform audit entries have no
  workspace):
  - save Wasabi settings;
  - test a provider's connection (live, read-only bucket HEAD, 10 s timeout; the result
    is a failure code only — never a provider message, host or key);
  - change the write provider: requires typing the provider id and a **passing live
    connection check of the target**. Every other provider that still holds objects is
    checked too, **only to warn**: an outage of the current provider must not block moving
    new uploads to a healthy one (failover). The warning states that the failing
    provider's existing files stay where they are and cannot be opened or deleted until it
    works again — they are never redirected to another provider. The audit entry lists
    them (`unavailableProviders`). The update is a compare-and-set on the settings version
    (`stale` otherwise).
- Responses carry outcome codes only. The view never contains keys.
- The admin UI text is part of the shared message bundle, so the area's existence is not
  secret; access control relies only on the server-side checks above.

## 5. Operator procedures

**Grant platform admin** (production; record who and when):

```sql
-- The person must already have an account with a verified email.
UPDATE users SET is_platform_admin = true WHERE email = '<staff email>' AND email_verified;
```

Revoke with `SET is_platform_admin = false`. Keep the list of administrators minimal.

**Enable Wasabi for new files** (only after §8 is recorded):

1. Create the bucket (private; no public access; versioning/Object Lock/lifecycle as
   decided in §8) and a key limited to that bucket.
2. Set `WASABI_ACCESS_KEY_ID` and `WASABI_SECRET_ACCESS_KEY` in the server environment and
   restart.
3. Admin → Storage: enter region, endpoint, bucket; save; **Test connection**.
4. Change the write provider to `WASABI` (typed confirmation). Existing files stay on
   `LEGACY_S3`, which must therefore stay configured and reachable.
5. Verify an upload and a download in the product, and one retention deletion.

## 6. Retention compatibility

The video retention job (`docs/AI_VIDEO_RETENTION_POLICY.md`) deletes each file from the
provider recorded on its row. Policy unchanged: files deleted 168 h after generation,
metadata purged 30 days after file deletion; schedule, rate limit, lock, bounded run and
audit unchanged. A file whose provider cannot be resolved (e.g. keys removed) counts as a
failed attempt and is retried with the normal backoff — it is never deleted from another
provider and never marked deleted. Orphan cleanup stays manual.

Within a run, a resolved provider and a "not configured" result are reused for every
later file; a transient failure (e.g. a database error reading the settings row) is
retried by later files, at most 3 times per provider per run (`resolveProvidersForRun`).
The deadline is checked before and after every resolution, so a slow database or an
unavailable provider cannot extend the bounded run (`worstCaseRunMs()` unchanged; see
`retention-policy.ts`). Files skipped this way are counted (`storageUnavailableFiles`) and
recorded with `last_deletion_error = 'storage_provider_unavailable'`. Such a run is **not**
reported as completed: status `storage_unavailable`, logged at `error`, the endpoint
answers **503** (body = the summary) and the CLI exits 1. `stoppedAtDeadline` in the
summary still says whether such a run also used up its time budget.

Application deletion is not permanent erasure: provider versioning, replication, backups
and billing rules may retain data or charges (retention policy §5).

## 7. Risks of switching

- `LEGACY_S3` must stay configured as long as it holds objects (no automatic migration).
- Failing over away from a broken provider keeps new uploads working, but the files on
  the broken provider stay unavailable until it is restored.
- The connection test is a bucket HEAD: it needs `s3:ListBucket` and does not prove the
  key may upload or delete. Verify put/get/delete in the sandbox (§8).
- AWS SDK for JavaScript `3.1146.0` sends flexible checksums by default
  (`requestChecksumCalculation` / `responseChecksumValidation` = `WHEN_SUPPORTED`). Some
  S3-compatible services have rejected them; no Wasabi-specific evidence was found either
  way, so the defaults are unchanged. If the sandbox round trip fails with checksum or
  signature errors, set both to `WHEN_REQUIRED` on the Wasabi client and re-test.
- Wasabi bills a **minimum storage duration** for objects deleted early (published as
  90 days on pay-as-you-go at the time of writing — verify against the current contract).
  Video files deleted after 168 h may therefore still be billed after deletion; this is a
  cost question, not a retention one.
- A wrong region/endpoint is caught by the connection test before switching, but Wasabi
  behaviour (error codes, path-style addressing) is verified only against SDK test doubles.
- Settings are read from the database per operation (one small query); the Wasabi client
  is cached per configuration and rebuilt when settings or keys change.

## 8. Not yet verified (production checks)

| Check                                                                                  | Status   |
| -------------------------------------------------------------------------------------- | -------- |
| Wasabi account, bucket, region and endpoint chosen                                     | **Open** |
| Connection test against the real bucket (HeadBucket with the restricted key)           | **Open** |
| Put / get / delete round trip against the real bucket (paid operation — approve first) | **Open** |
| Bucket private, versioning / Object Lock / lifecycle decided and recorded (O1–O6)      | **Open** |
| Minimum-storage-duration billing reviewed against the 168 h policy                     | **Open** |
| Key scope (bucket-only policy) and rotation procedure recorded                         | **Open** |
| First platform administrator granted (§5) and recorded — only after §9 is closed       | **Open** |
| SDK checksum defaults verified against Wasabi in the sandbox round trip (§7)           | **Open** |

## 9. Production gate: platform admin access (mandatory blockers)

Not enforced today — do **not** grant `is_platform_admin` in production until both are
implemented and tested:

| Blocker                                                                                                                                            | Status                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **MFA for platform administrators**: admin pages and actions refuse a session without a completed second factor (e.g. Better Auth two-factor).     | **Open — NOT enforced** |
| **Fresh session for changes**: saving settings and changing the write provider require a recent sign-in (re-authentication within a short window). | **Open — NOT enforced** |

Today an administrator is a verified account with the flag, authenticated by password and a
normal session. That is acceptable for local development and tests only.
