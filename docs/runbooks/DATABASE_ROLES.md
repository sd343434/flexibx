# Database roles runbook (runtime / grant / owner separation)

Status (2026-10-13): designed, scripted and tested on disposable databases only. **Not
applied to any persistent database; no production role or credential exists or was
changed.** Until it is applied, the application connects as the owner of every table and
the platform-admin trigger is not a security boundary against it
(`docs/runbooks/ADMIN_PROVISIONING.md` § 1).

## 1. Roles

| Role                  | Used by                                                                 | Can                                                                                                                                                                                                        | Cannot                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **owner** (`*_owner`) | the one-off migrate job, `db-roles.sql`, emergency DBA work             | everything (owns the database, schema `public`, every table, sequence, type, trigger and function)                                                                                                         | — (it is the trust root: keep it in the deployment pipeline only)                                                                                                                                                                                                                                                                                     |
| **app** (`*_app`)     | the web app and scheduled jobs (`DATABASE_URL`), `pnpm admin:mfa-reset` | SELECT/INSERT/UPDATE/DELETE on application tables (none on `two_factor_used_codes`); UPDATE on every `users` column except `is_platform_admin`; EXECUTE `two_factor_claim_code`                            | set `is_platform_admin` (no column privilege; new rows refused by the guard trigger); execute `platform_admin_grant`/`_revoke`; ALTER/DROP/REPLACE any table, trigger or function; create schemas or objects; UPDATE/DELETE/TRUNCATE `audit_logs`; read `_prisma_migrations`; read or write `two_factor_used_codes` directly; be a member of any role |
| **grant** (`*_grant`) | `pnpm admin:grant` (`ADMIN_GRANT_DATABASE_URL`), revocations            | read `users` (id, email, email_verified, two_factor_enabled, is_platform_admin) and `two_factors`; INSERT `audit_logs`; EXECUTE `platform_admin_grant` / `platform_admin_revoke` / `two_factor_claim_code` | update `users` at all; read sessions, accounts or any other table (incl. `two_factor_used_codes`); be a member of any role; DDL                                                                                                                                                                                                                       |

`scripts/ops/sql/db-roles.sql` applies all of this to one database (ownership transfer,
revokes, grants, default privileges for future tables) in **one transaction**, after
checking that the app and grant roles are not superuser/CREATEROLE/CREATEDB/BYPASSRLS/
REPLICATION and are a member of **no role at all**, directly or through a chain — the
owner, a superuser, a managed-service admin role such as `rds_superuser` (which has no
SUPERUSER attribute), predefined roles such as `pg_write_all_data` / `pg_read_all_data`, or
any group role; it ends with postconditions (no table privilege on
`two_factor_used_codes`, the grant role reaches only its three tables, only the approved
SECURITY DEFINER functions are executable, still no membership after the ownership
transfer) and rolls back if any fails. It never creates
roles or passwords. It is idempotent and must be run again after every migration (new
tables get privileges through default privileges, but a new `users` column needs the
column grant).

**TOTP codes (Phase D.2).** Both limited roles claim a code only through
`public.two_factor_claim_code(uuid, text)` (SECURITY DEFINER, owner-owned, fixed
`search_path`; migration `20261014150000`): it removes only that account's claims expired
by the database clock and inserts the claim. Neither role has any privilege on
`two_factor_used_codes`, so neither can delete an unexpired claim to replay a code.
Deploy the application version that calls the function **before** re-running
`db-roles.sql` (an older version writes the table directly and would be refused —
sign-ins with TOTP would fail closed).

