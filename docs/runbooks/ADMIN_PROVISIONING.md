# Platform administrator provisioning runbook

Platform administrators (`users.is_platform_admin`) open `/{locale}/admin` (storage
settings, credits, plans). The admin gate (`src/server/admin/platform-admin.ts`) also
requires a verified email, two-step verification and a session that completed the second
factor; this runbook covers how the flag itself is granted and removed. The database role
model it relies on is in `docs/runbooks/DATABASE_ROLES.md`.

## 1. What is enforced, and by what

| Rule                                                                      | Enforced by                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The application (runtime database role) can never set the flag            | **Only with the role model of DATABASE_ROLES.md:** the runtime role has no UPDATE privilege on the column, cannot execute the grant function, owns no table, trigger or function, and cannot create objects. New rows can never carry the flag (guard trigger). Tested on disposable roles (`tests/integration/db-roles.test.ts`).      |
| The flag is set only by `public.platform_admin_grant`                     | SECURITY DEFINER function (migration `20261014140000`): fixed `search_path`, schema-qualified objects, EXECUTE revoked from PUBLIC and granted to the operator grant role only. It locks the account, re-checks every precondition and writes the `platform_admin.granted` audit entry itself (with the database login that called it). |
| Only for an account with a verified email and two-step verification on    | The function, the guard trigger (`users_platform_admin_grant_guard`) and the grant service.                                                                                                                                                                                                                                             |
| The person proves possession of the enrolled authenticator at grant time  | `pnpm admin:grant` (`src/server/admin/platform-admin-grant.ts`): a current TOTP code checked against the account's stored secret, claimed, then the function is called — one transaction.                                                                                                                                               |
| The code is single-use and cannot be reused for a sign-in (or vice versa) | Shared replay table `two_factor_used_codes`, written only through `public.two_factor_claim_code` (`claimTotpCode`); the grant and runtime roles have no privilege on the table.                                                                                                                                                         |
| The code does not appear on screen, in the process list or in logs        | On a terminal it is typed without echo (raw mode, restored on every exit path); a `--code` argument is refused (exit 2) without echoing it; it is never printed, logged or audited.                                                                                                                                                     |
| Every grant, denial and revocation is audited                             | `platform_admin.granted` (by the function) / `platform_admin.grant_denied` / `platform_admin.revoked` (operator and reason, redacted; never the code or secret). The runtime role cannot UPDATE or DELETE audit entries.                                                                                                                |
| Losing two-step verification removes the flag; recovery never restores it | Trigger: two-factor turned off → flag cleared (also when the runtime role turns it off). Audited (`cause`: `mfa_reset` or `mfa_disabled`). Re-enrolling does **not** restore it: a new grant is required.                                                                                                                               |
| Requests, sign-up and seed cannot set the flag                            | `input: false` in Better Auth; static tests (`tests/unit/tenancy-boundaries.test.ts`, `platform-admin-provisioning.test.ts`).                                                                                                                                                                                                           |

**Limits — read before relying on this:**

- **The database cannot verify a TOTP code.** The secret is encrypted with `AUTH_SECRET`,
  outside the database. The code check runs in `pnpm admin:grant`; the database only
  guarantees that the caller holds the **grant role** credential. Whoever holds that
  credential (and `AUTH_SECRET`) can call the function directly, without a code. The
  grant credential is therefore an operator secret: issue it to the few people who run
  this workflow, keep it out of the application's environment, and review every
  `platform_admin.granted` entry (its `databaseUser` shows the login used).
- **Until the role model is applied** (DATABASE_ROLES.md), the application connects as
  the owner of every table: that role can set the old grant marker or disable the trigger,
  i.e. grant administrators. In that state the trigger only stops accidental writes.
- A PostgreSQL superuser and the owner (migration) role can always bypass everything here.
  Keep the owner credential with the deployment pipeline only.

## 2. Grant

1. Verify the person's identity out of band (video call with a known colleague, company
   ID — never by email alone) and record a ticket.
2. The person signs up, verifies their email and turns on two-step verification on
   `/{locale}/account/security` **during the call**, on their own device.
