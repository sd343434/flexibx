# Deployment and database migration runbook

Status (2026-10-12): documentation only. **No hosting provider has been chosen and nothing
has been deployed.** The repository provides: a production Docker image (`Dockerfile`,
Next.js standalone, non-root, liveness healthcheck), a separate one-off migration image
(`--target migrate` → `prisma migrate deploy`), CI (`.github/workflows/ci.yml`: lint,
typecheck, format, unit, migrations on a clean database + `migrate status`, integration,
build, end-to-end, Docker build, secret scan). `docker-compose.yml` is for local
development only.

## 1. Ground rules

- Prisma migrations are **forward-only**: there are no down migrations, and Prisma does
  not reverse anything. Some migration files wrap their SQL in `BEGIN … COMMIT`, others do
  not — a failure in an unwrapped file can leave it **partially applied**.
- Migrations run **once, before** the new application version starts, from the migrate
  image (or `pnpm db:deploy` on a host with the source), with a direct database
  connection (not a transaction-mode pooler).
- Every migration must keep the **previous** application version working (expand →
  deploy → contract): add columns/tables first, switch code, remove old ones in a later
  release. Then a bad app release is rolled back by redeploying the previous image, with
  no database change.
- Prisma's schema engine (`migrate deploy`, `migrate status`) receives `DATABASE_URL`,
  password included, **on its command line** (visible in the process list of that
  machine). Run Prisma commands only in the one-off migrate container or on a host no
  other user can inspect; the backup scripts avoid Prisma for this reason
  (`docs/runbooks/BACKUP_RESTORE.md` § 3).
- Never edit a migration file after it has been applied anywhere (its checksum is
  recorded); fix with a new migration.
- Never apply migrations to production from a laptop or by hand-written SQL outside a
  migration, except the documented recovery steps below (logged in the incident log).

## 2. Deploy order

1. **Pre-flight**
   - CI green on the exact commit being deployed.
   - List the new migrations: `git diff --name-only <deployed-commit>..<new-commit> -- prisma/migrations`.
     Read each one. Classify: additive (new table/column with default, new index on a
     small table) or risky (drops, renames, type changes, NOT NULL on existing data, index
     or constraint on a large table — locks; data backfills). Risky ones need the
     expand/contract split or a maintenance window.
   - `DATABASE_URL=<prod> pnpm exec prisma migrate status` (read-only): only the expected
     migrations are pending, none failed.
   - Fresh backup: confirm PITR is healthy, and take `scripts/ops/db-backup.sh` (required
     whenever a migration is included). Note the recovery point in the deploy record.
   - Environment: new variables present (see `.env.example`); `AUTH_SECRET` and
     `ENCRYPTION_KEY` unchanged unless a rotation is planned (INCIDENT_RESPONSE.md § 4.6).
2. **Migrate**: run the migrate image once with the production `DATABASE_URL`. It exits
   non-zero on failure — stop the deploy (§ 3).
3. **Verify migrations**: `prisma migrate status` → "Database schema is up to date";
   `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;`
   shows them finished.
4. **Deploy the app** (rolling or blue/green). The start-up check refuses an invalid
   production environment (exit 1, variable names in the log) — a crash-looping new
   version means configuration, not code: fix the variable, do not force it.
5. **Smoke test**: `/api/health?scope=liveness` and `?scope=readiness` 200; sign in with an
   operator account (password + second factor) and open `/admin`; open one workspace.
6. **Watch 30 minutes**: no `server_error:*` alerts; after the next scheduler tick
   `/api/internal/ops-status` 200 (`automation_tick_last_success_age_seconds` small).
7. Record: commit, migrations applied, backup id, who deployed, result.

## 3. A migration failed

The application still runs the previous version (it was never replaced) and must stay
compatible with the partially changed schema — check `/api/health` and alerts first.

1. Read the error: `SELECT migration_name, logs FROM _prisma_migrations WHERE finished_at IS NULL;`
   (and the migrate job's output).
2. Determine what was applied. If the file has `BEGIN … COMMIT`, nothing was. Otherwise
   compare the file's statements with the database (`\d table`, `pg_constraint`,
   `pg_indexes`).
