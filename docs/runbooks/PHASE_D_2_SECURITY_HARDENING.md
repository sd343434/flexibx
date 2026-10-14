# Phase D.2 — security hardening before staging

Date: 2026-10-14. Branch `claude/amazing-sagan-pvouqy`, baseline HEAD `451c4f6` (equal to
the remote). All changes are local and uncommitted. Every database used was disposable (a
throwaway test database and throwaway roles on a local PostgreSQL 16, created and dropped
by the tests); no persistent database was contacted, no migration was applied anywhere
else, no cloud resource, account or secret was created, nothing was deployed.

**Passing local tests does not make these changes safe on a managed service.** § 7 lists
what must still be proven in staging.

## 1. Risks addressed (from the Phase D.1 review)

| #   | Risk                                                                                                                                                                                                                                                                                           | Severity before |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| R1  | `db-roles.sql` refused only memberships that reach the owner or a role with the SUPERUSER attribute. `rds_superuser` (Amazon RDS) has no such attribute, and predefined roles (`pg_write_all_data`, `pg_read_all_data`, …) were not checked: a runtime or grant role holding them was accepted | Medium          |
| R2  | TOTP replay: the runtime and grant roles held table-level DELETE on `two_factor_used_codes` (the "expired only" condition lived in application code), so either credential could delete an unexpired claim and have a used code accepted again within its window                               | Low             |
| R3  | No image contained `psql` / `pg_dump` 16, which `db-roles.sql` and the backup scripts need, so the role cutover and backups could not run as one-off jobs next to a private database                                                                                                           | Blocks cutover  |

## 2. Changes

**R1 — role membership (`scripts/ops/sql/db-roles.sql`).**

- Precondition: the runtime and grant roles must be a member of **no role at all**,
  directly or through a chain (`pg_has_role(…, 'MEMBER')` over every role), in addition to
  the existing attribute, owner-reach and superuser-reach checks. The error names the
  roles found. `pg_database_owner` is excluded only from the precondition (it is implicit
  for the database owner and the script transfers ownership) and re-checked afterwards.
- New postconditions (the whole run rolls back if one fails): no privilege of either role
  on `two_factor_used_codes`; EXECUTE on the claim function for both; the grant role holds
  table privileges only on `two_factors` and `audit_logs` (plus its column privileges on
  `users`); the only SECURITY DEFINER functions either role can execute are the approved
  ones; still no membership after the ownership transfer.

**R2 — TOTP claim (`prisma/migrations/20261014150000_totp_claim_function`,
`src/server/auth/totp-replay.ts`, `db-roles.sql`).**

- New function `public.two_factor_claim_code(p_user_id uuid, p_code_hash text) RETURNS
boolean`: `SECURITY DEFINER`, owned by the owner role, `SET search_path = pg_catalog,
pg_temp`, every object schema-qualified, no dynamic SQL, `REVOKE ALL … FROM PUBLIC`.
  It validates its arguments (non-null account, a 64-character lowercase hex digest — the
  code itself never reaches the database), deletes **only that account's** claims with
  `expires_at < now()` (database clock), inserts the claim with a 3-minute lifetime using
  `INSERT … ON CONFLICT DO NOTHING` (the primary key makes exactly one concurrent claim
  win) and returns whether it won. An unknown account fails on the foreign key (an error,
  never a fresh claim). Wrapped in `BEGIN … COMMIT`; additive.
- `claimTotpCode(db, userId, code)` now makes one call of that function (the `now`
  argument is gone: the database clock decides). Callers updated: sign-in hook
  (`auth-config.ts`), enrollment (`two-factor.ts`), grant service
  (`platform-admin-grant.ts`).
- `db-roles.sql`: `REVOKE ALL ON two_factor_used_codes` from the runtime role (the grant
  role no longer receives `SELECT, INSERT, DELETE`); `GRANT EXECUTE` on the function to
  both.
- Account deletion still removes the account's claims (the foreign key's cascade runs with
  the table owner's rights — tested under the runtime role). Audit behaviour is unchanged
  (claims were never audited; grants and denials still are).

**R3 — operations image (`Dockerfile`, new target `ops`).** `FROM build` (the migrate
image: full source, `tsx`, Prisma) plus `postgresql-client-16` from the PostgreSQL
project's repository, configured by Debian's `postgresql-common` helper with the signing
key that Debian package ships (bookworm's own client is 15, which cannot dump a 16
server). Runs as `node`; no default command. The `runner` and `migrate` targets are
unchanged. **Build only partly verified** (§ 3): the base, dependency and Next.js build
stages built locally under Docker, but the `ops` package step could not run because this
environment's network policy blocks `deb.debian.org` and `apt.postgresql.org`; so
`psql`/`pg_dump` 16 inside the image are **not** verified. CI builds only `--target
runner`; building `--target ops` in CI is proposed in § 9.

