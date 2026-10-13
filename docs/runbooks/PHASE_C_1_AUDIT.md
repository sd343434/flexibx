# Phase C.1 — audit remediation record

Date: 2026-10-13. Base: `claude/amazing-sagan-pvouqy` at `7703eb5`. Local implementation
and validation only — nothing committed, pushed, merged or deployed; no migration ran on a
persistent database (`flexibx`, `flexibx_test` untouched); every database used was a
throwaway one, dropped afterwards.

## 1. Findings and decisions

| #   | Finding (severity)                                                      | Status                                    | Remediation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Admin MFA enrollment/provisioning protection was procedural (Medium)    | **Fixed (enforced)**                      | `pnpm admin:grant` (`src/server/admin/platform-admin-grant.ts`): proof of possession — a current TOTP code from the account's enrolled authenticator, read from stdin, single-use (shared replay table), checked in the same transaction that sets the flag; audited grants and denials. Database trigger (migration `20261014120000_platform_admin_grant_guard`) refuses the flag outside that transaction, requires verified email + two-factor, and clears the flag when two-factor is turned off (reset or disable); the migration revokes existing admins without two-factor. Runbook: `ADMIN_PROVISIONING.md`. |
| 2   | Database URLs with passwords in process arguments (Medium)              | **Fixed**                                 | `scripts/ops/lib/pgenv.sh` + `pg-url.mjs`: URL → libpq environment + 0600 temporary `PGPASSFILE` (removed on exit/failure/interrupt); fails closed on any URL it cannot map exactly; SSL and connection options preserved. `db-verify.sh` no longer starts Prisma (its schema engine takes the URL on its command line): the migration check is done in SQL with Prisma's checksums. Also fixed: `db-verify.sh` reported `VERIFIED` when psql could not connect (fail-open).                                                                                                                                         |
| 3   | Credit-ledger integrity not continuously monitored (Medium)             | **Fixed**                                 | `src/server/monitoring/ledger-integrity.ts`, run by the scheduled tick every `LEDGER_INTEGRITY_INTERVAL_MINUTES` (default 60), once across processes (atomic claim on `ops_check_results`, migration `20261014130000_ops_check_results`); READ ONLY transaction with a 20 s statement timeout; counts only. Ops-status: three violation counts (critical), failed run (critical), stale/never (warning). Not computed per HTTP request.                                                                                                                                                                              |
| 4   | TOTP replay claim happened after Better Auth accepted the code (Medium) | **Fixed**                                 | The code is claimed inside Better Auth's `session.create.before` hook (`auth-config.ts`), before the session row and cookie exist; `INSERT … ON CONFLICT DO NOTHING` (atomic, concurrency-safe); a replay or a database error refuses the session (fail closed); wrong guesses consume nothing.                                                                                                                                                                                                                                                                                                                      |
| 5   | No security notifications (Low)                                         | **Not implemented — proposal**            | § 4. Needs new bilingual email templates and product decisions; the existing `Mailer` abstraction (`src/server/mail`) is the place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | 4 cold-timing unit tests (Low)                                          | **No change (no evidence)**               | § 5. Not reproducible; no timeout changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | Docker build not verified (Low)                                         | **Verified with a sandbox-only CA layer** | § 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 2. Security rationale (short)

