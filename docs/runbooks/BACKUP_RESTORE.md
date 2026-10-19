# Backup and restore runbook

Status (2026-10-12): scripts and checks are in the repository and were tested end to end
on local throwaway databases (see "Restore drill" below). **No production backup exists
yet**: no hosting provider, managed database or backup storage has been chosen. Nothing
here has been run against production.

## 1. What must be backed up

| Data                                                                                | Where                                     | Why it matters                                                                                                                         |
| ----------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL database (all tables, incl. `_prisma_migrations`, triggers, constraints) | `DATABASE_URL`                            | Everything: accounts, workspaces, content, credit ledger (append-only, financial), audit log, social/ads state.                        |
| Object storage: media library, generated videos (`workspaces/<id>/…` keys)          | S3-compatible bucket (legacy S3 / Wasabi) | Customer uploads and paid generated videos. Rows in `media_assets` / `generated_video_files` point to these keys.                      |
| Secrets: `AUTH_SECRET`, `ENCRYPTION_KEY`, provider keys, cron/ops secrets           | Hosting secret store (not the repository) | Without `AUTH_SECRET` two-factor secrets and backup codes cannot be decrypted; without `ENCRYPTION_KEY` stored platform tokens cannot. |

Not backed up on purpose: `rate_limits`, `verifications` (short-lived), local `.env`
files, build output. They are restored as-is with the database dump anyway; nothing depends
on them surviving.

## 2. Frequency, retention and protection (required before launch)

| Item                   | Requirement                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Point-in-time recovery | Managed PostgreSQL with continuous WAL archiving / PITR, **≥ 7 days** window (target RPO ≤ 5 minutes). Only if the chosen provider supports it — otherwise the daily dump below is the only recovery point (RPO 24 h).                                                                  |
| Logical dump           | `scripts/ops/db-backup.sh` **daily**, plus before every deploy that contains a migration (§ DEPLOYMENT.md).                                                                                                                                                                             |
| Retention              | Daily dumps 14 days, weekly 8 weeks, monthly 12 months (adjust to legal advice; the audit log and credit ledger are financial records).                                                                                                                                                 |
| Location               | A storage account/bucket **separate** from production (different credentials; ideally a different provider or region). Never this repository, never a laptop.                                                                                                                           |
| Protection             | Encrypted at rest (provider-side encryption) and in transit; write-once / object lock or versioning so a compromised app key cannot delete backups; access limited to the operators on call. Dumps contain personal data and encrypted tokens: treat them like the production database. |
| Object storage         | Bucket **versioning** on (and object lock where available), or a scheduled replication to a second bucket. Deleting a video file in the app must not delete its backup before the retention period of the policy in `docs/AI_VIDEO_RETENTION_POLICY.md` ends.                           |
| Secrets                | `AUTH_SECRET` and `ENCRYPTION_KEY` escrowed in a password manager / secret vault with two named custodians, separately from the dumps.                                                                                                                                                  |
| Restore test           | A full restore drill (§ 5) **monthly** and after any change to the schema tooling; record the result in the incident/ops log.                                                                                                                                                           |

Responsibilities: the on-call operator owns the daily job and the monthly drill; the
engineering lead reviews the drill record. A failed or missing backup is an incident (§ 6).

## 3. Taking a backup

```bash
BACKUP_DATABASE_URL='postgresql://backup_user@db-host:5432/flexibx?sslmode=verify-full' \
  scripts/ops/db-backup.sh /secure/backups/flexibx
```

**Which credential:** the database **owner** (migration) role — with the role model of
`docs/runbooks/DATABASE_ROLES.md` the runtime role cannot read `_prisma_migrations`, and `pg_dump`
run as that role fails with `permission denied` (verified). After restoring into a new database, run
`scripts/ops/sql/db-roles.sql` there before an application connects with the runtime role
(a restore with `--no-owner --no-privileges` leaves every object owned by the restoring
login and no grants).