**Running the script without exposing credentials.** Use the `ops` image (`Dockerfile`
target `ops`: the migrate image plus the PostgreSQL 16 client) as a one-off task next to
the database, with the owner URL injected as an environment variable by the secret
manager, and let `scripts/ops/lib/pgenv.sh` turn it into libpq variables and a private
`PGPASSFILE`:
`OWNER_URL=… bash -c '. scripts/ops/lib/pgenv.sh && pg_use_url OWNER_URL && psql -X -v ON_ERROR_STOP=1 -v owner_role=… -v app_role=… -v grant_role=… -f scripts/ops/sql/db-roles.sql'`
(`OWNER_URL` comes from the task's secret, not from a typed command). The role names
passed with `-v` are not secrets.

**Managed PostgreSQL (e.g. Amazon RDS).** The membership and privilege checks are proven
on a local PostgreSQL 16 with a stand-in for `rds_superuser`; on the managed service,
prove in staging that the master user can create the roles, transfer ownership, set
default privileges, column grants and SECURITY DEFINER functions, and that the script's
checks pass (docs/runbooks/PHASE_D_2_SECURITY_HARDENING.md § 7).

**Trust boundary (stated plainly):** the database can enforce _who_ may grant (only the
grant role), _what_ is required of the account, and that every grant is audited with the
calling login. It cannot verify the TOTP code: the secret is encrypted with `AUTH_SECRET`
in the application layer. Proof of possession is enforced by the operator tool, run by a
holder of the grant credential — that holder could call the function without a code.
Making the database verify the code would need the TOTP secret (or `AUTH_SECRET`) inside
the database, which is a larger change than the risk justifies at this stage.

## 2. Staged cutover (to be executed through an authorized deployment change)

Each step is verified before the next. No step deletes data. Commands below never put a
password or URL on a command line: use libpq environment variables or the secret manager's
injection, and psql's `\password` (which sends a hash, not the password, and leaves no
shell history) to set passwords.

0. **Backup and a verified restore** (before anything else): `scripts/ops/db-backup.sh`
   with the **owner** credential, then `db-restore.sh` into a throwaway database and
   `db-verify.sh` (`docs/runbooks/BACKUP_RESTORE.md`). Do not continue without `VERIFIED`.
   Rehearse steps 1–6 on that restored copy first (staging), including § 3.
1. **Inventory** the current state (read-only, as the owner) and record it:

   ```sql
   SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin FROM pg_roles
   WHERE rolname NOT LIKE 'pg\_%';
   SELECT pg_get_userbyid(datdba) AS database_owner FROM pg_database WHERE datname = current_database();
   SELECT tableowner, count(*) FROM pg_tables WHERE schemaname = 'public' GROUP BY 1;
   SELECT r.rolname AS member, g.rolname AS member_of FROM pg_auth_members m
   JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid;
   ```

   Expected today: one login role owns the database and every table and is used by both
   the application and migrations.

