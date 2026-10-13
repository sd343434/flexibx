# Phase C.3 — final security review and runtime-role verification

Date: 2026-10-13. Branch `claude/amazing-sagan-pvouqy`, baseline HEAD `72efd2b` (equal to
the remote). The Phase C.3 changes were local and uncommitted before this review and still
are. Every database used here was disposable (created and dropped by the tests or by hand);
no persistent database was touched and nothing was committed, pushed or deployed.

## 1. `admin:mfa-reset` under the restricted runtime role — works

`src/server/auth/mfa-reset.ts` runs one transaction: read the account (id, flag) →
DELETE its `two_factors` row → UPDATE `two_factor_enabled = false` (the guard trigger then
clears `is_platform_admin`; trigger changes need no column privilege) → DELETE its
sessions → INSERT one or two audit rows. Every step is covered by the runtime role's grants
in `db-roles.sql`; it needs no ownership and no extra privilege.

`tests/integration/mfa-reset-runtime-role.test.ts` (5 tests, disposable database and
roles; runs the **real CLI** `scripts/admin/mfa-reset.ts` with the runtime credential):

| Requirement                      | Evidence                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legitimate reset completes       | CLI exit 0, `RESET`, `sessionsEnded` ≥ 2                                                                                                                                            |
| Sessions and MFA state           | two-factor off, `two_factors` row gone, 0 sessions                                                                                                                                  |
| Platform-admin revocation        | an administrator (granted through the grant role) loses the flag                                                                                                                    |
| Audit written and protected      | `user.mfa_reset_by_operator` (operator, reason, sessions) + `platform_admin.revoked` (`mfa_reset`); the runtime role's UPDATE and DELETE of those rows are refused                  |
| Unrelated records unchanged      | another enrolled account's user row, two-factor row and sessions are byte-identical (md5)                                                                                           |
| Refused step → no partial change | with INSERT on `audit_logs` revoked (the last step), the reset fails and the account is byte-identical, flag still set; the grant role is refused too; after restoring, it succeeds |
| No ownership or elevated grants  | the runtime role is not superuser/CREATEROLE/CREATEDB/BYPASSRLS, owns no table or function, reaches neither the owner nor the grant role                                            |
| Unknown account                  | `NOT_FOUND`, exit 2, no audit row                                                                                                                                                   |
| No credential in output          | the CLI output holds neither the role's password nor a URL                                                                                                                          |

Mutations (each made the suite fail, then reverted): runtime role without DELETE on
sessions (2 failures); runtime role allowed to rewrite/erase audit, with the script's own
postcondition also removed (1); reset without a transaction (1, the partial-change test).

Defect found and fixed in the new test helper: a setup that failed after creating roles
left them (and the database) behind. `support/role-database.ts` now tears down on setup
failure; verified with a forced failure (0 roles, 0 databases left).

## 2. Cutover plan review (`DATABASE_ROLES.md`)

The plan was missing: a pre-change backup with a verified restore; an inventory of current
roles and ownership; how to provision passwords without printing them; that migrations
must run as the owner **login itself** (default privileges only cover objects the owner
creates); that the backup job cannot use the runtime role (`pg_dump` as that role fails
with `permission denied` on `_prisma_migrations` — verified); which credential
`admin:mfa-reset` uses; MFA reset, enrollment and password recovery in the smoke test;
that rolling back to the owner credential removes the boundary (and must not be "fixed" by
widening the runtime role); and post-cutover audit and ownership checks. All of these are
now in § 2–3 of the runbook (step 0 backup/restore, step 1 inventory, step 5 per-job
credentials, lock-out safety, rollback). `BACKUP_RESTORE.md` states which credential to
use and to run `db-roles.sql` after a restore.

Operational prerequisites that cannot be verified without the production environment:
the managed database's ability to create roles without superuser, the secret manager and
per-job secret injection, a staging copy for the rehearsal, and the owner role's current
name and attributes.

## 3. Privilege boundary and TOTP

Re-run on disposable roles (`db-roles.test.ts`, 7 tests): the runtime role cannot set the
flag (directly, with the old marker, in one statement, on insert), cannot execute
`platform_admin_grant` / `_revoke`, cannot disable, drop or replace the trigger or the
functions, cannot create objects or become the owner, and is refused when it reaches the
owner through an intermediate role. The grant role cannot update `users` and cannot read
sessions or accounts. Grants and revocations are audited with the calling login.

TOTP: the grant service checks the code (`verifyTotpCode`) and claims it before calling
the function; a wrong code is denied without calling it (tested). The database does not
verify TOTP — as documented, holding the grant credential is the trust boundary.

Added in this review: the grant CLI's output never contains the grant or runtime
password, a URL or the grant role's name — also when the grant credential is wrong
(connection failure). Mutation: printing the error message instead of its class leaks the
role name and fails the test.

## 4. Open items

| Item                                                                                                                                                                                                | Severity       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Role model not applied to any persistent database (needs the authorized cutover)                                                                                                                    | Medium (open)  |
| Grant credential holders can grant without a TOTP code (by design; documented)                                                                                                                      | Low (accepted) |
| The grant role's DELETE on `two_factor_used_codes` (needed to purge expired claims) would let a grant-credential holder remove unexpired claims and re-enable a code replay within its ~90 s window | Low            |
| Superuser / owner can bypass everything (inherent)                                                                                                                                                  | Accepted       |