**Credentials for jobs in that image** (documented in `DATABASE_ROLES.md`): the URL is
injected as an environment variable by the secret manager; `scripts/ops/lib/pgenv.sh`
(`pg_use_url VARIABLE`) converts it into libpq variables and a mode-0600 `PGPASSFILE` in
a private temporary directory and removes the variable, so `psql`, `pg_dump` and
`pg_restore` never get a URL or password argument. Checked here: while `psql` ran through
that path, no process argument contained the (random, 36-character) password.

**Documentation updated:** `DATABASE_ROLES.md` (role table, checks, claim function,
deploy order, credential handling, managed-service caveat), `DEPLOYMENT.md` (new
migration and its order), `ADMIN_PROVISIONING.md`, `ARCHITECTURE.md`; this report.

**Tests added or changed:**

- `tests/integration/db-roles.test.ts`: refusal of a predefined role granted directly
  (`pg_write_all_data` → runtime), a managed-admin stand-in (`NOLOGIN CREATEROLE
CREATEDB`, member of `pg_signal_backend`, like `rds_superuser`) reached by the grant role
  through a group role, `pg_read_all_data` reached indirectly, and an unprivileged group
  role; each refusal changes nothing and a clean run follows; after a clean run neither
  role belongs to any role nor can `SET ROLE` to a privileged one.
- `tests/integration/totp-claim-roles.test.ts` (new, disposable roles): function owner,
  SECURITY DEFINER, `search_path`, no PUBLIC EXECUTE; for each role — claim once, second
  claim refused, DELETE/UPDATE/INSERT/TRUNCATE/SELECT on the table refused, the claim
  survives and the code stays refused; only the calling account's expired claims removed;
  12 concurrent claims from both roles → exactly one wins; malformed digests (SQL-injection
  string, uppercase, short, empty, NULL account) and unknown accounts → error, no row; a
  caller's temporary table of the same name does not divert the function; account deletion
  under the runtime role removes the claims.
- `tests/integration/admin-mfa.test.ts`: the replay/concurrency test now uses the database
  clock and asserts other accounts' expired claims are left alone.
- `tests/unit/totp-claim-function.test.ts` (new): static guarantees of the migration, the
  lifetime equal to `USED_TOTP_CODE_TTL_MS`, the application path, the role-script grants.
- `tests/unit/tenancy-boundaries.test.ts`, `tests/integration/admin-grant.test.ts`: new
  `claimTotpCode` signature.
- Two existing tests proven timing-unstable (§ 3), fixed without changing assertions:
  `tests/unit/social-pages-and-webhook-size.test.ts` (20 s budget for the oversized-body
  webhook test) and `tests/integration/orchestration.test.ts` (waits out the last 15 s of
  a minute before the per-minute deduplication check).

## 3. Test results (actually run, disposable databases only)

**Final verification run (2026-10-14, after the flaky-test fixes below):**