**Credentials never reach a command line.** The three scripts (`scripts/ops/lib/pgenv.sh`)
read the URL from the environment, turn it into libpq variables (`PGHOST`, `PGPORT`,
`PGUSER`, `PGDATABASE`, `PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLCRL`,
`PGCONNECT_TIMEOUT`, `PGAPPNAME`, `PGOPTIONS`, `PGTARGETSESSIONATTRS`) and write a
password from the URL to a temporary `PGPASSFILE` (mode 600, private directory, removed
on exit, failure or interrupt; it takes precedence over `PGPASSWORD`). A URL without a
password uses `~/.pgpass` or `PGPASSWORD` as usual. pg_dump, psql and pg_restore get no
URL, host or password argument (pg_restore gets the confirmed database name only), and the
URL variable is not passed on to them. The scripts **refuse** (exit 2, without printing
the URL) a URL they cannot map exactly: another scheme, several hosts, a repeated or
unknown parameter (including `pgbouncer` — back up through a direct connection), or a
`schema` other than `public`. Prisma pool parameters (`connection_limit`, `pool_timeout`,
`socket_timeout`) are ignored. Needs `node` on the host (URL parsing).

Output (one JSON line): dump path, size, SHA-256, table count. Files (mode 600, in a mode
700 directory, refused inside the repository):

- `flexibx-<UTC>.dump` — `pg_dump --format=custom --no-owner --no-privileges`
  (consistent snapshot; restorable into any database with the same extensions:
  `pgcrypto`, `citext`).
- `flexibx-<UTC>.dump.sha256` — checked before any restore.
- `flexibx-<UTC>.counts.tsv` — exact row count per table, taken right after the dump. Exact
  when writes were stopped (maintenance window); approximate on a live database.

Then copy the three files to the backup storage (§ 2) and delete the local copies.

## 4. Restoring

**Never restore over the production database.** Restore into a new, empty database,
verify it, then switch the application's `DATABASE_URL` (or promote it with the provider's
tooling).

1. Contain: stop writes (scale the app to zero or put it in maintenance) and pause the
   scheduler calling `/api/internal/automation-tick` and `/api/internal/video-retention`.
   Set `SOCIAL_SENDING_ENABLED=false` until verification is finished (no sends from
   restored, already-sent state).
2. PITR (preferred, provider console/CLI): restore to a timestamp just before the
   incident into a **new** instance. Then go to step 5.
3. From a dump: create an empty database (same PostgreSQL major version, 16), then

   ```bash
   RESTORE_DATABASE_URL='postgresql://…/flexibx_restore' \
     scripts/ops/db-restore.sh /secure/restore/flexibx-<UTC>.dump --confirm-target flexibx_restore
   ```

   Refuses on a checksum mismatch, a `--confirm-target` that is not the target's name, or a
   target with any table (it cannot overwrite a live database). Runs in one transaction.

   Failure modes (exit 2 = refused before any change, exit 1 = `FAILED`):
   - Refused (checksum, missing `.sha256`, wrong name, non-empty target): nothing was
     written. Fix the cause; never edit the `.sha256` file to make a dump pass.
   - `FAILED` during `pg_restore` (connection lost, disk full, an object that already
     exists such as a leftover type or extension, a dump from a newer major version): the
     single transaction rolls back, so the target is left as it was (no partial restore).
     Drop and recreate the target database anyway before retrying, so the next attempt
     starts from a known-empty state.
   - Restored but verification fails (§ 5): the restored database is not usable; do not
     point the app at it. Try the previous backup (or PITR) and record the failure (§ 6).
   - Interrupted by the operator (Ctrl-C) or the task runner's timeout: same as `FAILED`.

4. Apply migrations that are newer than the dump, if the application version is newer:
   `DATABASE_URL=… pnpm db:deploy` (forward only, see DEPLOYMENT.md).
5. Verify (§ 5). Do not reopen traffic until every check passes.
6. Object storage: if files were lost, restore object versions (or the replica) for the
   affected prefixes. Rows whose file is missing are detected by the app as missing media
   (downloads fail) — list them with the storage provider's inventory against
   `media_assets.storage_key` / `generated_video_files.storage_key` before reopening.
7. Point the app at the restored database, start it, run one scheduler tick, check
   `/api/health?scope=readiness` and `/api/internal/ops-status`, then re-enable social
   sending if it was on before.
8. Communicate: data written between the recovery point and the incident is lost — list
   the window in the incident record; affected customers are informed per the incident
   runbook.

## 5. Post-restore verification

```bash
VERIFY_DATABASE_URL='postgresql://…/flexibx_restore' \
  scripts/ops/db-verify.sh /secure/restore/flexibx-<UTC>.counts.tsv
```