2. **Create roles** (DBA, managed-database console or `CREATE ROLE`): `flexibx_app` and
   `flexibx_admin_grant`, both `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
   no membership in any other role. Generate their passwords in the secret manager (never
   in a terminal or a ticket) and set them with `\password`. The current owner role stays
   the owner (`owner_role`).
3. **Apply privileges** in a maintenance window, as the owner (or a superuser):
   `psql -X -v ON_ERROR_STOP=1 -v owner_role=<owner> -v app_role=flexibx_app -v grant_role=flexibx_admin_grant -f scripts/ops/sql/db-roles.sql`.
   It transfers any object not yet owned by `owner_role` and is all-or-nothing. The running
   application is unaffected (it still uses the owner credential).
4. **Grant path**: on the staging copy, `pnpm admin:grant` with `ADMIN_GRANT_DATABASE_URL`
   = the grant role works (§ 3) — before anyone depends on it in production.
5. **Switch credentials** in the deployment configuration (secret manager references only;
   never in `.env` files in the repository, CI logs or chat). In the staging Compose file
   (Pass 37) the owner login is `OWNER_DATABASE_URL` in `staging-owner.env`, given only to
   `migrate`, `backup` and `check`; `DATABASE_URL` in `staging.env` is the runtime login:
   - web app and scheduled jobs: `DATABASE_URL` = `flexibx_app`;
   - migrate job: `DATABASE_URL` = the owner (`prisma migrate deploy` runs as the owner
     **login itself** — default privileges only cover objects the owner creates; a
     migration run by another login, e.g. a managed-database master user, would create
     tables the application cannot use);
   - backup job: the owner (the runtime role cannot read `_prisma_migrations`: `pg_dump`
     as that role fails with `permission denied` — verified); `db-verify.sh` on a restored copy runs as that copy's owner;
   - `pnpm admin:grant`: `ADMIN_GRANT_DATABASE_URL` = the grant role, issued to the
     operators who run grants only;
   - `pnpm admin:mfa-reset`: runs with the **runtime** role (tested:
     `tests/integration/mfa-reset-runtime-role.test.ts`) — run it from an operator job that
     receives the runtime credential from the secret manager.
6. **Verify** (§ 3) on the live application: sign-in, sign-up with email verification,
   password reset (account recovery), two-step enrollment and sign-in with a code and with
   a backup code, an `admin:mfa-reset` of a test account, a workspace write, a credit
   operation, the scheduled tick and the ops-status endpoint; the admin area for an existing
   administrator.
7. **Retire the old credential for the runtime**: change the owner role's password
   (via `\password`, new value straight into the secret manager, updating the migrate and
   backup jobs at the same time) so the previous `DATABASE_URL` works nowhere else; check
   the application and job logs for authentication failures from forgotten services.

**Rollback.** Before step 7: redeploy the application with the previous (owner)
`DATABASE_URL`. This **restores the pre-cutover state, without the privilege boundary**:
record it as an incident with an owner and a date to retry, and do not "fix" a runtime
permission error by granting the runtime role more (find the missing grant in
`db-roles.sql`, test it on staging, re-run the script). After step 7: issue a new owner
password to the migrate and backup jobs only. The role script itself needs no rollback (it
does not affect an owner-credential application).

**Lock-out safety.** Every administrative path keeps a working credential: grants and
revocations — the grant role (and, if it is lost, the owner, who owns the functions);
MFA reset — the runtime role; migrations, backups and emergency DBA work — the owner.
Existing administrators keep their flag through the cutover.

**After every migration**: run it as the owner (migrate job), then run `db-roles.sql`
again (a new `users` column needs its column grant; new tables get default privileges).

## 3. Verification checklist

- [ ] As `flexibx_app`: `UPDATE users SET is_platform_admin = true WHERE …` → `permission
denied`, also after `SELECT set_config('flexibx.platform_admin_grant', '<id>', true)`.
- [ ] As `flexibx_app`: `ALTER TABLE users DISABLE TRIGGER users_platform_admin_grant_guard`
      → `must be owner`; `SELECT public.platform_admin_grant(…)` → `permission denied`.
- [ ] `SELECT pg_has_role('flexibx_app', '<owner>', 'MEMBER')` → `false`.
- [ ] `pnpm admin:grant` with `ADMIN_GRANT_DATABASE_URL` → `GRANTED` with a valid code,
      `DENIED INVALID_CODE` without; with only the app credential → `FAILED`, nothing granted.
- [ ] Application smoke test (§ 2 step 6).
- [ ] As `flexibx_app`: `UPDATE audit_logs SET action = action WHERE false` and
      `DELETE FROM audit_logs WHERE false` → `permission denied`.
- [ ] Audit since the cutover: `SELECT created_at, action, metadata->>'databaseUser' FROM
audit_logs WHERE action LIKE 'platform_admin.%' AND created_at > '<cutover time>'` —
      every grant shows the grant role and has a ticket.
- [ ] `SELECT tableowner, count(*) FROM pg_tables WHERE schemaname = 'public' GROUP BY 1` →
      only the owner role.

The privilege checks are automated, on disposable roles and databases, in
`tests/integration/db-roles.test.ts` and `mfa-reset-runtime-role.test.ts` (runs in CI, where the test database user is a
superuser; locally it needs `ROLE_TEST_ADMIN_DATABASE_URL`).

## 4. Not covered

- A dedicated read-only backup role (backups use the owner credential for now).
- Row-level security and per-workspace database isolation (tenancy is enforced in the
  application's tenant guard).
- Read-only or reporting roles, connection poolers with their own users.
- The superuser / managed-database master account, which can bypass everything.