| Check                                                                     | Result                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm format:check`, `lint`, `typecheck`, `db:validate`, `phase:validate` | exit 0 each                                                                     |
| `pnpm test` (unit, full)                                                  | 980/980                                                                         |
| `pnpm test:integration` (full)                                            | 762/762, none skipped (the 21 role/claim tests ran with a disposable superuser) |
| `pnpm build`                                                              | exit 0                                                                          |
| `pnpm e2e` (disposable database, dropped after)                           | 36/36 passed                                                                    |
| Credential path (`pgenv.sh` → `psql`)                                     | password not present in any process argument while `psql` ran                   |
| `docker build --target ops` (local, not pushed)                           | **partial / deferred** — see below                                              |
| Secret scan (gitleaks)                                                    | not run; a pattern scan of the diff found no credentials                        |

Earlier runs: baseline before the changes 37/37 (5 role/TOTP files); focused after the
changes 51/51.

**Failures of the first full run, diagnosed** (that run: unit 977/980, integration
761/762):

1. `social-pages-and-webhook-size.test.ts` › "the Meta webhook answers 413 to an oversized
   chunked body" — **genuinely too close to its limit.** Measured: 2.8–3.3 s alone and in
   idle full runs; 4,963 ms and 5,206 ms with four CPU-bound processes on the four vCPUs;
   the failure was 5,191 ms against the default 5,000 ms limit. Fix (test only, assertions
   unchanged): a 20 s budget for that test. After the fix it passes under the same
   contention (5,206 ms).
2. `ai-review.test.ts` › two "phase status collection" tests (6,880 / 8,763 ms in the
   failing run) — **environmental stall, not reproduced.** Measured: 127–252 ms alone, in
   three idle full runs, after dropping the OS file cache, and 266–415 ms under CPU
   contention. The failing run was the first after a worker restart and took 36 s in total
   (normal: 20–22 s). The tests are far from their limit; **not changed**. If it recurs,
   capture system state at the time.
3. `orchestration.test.ts` › "shows each step's honest state…" — **timing-dependent test,
   proven.** Manual runs are deduplicated by a key containing the UTC minute
   (`src/server/orchestration/runs.ts`); the test expects two calls separated by a whole
   `executeRun` to share a minute. A temporary probe with the clock pinned (deleted after)
   showed: same minute → `created: false`; 200 ms apart across a minute boundary →
   `created: true` — exactly the observed failure. Product behaviour is as designed. Fix
   (test only): wait out the last 15 s of a minute before the first call (budget 40 s).

**Operations image build.** The Docker daemon was started locally and the image built from
a scratchpad copy of the Dockerfile that only adds the sandbox proxy's CA (the repository
`Dockerfile` is unchanged; nothing was pushed). Base image pull, `pnpm install`,
`prisma generate` and `next build` succeeded; the first `apt-get` in the `ops` stage
failed because this environment's network policy blocks `deb.debian.org` (DNS) and
`apt.postgresql.org` (HTTP 403 from the egress proxy). **Deferred:** build `--target ops`
where those hosts are reachable (CI or staging) and run `psql --version` /
`pg_dump --version` inside it (expected 16.x).

**Mutation checks** (each change applied, the role and claim suites run, then the original
restored and verified byte-identical):

| Mutation                                                        | Result       |
| --------------------------------------------------------------- | ------------ |
| Membership precondition and postcondition removed               | 4 tests fail |
| Grant role keeps SELECT/INSERT/DELETE on the table (checks off) | 1 test fails |
| Function deletes expired claims of every account                | 1 test fails |
| Function always returns true                                    | 4 tests fail |
| Runtime role keeps its table privileges (checks off)            | 1 test fails |
| Digest validation removed                                       | 1 test fails |
| Function also deletes claims up to an hour before expiry        | 4 tests fail |

## 4. Privileges of each role after the change

| Role    | Has                                                                                                                                                                                                                                                                   | Does not have                                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner   | Owns the database, schema `public`, every table, sequence, type and function (including the three SECURITY DEFINER functions); runs migrations and `db-roles.sql`                                                                                                     | — (trust root)                                                                                                                                                                                                         |
| runtime | CONNECT; USAGE on `public`; SELECT/INSERT/UPDATE/DELETE on application tables except: no UPDATE of `users.is_platform_admin`, no UPDATE/DELETE/TRUNCATE on `audit_logs`, nothing on `_prisma_migrations` and `two_factor_used_codes`; EXECUTE `two_factor_claim_code` | Membership in any role; SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS/REPLICATION; CREATE on the database or schema; ownership of anything; EXECUTE on `platform_admin_grant`/`_revoke`; any other SECURITY DEFINER function |
| grant   | CONNECT; USAGE on `public`; SELECT on `users(id, email, email_verified, two_factor_enabled, is_platform_admin)` and `two_factors`; INSERT on `audit_logs`; EXECUTE `platform_admin_grant`, `platform_admin_revoke`, `two_factor_claim_code`                           | Membership in any role; privileged attributes; any other table (sessions, accounts, `two_factor_used_codes`, …); UPDATE of `users`; DDL; any other SECURITY DEFINER function                                           |
| PUBLIC  | CONNECT and TEMP on the database (PostgreSQL defaults)                                                                                                                                                                                                                | CREATE on the database or schema; any table or sequence privilege; EXECUTE on the three SECURITY DEFINER functions                                                                                                     |

## 5. Review findings and residual risks

Reviewed: the whole diff, the migration, the role script, the code path and the
Dockerfile change.

- **No replay:** neither limited role can delete, update, insert or read
  `two_factor_used_codes` directly; the function never deletes an unexpired claim
  (tested, and mutation-checked).
- **No deletion of other accounts' records:** the function deletes only rows of the
  account passed in, and only expired ones. A caller can name another account, but then
  only that account's already-expired claims are removed — no effect on security.
- **No privilege widening:** `search_path` fixed, objects qualified, no dynamic SQL,
  arguments validated, EXECUTE only for the two roles; the role script refuses any
  membership and any unapproved SECURITY DEFINER function, and rolls back on failure.
- **Residual (Low): denial of service by pre-claiming.** A caller can name any account,
  and the code hash (SHA-256 of account id and code) is computable for all 1,000,000
  codes, so a holder of the runtime or grant credential could pre-claim another account's
  codes and block its TOTP sign-ins for 3 minutes at a time. Not a regression (the grant
  role already had INSERT on the table; the runtime role can already delete accounts), and
  it can never let anyone in. Accepted; noted for review.
- **Residual (Low): clock skew.** Claim expiry uses the database clock; code acceptance
  uses the application clock. A replay would need the database clock to run more than
  about 90 s ahead of the application's (3-minute lifetime minus the ±30 s acceptance
  window). Both run on NTP-synchronised managed hosts; check in staging.
- **Ordering:** migrate → deploy the application → re-run `db-roles.sql`. Running the role
  script before the new application is live makes TOTP sign-ins fail closed (§ 8).
- **Dockerfile:** packages come from Debian's mirror and PGDG over HTTPS, verified with the
  key shipped in Debian's `postgresql-common`; the version is not pinned beyond major 16
  (minor updates follow the repository) — pin if reproducible builds are required.

## 6. What is proven locally, and how far

- Proven on PostgreSQL 16.15 (local, disposable): every statement in § 2 and § 3,
  including the membership checks with a stand-in for `rds_superuser` built from the
  attributes AWS documents (NOLOGIN, no SUPERUSER, CREATEROLE, CREATEDB, member of a
  predefined role).
- **Not proven:** behaviour of the real `rds_superuser` and of the RDS master user; that
  ownership transfer, `ALTER DEFAULT PRIVILEGES FOR ROLE`, column grants and a SECURITY
  DEFINER function owned by a non-superuser owner work on the managed service; extra
  memberships the provider may add to roles it creates (the script would refuse them —
  correct, but it would block the cutover until resolved); the `ops` image build.

## 7. To prove in staging (before any production cutover)

1. Build `--target ops`; run `psql --version` / `pg_dump --version` (16.x) inside it.
2. As the RDS master user: create owner, runtime and grant roles; confirm with
   `SELECT r.rolname, g.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