- **1:** the operator no longer decides "this account's authenticator is the right
  person's" by watching a screen: the code must match the stored secret at grant time, so
  an authenticator enrolled by someone holding only the password is exposed (the real
  person's device produces different codes). The database enforces the outcome even
  against application bugs or hand-written SQL by a non-superuser; losing two-factor can
  no longer leave a dormant admin flag that a re-enrollment silently revives.
- **2:** the process list (`ps`, `/proc/*/cmdline`) is readable by every local user; the
  environment and a 0600 file are not. Refusing unknown parameters avoids silently
  dropping a security setting (e.g. an SSL option).
- **3:** balance drift is now detected within one interval instead of at the next restore
  drill; a failed or timed-out check is reported as unknown (critical), never as healthy.
- **4:** the session and cookie are created only after the code is claimed, so a replay
  never yields a session, even briefly, and a database failure cannot be mistaken for a
  successful claim.

## 3. Test evidence

New or changed tests (all passing):

| Area | Tests                                                                                                                                                                       | What they prove                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `tests/integration/admin-grant.test.ts` (8), `admin-mfa.test.ts`, `admin-storage-flow.test.ts`; unit `platform-admin-provisioning`, `tenancy-boundaries`, `auth-boundaries` | wrong / used / another device's code denied and audited (redacted); not found, no MFA, unverified email, locked factor denied; repeat = `ALREADY_ADMIN`; DB refuses the flag outside the workflow and with another account's marker; reset and disable revoke (audited) and re-enrollment does not restore; CLI refuses `--code`, never echoes it, grants from stdin; TOTP implementation matches Better Auth. |
| 2    | `tests/unit/ops-db-scripts.test.ts` (19, fake pg_dump/psql/pg_restore)                                                                                                      | no URL or password in any argument or output; PG\* mapping incl. `sslmode`, `sslrootcert`, `connect_timeout`, `application_name`; passfile mode 600, `:`/`\` escaping, removed after success and failure; URL password wins over `PGPASSWORD`; 8 refusal cases before any connection; restore uses the confirmed name only; verify fails on connection failure and on pending / modified / unknown migrations. |
| 3    | `tests/integration/ledger-integrity.test.ts` (9), `monitoring.test.ts` (8)                                                                                                  | healthy, no-ledger balance, balance mismatch, held mismatch; injected query failure and lock-wait timeout recorded as errors (critical); table checksums identical after a run (no mutation); one run among 5 concurrent ticks and once per interval; stale result = warning; the tick runs it and ops-status reports it.                                                                                      |
| 4    | `tests/integration/totp-replay.test.ts` (5), unit `admin-mfa.test.ts` (hook parsing)                                                                                        | one-time acceptance, no cookie on replay; 5 concurrent uses → 1 session; claim failure → no session, code still usable; session insert failure → no session; wrong guess consumes nothing; backup code and normal TOTP sign-in work (also E2E `two-factor.spec.ts`).                                                                                                                                           |

Mutation checks (each made tests fail, then reverted): grant without code check (2
failures), grant ignoring replay (1); hook without refusal (4), hook failing open on a
database error (1); original backup/verify scripts (14 / 2 failures); ledger check failing
open on error (2), without the cadence claim (1), writing inside the check (1), without
no-ledger detection (1).

Real-database drills (throwaway databases and role, dropped afterwards):

- Backup → restore → verify with a throwaway role whose random password contains `:`,
  `@`, `/`, `\`: `VERIFIED` (57 tables, 28 migrations); a process sampler saw no URL and
  no password in any pg_dump / psql / pg_restore / script command line; unreachable
  database → `FAILED` exit 1; second restore refused; no temporary files left.
- Upgrade rehearsal: database at the previous release's 26 migrations with a legacy admin
  without two-factor, an admin with two-factor and a regular user → the two new
  migrations applied; legacy admin revoked, the other two unchanged (other columns
  byte-identical); direct grant refused; `migrate status` up to date; `db-verify.sh`
  `VERIFIED`.

## 4. Proposal: security notifications (finding 5, not implemented)

Send a short email through the existing `Mailer` (`src/server/mail`, Resend/SMTP/outbox)
to the account owner, never blocking the action and never containing codes, tokens or IPs
in full:

| Event (audit action)                                                  | Recipient                                           | Note                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `user.password_changed`, `user.password_reset`                        | the user                                            | "if this wasn't you" → reset link + support contact    |
| `user.mfa_enabled`, `user.mfa_disabled`, `user.mfa_reset_by_operator` | the user                                            | enrollment by an attacker is then visible to the owner |
| `user.mfa_backup_codes_regenerated`                                   | the user                                            |                                                        |
| `platform_admin.granted` / `.revoked`                                 | the user + an ops address (`SECURITY_NOTIFY_EMAIL`) | ops copy also through the alert sink                   |

Work: 4–5 templates in ar/en (`templates.ts`), a `notifySecurityEvent(audit action)`
helper called after the audit write (best effort, logged on failure), outbox-based tests.
Decisions needed: sender identity and support contact, whether new-device sign-in alerts
are wanted (needs device fingerprinting — out of scope).

## 5. Timing tests (finding 6)

Evidence gathered before deciding: the audit run (cold container, full suite) timed out
four tests at the 5 s default — three in `tests/unit/ai-review.test.ts` (each builds a git
repository with ~6 commits through `git` subprocesses) and one in
`tests/unit/social-pages-and-webhook-size.test.ts` (first dynamic import of the Meta
webhook route). Re-measured in Phase C.1: slowest of these 1.4–1.8 s warm (three runs);
the full unit suite with the Vite cache cleared passed in 15 s; again under concurrent
load (a Docker build, load average 3.3) 969/969 in 22 s. Not reproducible, ≥ 2.7× margin:
**no timeout changed** (raising it without a reproduction would only hide a regression).
If it recurs in CI, the targeted fix is to move the route import into `beforeAll` (hook
timeout 10 s) and to share one git fixture per `describe` in `ai-review.test.ts`.

## 6. Docker build (finding 7)

A Docker daemon was available but stopped in this container; started locally for the
check. Building the repository `Dockerfile` unchanged fails at `pnpm install` with
`SELF_SIGNED_CERT_IN_CHAIN`: the sandbox's egress proxy re-signs TLS and build
containers do not trust its CA (an environment limitation, not a Dockerfile defect). With
a scratch copy of the Dockerfile that only adds the proxy CA to the base stage (not in
the repository) and `--network host`: app image built (143 s, 447 MB, runs as the
non-root `flexibx` user, `server.js` present, no `.env`), migrate target built (138 s,
runs as `node`, contains all 28 migrations, no `.env`). CI (`.github/workflows/ci.yml`)
remains the authoritative build without the CA layer. Images were removed afterwards.

## 7. Remaining risks

- A PostgreSQL **superuser** (or the table owner) can bypass the grant trigger (set the
  marker by hand, disable the trigger). Database credentials with write access are
  admin-equivalent; the application role should not own the schema in production
  (separate migration role) — not done here (needs the hosting decision).
- Existing administrators **with** two-factor keep the flag after the migration; their
  enrollment predates proof of possession. Recommended: review them and re-grant during
  an identity-verified call (`ADMIN_PROVISIONING.md` § 4).
- `prisma migrate deploy` / `status` still put `DATABASE_URL` (with password) on the
  schema engine's command line; mitigated by running them only in the one-off migrate
  container (`DEPLOYMENT.md` § 1). Upstream Prisma behaviour.
- The ledger check scans all credit accounts once per interval; cost grows with
  workspaces (indexed lateral lookups, statement timeout 20 s). Revisit at scale.
- Security notifications (finding 5) are not implemented.
- The ops scripts now need `node` on the host that runs them.
