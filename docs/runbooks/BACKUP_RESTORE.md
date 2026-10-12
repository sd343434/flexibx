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
# Credentials: prefer ~/.pgpass or PGPASSWORD over a password inside the URL.
BACKUP_DATABASE_URL='postgresql://backup_user@db-host:5432/flexibx' \
  scripts/ops/db-backup.sh /secure/backups/flexibx
```

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
- `migrations_unfinished` — no failed or rolled-back migration;
- `credit_balance_vs_ledger` — every credit account equals its last ledger entry;
- `credit_held_vs_open_holds` — held credits equal the open holds;
- `ledger_guard_triggers_missing` — the ledger's append-only / same-workspace triggers exist;
- `constraints_not_validated` — no constraint restored as NOT VALID;
- `orphan_sessions`, `orphan_two_factors`;
- `prisma migrate status` reports the schema up to date with the repository.

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

Not tested (needs the real infrastructure): PITR, provider snapshots, object-storage
versioning/replication restore, restore time at production size, cross-region copies.