3. On an operator host, with `ADMIN_GRANT_DATABASE_URL` (the grant role; without it
   `DATABASE_URL` is used, which the production runtime role cannot grant with) and
   `AUTH_SECRET` in the environment — never typed on the command line:

   ```bash
   pnpm admin:grant --email <staff email> --confirm <staff email> \
     --operator "<operator name>" --reason "<ticket>: identity verified by <how>"
   ```

   In the ops image, which carries no pnpm (Pass 36), the same command is (likewise
   `scripts/admin/mfa-reset.ts`):

   ```bash
   node --import tsx --import ./scripts/video-retention/register.mjs scripts/admin/grant.ts \
     --email … --confirm … --operator "…" --reason "…"
   ```

   The script asks for the **current** 6-digit code. The person reads it from their own
   authenticator during the call; type it at the prompt. On a terminal nothing is echoed
   (not even asterisks) and the terminal is restored afterwards, including on Ctrl-C
   (`CANCELLED`, exit 130) and on SIGTERM/SIGHUP. A SIGKILL cannot be intercepted: if the
   terminal is left without echo, run `stty sane`.

   **Non-interactive input** (a pipe): the script reads one line from standard input. That
   is only as secret as the way it is produced — stdin itself guarantees nothing. Safe:

   ```bash
   read -rs CODE && printf '%s\n' "$CODE" | pnpm admin:grant --email … --confirm … \
     --operator "…" --reason "…"; unset CODE
   ```

   (`read -s` does not echo; `printf` is a shell builtin, so the code is not in any
   process's arguments.) Unsafe: `echo 123456 | pnpm admin:grant …` typed literally (shell
   history), or a code in a file, a CI variable or a log.

4. Output (one JSON line) and exit code:

   | Output                                           | Exit | Meaning                                                                                                                |
   | ------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------- |
   | `GRANTED`                                        | 0    | Done. The person signs in again (password + code) to open the admin area.                                              |
   | `ALREADY_ADMIN`                                  | 0    | Nothing changed.                                                                                                       |
   | `DENIED` `INVALID_CODE`                          | 2    | Wrong, expired or already-used code — wait for the next code and retry. If it keeps failing, see below.                |
   | `DENIED` `MFA_NOT_ENROLLED` / `EMAIL_UNVERIFIED` | 2    | Finish step 2 first.                                                                                                   |
   | `DENIED` `MFA_LOCKED`                            | 2    | Too many failed codes; wait 15 minutes.                                                                                |
   | `DENIED` `NOT_FOUND`                             | 2    | No such account.                                                                                                       |
   | `REFUSED`                                        | 2    | Bad arguments (`--confirm` mismatch, a code on the command line, missing `AUTH_SECRET` or database URL).               |
   | `CANCELLED`                                      | 130  | Ctrl-C at the prompt; nothing was read or changed.                                                                     |
   | `FAILED` (stderr)                                | 1    | Database or configuration error — including the runtime credential being refused by the database. Nothing was granted. |

   If the person's codes are consistently refused although their device clock is right,
   the account's authenticator is **not theirs** (someone holding the password may have
   enrolled their own device): treat the account as compromised — `pnpm admin:mfa-reset`,
   new password, enroll again during the call, then grant.

## 3. Revoke

With the grant role credential (psql connected as that role):

```sql
SELECT public.platform_admin_revoke(
  (SELECT id FROM users WHERE email = '<staff email>'), '<operator name>', '<ticket>: reason');
```

Returns `REVOKED` (audited as `platform_admin.revoked`, `cause: manual`), `NOT_ADMIN` or
`NOT_FOUND`. Takes effect on the next request (the flag is read on every request). Turning
two-step verification off, or `pnpm admin:mfa-reset`, also revokes it (audited
automatically). In an emergency the owner (migration) credential can also
`UPDATE users SET is_platform_admin = false …` — record it in the incident log.

## 4. Review

Keep the list of administrators minimal and review it periodically:

```sql
SELECT email, two_factor_enabled, email_verified FROM users WHERE is_platform_admin;
SELECT created_at, action, entity_id, metadata FROM audit_logs
WHERE action LIKE 'platform_admin.%' ORDER BY created_at DESC LIMIT 50;
```

Any `platform_admin.granted` without a matching ticket — or with an unexpected
`databaseUser` — is an incident (`docs/runbooks/INCIDENT_RESPONSE.md` § 4.5).
