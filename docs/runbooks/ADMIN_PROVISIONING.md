# Platform administrator provisioning runbook

Platform administrators (`users.is_platform_admin`) open `/{locale}/admin` (storage
settings, credits, plans). The admin gate (`src/server/admin/platform-admin.ts`) also
requires a verified email, two-step verification and a session that completed the second
factor; this runbook covers how the flag itself is granted and removed.

## 1. What is enforced (not procedure)

| Rule                                                                      | Enforced by                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The flag is set only by the grant workflow                                | Database trigger `users_platform_admin_grant_guard` (migration `20261014120000_platform_admin_grant_guard`): any other change to `true` is refused (`insufficient_privilege`).              |
| Only for an account with a verified email and two-step verification on    | Same trigger (`check_violation`) and the grant service.                                                                                                                                     |
| The person proves possession of the enrolled authenticator at grant time  | `pnpm admin:grant` (`src/server/admin/platform-admin-grant.ts`): a current TOTP code checked against the account's stored secret, in the same transaction.                                  |
| The code is single-use and cannot be reused for a sign-in (or vice versa) | Shared replay table `two_factor_used_codes` (`claimTotpCode`).                                                                                                                              |
| The code never appears in shell history or the process list               | The CLI reads it from standard input; a `--code` argument is refused (exit 2) without echoing it.                                                                                           |
| Every grant and every denial for a known account is audited               | `platform_admin.granted` / `platform_admin.grant_denied` (operator and reason, redacted; never the code or secret).                                                                         |
| Losing two-step verification removes the flag; recovery never restores it | Trigger: two-factor turned off → flag cleared. Audited as `platform_admin.revoked` (`cause`: `mfa_reset` or `mfa_disabled`). Re-enrolling does **not** restore it: a new grant is required. |
| Requests, sign-up and seed cannot set the flag                            | `input: false` in Better Auth; static tests (`tests/unit/tenancy-boundaries.test.ts`, `platform-admin-provisioning.test.ts`).                                                               |

The migration also clears the flag on every existing account without two-step
verification (re-grant them with this runbook after they enroll).

**Residual risk:** a database superuser can still bypass the trigger (set the grant marker
by hand, or disable the trigger). Database credentials with write access are therefore
admin-equivalent: keep them limited to the operators who run this workflow, and review
`platform_admin.*` audit entries (§4).

## 2. Grant

1. Verify the person's identity out of band (video call with a known colleague, company
   ID — never by email alone) and record a ticket.
2. The person signs up, verifies their email and turns on two-step verification on
   `/{locale}/account/security` **during the call**, on their own device.
3. On a host with database access (`DATABASE_URL`, `AUTH_SECRET` in the environment):

   ```bash
   pnpm admin:grant --email <staff email> --confirm <staff email> \
     --operator "<operator name>" --reason "<ticket>: identity verified by <how>"
   ```

   The script asks for the **current** 6-digit code. The person reads it from their own
   authenticator during the call; type it at the prompt (it is not echoed back, logged or
   stored in clear).

4. Output (one JSON line) and exit code:

   | Output                                           | Exit | Meaning                                                                                                 |
   | ------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------- |
   | `GRANTED`                                        | 0    | Done. The person signs in again (password + code) to open the admin area.                               |
   | `ALREADY_ADMIN`                                  | 0    | Nothing changed.                                                                                        |
   | `DENIED` `INVALID_CODE`                          | 2    | Wrong, expired or already-used code — wait for the next code and retry. If it keeps failing, see below. |
   | `DENIED` `MFA_NOT_ENROLLED` / `EMAIL_UNVERIFIED` | 2    | Finish step 2 first.                                                                                    |
   | `DENIED` `MFA_LOCKED`                            | 2    | Too many failed codes; wait 15 minutes.                                                                 |
   | `DENIED` `NOT_FOUND`                             | 2    | No such account.                                                                                        |
   | `REFUSED`                                        | 2    | Bad arguments (`--confirm` mismatch, a code on the command line, missing `AUTH_SECRET`).                |
   | `FAILED` (stderr)                                | 1    | Database or configuration error; nothing was granted.                                                   |

   If the person's codes are consistently refused although their device clock is right,
   the account's authenticator is **not theirs** (someone holding the password may have
   enrolled their own device): treat the account as compromised — `pnpm admin:mfa-reset`,
   new password, enroll again during the call, then grant.

## 3. Revoke

```sql
UPDATE users SET is_platform_admin = false WHERE email = '<staff email>';
```

Takes effect on the next request (the flag is read on every request). Turning the flag
off needs no grant marker. Record it in the incident or access log. Turning two-step
verification off, or `pnpm admin:mfa-reset`, also revokes it (audited automatically).

## 4. Review

Keep the list of administrators minimal and review it periodically:

```sql
SELECT email, two_factor_enabled, email_verified FROM users WHERE is_platform_admin;
SELECT created_at, action, entity_id, metadata FROM audit_logs
WHERE action LIKE 'platform_admin.%' ORDER BY created_at DESC LIMIT 50;
```

Any `platform_admin.granted` without a matching ticket is an incident
(`docs/runbooks/INCIDENT_RESPONSE.md` § 4.5).