JOIN pg_roles g ON g.oid = m.roleid` that the runtime and grant roles belong to no role
   (PostgreSQL 16 makes the **creator** a member of the roles it creates, not the reverse
   — confirm).
3. Run migrations as the owner, then `db-roles.sql` from the `ops` task with the
   credential path of `DATABASE_ROLES.md`; it must print `db-roles: applied`.
4. Deliberately grant `rds_superuser` (and separately `pg_write_all_data`) to the runtime
   role and confirm the script refuses and changes nothing; revoke.
5. `DATABASE_ROLES.md` § 3 checklist, plus: as runtime and as grant, DELETE on
   `two_factor_used_codes` → permission denied; TOTP sign-in works; a replayed code is
   refused; `pnpm admin:grant` works with a valid code.
6. Grep a day of staging logs for the role passwords (none expected).

## 8. Rollback and its limits

- **Before production:** nothing to roll back (local, uncommitted).
- **Application rollback after deployment:** an application version from before this
  change writes `two_factor_used_codes` directly. While the application connects as the
  owner (pre-cutover) it keeps working. **After `db-roles.sql` has run, an older version
  cannot claim codes: TOTP sign-ins, enrollments and grants fail closed** (refused, not
  bypassed). Order the release migrate → deploy → `db-roles.sql`, and do not roll the app
  back past this change after the role script ran — or, as an incident measure, restore
  the old table privileges by re-running the previous `db-roles.sql` (this reopens R2).
- **Schema:** the migration only adds a function; the previous application ignores it.
  Removing it means a new forward migration (`DROP FUNCTION`) together with the previous
  role script — never by editing the applied migration.
- **Role script:** the stricter membership check can block a re-run on a database where
  the limited roles were given memberships; the run then changes nothing (one
  transaction). Fix the membership, do not weaken the check.

## 9. Needs your approval

1. Commit and push these changes (not done).
2. Add `--target ops` to the CI Docker job so the image is built on every change (proposed,
   not done: a CI change).
3. Staging steps of § 7 (they need the infrastructure decisions of Phase D.1).
4. To verify the `ops` image in this environment: allow `deb.debian.org` and
   `apt.postgresql.org` in the environment's network settings — or verify it in CI/staging.
5. Accepted residual risks: the owner and master credentials can still delete claims
   (trusted roles); a grant-credential holder can still grant without a TOTP code (the
   database cannot verify TOTP — unchanged, documented in `DATABASE_ROLES.md`); the Low
   pre-claim denial-of-service and clock-skew items of § 5.