Checks (each prints a count; all must be 0 / "match"):

- row counts equal the backup manifest;
- `migrations_unfinished` — no migration without an applied attempt, and no failed attempt
  left unresolved (an attempt rolled back with `prisma migrate resolve --rolled-back` and
  then re-applied is history, not a failure);
- `credit_balance_vs_ledger` — every credit account equals its last ledger entry;
- `credit_held_vs_open_holds` — held credits equal the open holds;
- `ledger_guard_triggers_missing` — the ledger's append-only / same-workspace triggers exist
  and fire;
- `guard_triggers_inactive` — every guard trigger the migrations create (132 at the time of
  writing: immutable review decisions, append-only ledgers and consent history,
  same-workspace and workspace-immutable rows, the platform-admin grant guard, state
  transitions, the Creator Studio's same-project, active-project, append-only event and
  deletion-record guards) exists under its table and fires. Missing, `DISABLE`d and `ENABLE REPLICA`
  triggers count (a replica-only trigger does not fire for the application's sessions).
  `pg_dump` keeps a trigger's disabled state, so a backup taken while a guard was switched
  off restores without that guard and every other check still passes; the list in
  `integrity.sql` is tested to equal the migrated schema's triggers;
- `constraints_not_validated` — no constraint restored as NOT VALID;
- `orphan_sessions`, `orphan_two_factors`;
- `prisma_migrations` — checked in SQL against `_prisma_migrations` (Prisma is not run:
  its schema engine would receive the URL, password included, on its command line). It
  is **stricter than `prisma migrate status`**, not equivalent: Prisma 7.10 reports "up to
  date" for an edited migration file and ignores migrations that exist only in the
  database (tested). Here every repository migration must have an applied attempt whose
  recorded checksum (SHA-256 of `migration.sql`) matches the file — a difference in line
  endings only (CRLF vs LF checkout) is accepted; any other byte difference is reported
  as `modified` — and a migration recorded in the database but absent from the repository
  is `unknown`. Names are printed for each. A connection or query failure is `FAILED`
  (exit 1), never a pass.

Then, manually: sign in as an operator account (password + second factor), open one
workspace, check its credit balance and the last audit entries match expectations.

## 6. Alerts and failures

- The backup job must alert on a non-zero exit or a missing daily file (the job runner's
  failure notification, or a check that the newest object in the backup bucket is < 26 h
  old). Flexibx itself cannot see an external backup job.
- A failed backup: re-run once; if it fails again, open an incident (INCIDENT_RESPONSE.md
  § "Database failure"), keep the previous good backup, do not deploy migrations until a
  fresh backup exists.
- A failed drill (any verification check non-zero): treat the backup set as unusable until
  the cause is understood.
- `guard_triggers_inactive` non-zero: do not let the application write to that database.
  List the triggers that do not fire (`pg_trigger` rows with `NOT tgisinternal` and
  `tgenabled NOT IN ('O', 'A')`) and any listed trigger that is absent, then check the
  SOURCE database the same way: a guard switched off there (an
  incident fix never reverted) is an incident of its own. Re-enable with
  `ALTER TABLE … ENABLE TRIGGER …` (a missing trigger: restore again from a clean backup —
  never recreate it by hand), and re-run `db-verify.sh`. Rows written while the guard was
  off were not checked by it: review them before trusting the data.

## 7. Restore drill — local result (2026-10-12)

Run in the development container, on throwaway databases only (`flexibx_scratch_c` as
source with the demo seed plus a consistent credit account, hold and two ledger entries;
`flexibx_restore_c` as target; both dropped afterwards). No production system, no paid
resource, no customer data; the dump stayed in the session scratch directory.

| Step                                            | Result                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Backup into the repository directory            | Refused (`output directory is inside the repository`)                        |
| Backup                                          | OK — 56 tables, ~280 KB, files mode 600 in a mode 700 directory              |
| Restore with a wrong `--confirm-target`         | Refused                                                                      |
| Restore into the (non-empty) source database    | Refused (`target database is not empty`)                                     |
| Restore into the empty target                   | OK, 56 tables, < 1 s                                                         |
| Verify                                          | All checks 0, row counts match, `prisma migrate status` up to date           |
| Ledger DELETE on the restored database          | Refused by the trigger (`credit_ledger_entries is append-only`)              |
| Verify after corrupting a balance               | FAILED (`credit_balance_vs_ledger 1`, `credit_held_vs_open_holds 1`), exit 1 |
| Verify after removing the last migration record | FAILED (`prisma_migrate_status NOT up to date`)                              |
| Restore of a tampered dump                      | Refused (`checksum mismatch`)                                                |

Review re-run (2026-10-12, after the review fixes, same throwaway setup plus a two-factor
enrollment and a heartbeat row; 57 tables):

| Step                                                              | Result                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Backup of an unreachable database                                 | `FAILED`, exit 1, no file left behind, no password in the output |
| Restore without `--confirm-target` / wrong name                   | Refused                                                          |
| Restore into the non-empty source / a second time into the target | Refused (`target database is not empty`)                         |
| Restore with the `.sha256` file missing                           | Refused                                                          |
| Restore + verify                                                  | All checks 0, 57 tables match, two-factor rows restored          |
| Verify after adding an account with credits but no ledger entry   | FAILED (`credit_balance_vs_ledger 1`)                            |

Phase C.1 re-run (2026-10-13, after moving credentials off the command line; throwaway
`flexibx_c1_test` as source, `flexibx_c1_restore` as target, a throwaway login role with a
random 26-character password containing `:`, `@`, `/` and `\`, all dropped afterwards; a
sampler recorded the command line of every pg_dump / psql / pg_restore / ops-script
process during the run):

| Step                                                               | Result                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Backup (`sslmode`, `application_name`, `schema=public` in the URL) | OK, 57 tables                                                 |
| Restore into the empty target                                      | `RESTORED`, 57 tables                                         |
| Verify                                                             | `VERIFIED`: counts match, all checks 0, 27 migrations applied |
| Restore again into the now non-empty target                        | Refused (`target database is not empty`), exit 2              |
| Verify / backup against a closed port                              | `FAILED`, exit 1                                              |
| Password or URL in any sampled command line / output               | none                                                          |
| Temporary password directories left behind                         | none                                                          |

Fake-command tests (`tests/unit/ops-db-scripts.test.ts`) cover the argument and output
checks for all three scripts, the password file mode and escaping, option mapping,
cleanup on failure, every refusal case, and a verify that cannot pass on a connection
failure or a pending / modified / unknown migration.

Not tested (needs the real infrastructure): PITR, provider snapshots, object-storage
versioning/replication restore, restore time at production size, cross-region copies.

## 8. Measured times and the RTO / RPO they support (Pass 14, 2026-10-19)

Measured on one machine (4 vCPU, 15 GB RAM, local PostgreSQL 16, local disk), all through
the `ops` image (`db-backup.sh`, `db-restore.sh`, `db-verify.sh`). Not a hosted database:
network, managed-disk throughput and the provider's own restore are not in these numbers.

| Database                                  | Backup (dump)               | Restore (new database)                    | Verify (manifest, integrity, 502 objects, migrations) |
| ----------------------------------------- | --------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Staging after the container cycle (13 MB) | 0.6 s, 0.45 MB dump         | 1.1 s, 77 tables                          | 1.1 s, `VERIFIED`                                     |
| Synthetic 1.08 GB (4 M rows, 3 indexes)   | 32.1 s, 354 MB dump (`-Z6`) | 20.5 s, single transaction, indexes built | not applicable (not the Flexibx schema)               |

The restored staging copy had the same 132 triggers (none disabled), 300 indexes and 356
constraints as its source. `restore-drill.sh` (with its provoked failures) passed in 13.7 s.

**RTO (time to a verified, serving database), from these rates:** restore ≈ size ÷ 50 MB/s
plus verify (seconds) plus the switch of `DATABASE_URL` and an app restart (≈ 1 minute,
the app was healthy 6 s after start). For 10 GB that is ≈ 4–5 minutes of restore, so an
**RTO target of 30 minutes** leaves room for the hosted disk being several times slower and
for the operator's steps. It must be re-measured on the chosen provider with a
production-sized copy before it is promised.

**RPO:** with the daily `db-backup.sh` alone, up to **24 hours** of data. With managed
PITR (BACKUP_RESTORE.md § 2, D-2), the provider's figure (≈ 5 minutes on RDS). PITR is not
exercised anywhere yet: no hosted database exists.