3. Choose one, in a maintenance window if needed, and record each command:
   - **Retry after fixing the cause outside the schema** (e.g. existing rows violate a new
     constraint → correct the data with a reviewed, audited statement; lock timeout →
     retry off-peak): undo the partial statements (or confirm none), then
     `prisma migrate resolve --rolled-back <migration_name>` and run the migrate image
     again.
   - **Complete it by hand** (rare; only when the remaining statements are trivial and
     reviewed): run exactly the remaining statements of the file, then
     `prisma migrate resolve --applied <migration_name>`.
   - **Abandon this release**: undo the partial statements, `prisma migrate resolve
--rolled-back <migration_name>`, keep the previous app version, fix forward with a
     new migration in a later release.
4. Verify: `prisma migrate status` up to date (or only the abandoned migration pending),
   `scripts/ops/db-verify.sh` integrity checks against production in read-only mode
   (`VERIFY_DATABASE_URL=<prod>`; it only runs SELECTs and `migrate status`).

## 4. Rolling back

- **App only** (the usual case): redeploy the previous image. Works because migrations are
  expand-only for one release.
- **Schema**: there is no automatic rollback. Write a new forward migration that reverts
  the change (keeping data), and deploy it like any other.
- **Data** (last resort, data loss): restore per BACKUP_RESTORE.md into a new database
  (PITR to just before the migration, or the pre-deploy dump), verify, switch. Everything
  written after the recovery point is lost — decide with the product owner and record it.

## 5. This release (phase C) specifically

Migrations, all additive (no data rewrite; not wrapped in `BEGIN … COMMIT`, so a failure
leaves at most some of the new, still unused objects — § 3):

- `20261014090000_platform_admin_mfa`: `users.two_factor_enabled` (default false),
  `sessions.mfa_verified_at` (nullable), table `two_factors`.
- `20261014100000_ops_monitoring`: tables `system_heartbeats`, `alert_throttles`.
- `20261014110000_totp_replay_guard`: table `two_factor_used_codes`.
- `20261014120000_platform_admin_grant_guard`: trigger on `users` (the platform-admin flag
  is set only by `pnpm admin:grant`, and cleared when two-step verification is turned
  off). **Clears the flag on every existing administrator without two-step
  verification** — re-grant them after they enroll (`docs/runbooks/ADMIN_PROVISIONING.md`).
- `20261014140000_platform_admin_grant_functions`: SECURITY DEFINER functions
  `platform_admin_grant` / `platform_admin_revoke` (EXECUTE revoked from PUBLIC), and the
  guard trigger refuses any new `users` row that carries the flag. After it, apply the
  role model (`docs/runbooks/DATABASE_ROLES.md`) through an authorized change: until then
  only an owner-credential connection can call the functions. New optional operator
  variable `ADMIN_GRANT_DATABASE_URL` (never in the application's environment).
- `20261014130000_ops_check_results`: table `ops_check_results` (results of the periodic
  credit-ledger integrity check). Optional variable `LEDGER_INTEGRITY_INTERVAL_MINUTES`
  (default 60).

Rehearsed on throwaway databases (2026-10-12): applied to an empty database and to a
database at the previous release's schema holding users, sessions, memberships and audit
rows — row counts and content hashes identical before and after, new columns at their
defaults (no account enrolled, no session marked), no drift, `migrate status` up to date,
`db-verify.sh` passed.

Order: migrate → deploy. The previous app version keeps working on the new schema
(unused columns/tables). After the deploy, every platform administrator is sent to
`/{locale}/account/security` to enroll in two-step verification before the admin area
opens — plan that with the administrators. New optional variables: `ALERT_WEBHOOK_URL`,
`ALERT_WEBHOOK_TOKEN`, `OPS_STATUS_SECRET` (configure the uptime monitor against
`/api/internal/ops-status`).

## 6. Open requirements (before the first production deploy)

- Choose hosting for the container (with secret store, rolling deploys, log retention)
  and a managed PostgreSQL 16 with PITR; object storage with versioning; a scheduler for
  `/api/internal/automation-tick` (every 1–5 min) and `/api/internal/video-retention`; an
  uptime monitor for `/api/health` and `/api/internal/ops-status`; an alert destination
  for `ALERT_WEBHOOK_URL`. Costs depend on the providers chosen and are not estimated here.
- A staging environment with production-like data volume to rehearse migrations.
