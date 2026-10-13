# Incident response runbook

For the on-call operator. Every incident gets an entry in the incident log (§ 1) from the
first minute. Order of work in every scenario: **detect → contain → recover → verify →
record**. When in doubt, contain first: the kill switches below stop external effects
without losing data.

Related: monitoring signals (§ 2), BACKUP_RESTORE.md, DEPLOYMENT.md,
VIDEO_RETENTION_RUNBOOK.md, ADS_WHATSAPP_LIVE_TEST_SETUP.md.

## 1. Incident log (record for every incident)

Keep it outside the production systems (ticket or shared document). Never paste secrets,
tokens, customer message text or personal data — ids, counts and timestamps only.

- Id, severity (SEV1 customer data / money / platform down; SEV2 a feature down; SEV3
  degraded), owner, people involved.
- Timeline (UTC): first signal (alert key, log `requestId`, ops-status check), each action
  taken (switch flipped, deploy, restore, query run — the exact command, never its
  credentials), when service was restored.
- Impact: workspaces/users affected (counts, ids if needed), data lost (recovery window),
  external effects (messages or posts sent twice / not sent, ad spend, credits charged).
- Root cause, fix, and follow-ups (with owners). Customer/regulator notification decision
  and when it was made (personal-data incidents: decide within 72 hours of awareness —
  confirm the deadline with legal for the jurisdictions served).

## 2. Signals

| Signal                                                                                      | Source                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `event: "alert"` log lines; the alert webhook (when `ALERT_WEBHOOK_URL` is set)             | `src/server/monitoring/alert-sink.ts` — one delivery per key per 30 min, later occurrences counted (`suppressedSinceLastAlert`) |
| `server_error:<route\|action\|render>:<name>` (critical), `service_unavailable:…` (warning) | any 5xx from a route handler, server action or render (`requestId` in the log)                                                  |
| `automation_tick_phase_failed` (critical, `failedPhases`)                                   | the scheduler tick                                                                                                              |
| `ops:<check>` (critical/warning)                                                            | stuck states found after each tick (see below)                                                                                  |
| `email_delivery_failed:<transport>` (warning)                                               | the mailer                                                                                                                      |
| `video_retention_failed` (critical)                                                         | the retention run                                                                                                               |
| `GET /api/internal/ops-status` → 503                                                        | uptime monitor with `Authorization: Bearer $OPS_STATUS_SECRET`                                                                  |
| `GET /api/health?scope=readiness` → 503                                                     | load balancer / uptime monitor (database unreachable)                                                                           |
| `event: "admin.mfa_required"` warnings, audit `user.mfa_*`                                  | administrator access without a second factor; MFA changes                                                                       |

Ops-status checks: `automation_tick_last_success_age_seconds` (critical ≥ 900 s or never),
`automation_tick_last_run_failed`, `credit_holds_stuck` (HELD > 30 min),
`social_replies_sending_stuck` (> 20 min), `social_posts_publishing_stuck` (> 20 min),
`whatsapp_messages_sending_stuck` (> 1 h) — critical at 1; `social_replies_uncertain`,
`social_posts_uncertain`, `whatsapp_messages_uncertain` — warning at 1;
`social_replies_failed_24h`, `social_posts_failed_24h` — warning at 10;
`ai_generations_failed_1h` — warning at 5.

Credit-ledger integrity (`src/server/monitoring/ledger-integrity.ts`): the scheduled tick
re-checks the ledger every `LEDGER_INTEGRITY_INTERVAL_MINUTES` (default 60; once across
all processes; one read-only transaction with a 20 s statement timeout; counts only), and
ops-status reports the stored result — `credit_ledger_balance_without_ledger` (non-zero
balance, no ledger entry), `credit_ledger_balance_mismatch` (balance ≠ last ledger
entry), `credit_ledger_held_mismatch` (held ≠ open holds) — critical at 1;
`credit_ledger_integrity_check_failed` (last run hit a timeout or database error: state
unknown) — critical; `credit_ledger_integrity_age_seconds` — warning when it never
completed or is older than two intervals + 15 min.

The tick only alerts while it runs: a stopped scheduler is only visible to an **external**
monitor polling ops-status. Configure one before launch.

## 3. Kill switches (environment; change, then restart/redeploy the app)

| Switch                                                        | Effect                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCIAL_SENDING_ENABLED=false`                                | No reply, Page message or Page post from any path (scheduler, approvals, retries). AUTO agents only draft. Default: off. Data and queues are kept. |
| `WHATSAPP_SENDING_ENABLED=false`                              | No WhatsApp message is sent.                                                                                                                       |
| `ADS_EXECUTION_ENABLED=false`                                 | No campaign is created or activated.                                                                                                               |
| `AI_PROVIDER=disabled`                                        | No AI call (generation features refuse; nothing is charged).                                                                                       |
| Unset `AUTOMATION_CRON_SECRET` / pause the external scheduler | The tick endpoint answers 404: no scheduled planning, publishing, recovery or hold release. Use only when the tick itself does harm.               |
| Remove `users.is_platform_admin`                              | Immediate loss of admin access (read on every request).                                                                                            |

## 4. Scenarios

### 4.1 Scheduled jobs stopped

- **Detect**: ops-status 503 with `automation_tick_last_success_age_seconds` ≥ 900 or
  `null`; `automation_tick_phase_failed` alerts; growing `credit_holds_stuck`; posts past
  their time; `system_heartbeats` row `automation-tick` old.
- **Contain**: nothing is sent while the tick is down; no action needed unless a backlog
  would be sent all at once when it resumes (see 4.4 — consider
  `SOCIAL_SENDING_ENABLED=false` before restarting the tick after a long outage; posts
  more than 24 h late fail with `missed_window` by design).
- **Recover**: check the external scheduler (job exists, URL, `Authorization: Bearer
$AUTOMATION_CRON_SECRET`, not rate limited: 12 calls / 10 min). Run one tick by hand
  (`curl -X POST -H "Authorization: Bearer …" https://<host>/api/internal/automation-tick`
  or `pnpm automation:tick` on a host with the source). If a phase fails every time, read
  the `Scheduled tick phase failed` log (phase name, error) and fix forward; the other
  phases keep running.
- **Verify**: ops-status 200; `credit_holds_stuck` 0 after one tick (stale holds are
  released after 15 min); queued posts/replies move.
- **Record**: outage window, items late or failed (`missed_window`, `stale_reply`), holds
  released.

### 4.2 AI provider or email provider down

- **Detect**: `service_unavailable:*` / `server_error:*` alerts on AI actions,
  `ai_generations_failed_1h` ≥ 5; `email_delivery_failed:resend` alerts; users report
  missing verification/reset emails.
- **Contain**: AI — failures already release their credit holds (nothing is charged for a
  failed generation); if the provider returns garbage or costs spike, set
  `AI_PROVIDER=disabled`. Email — account emails never reveal whether an account exists,
  so failures are silent to users; tell support.
- **Recover**: check the provider's status page and our key/quota (never paste the key in
  the log). Rotate the key if it was revoked. Restart with the fixed configuration.
- **Verify**: one generation in a test workspace; one password-reset email to an operator
  account; alerts stop.
- **Record**: window, failed generations (count), emails not delivered (count by template
  from the logs).

### 4.3 Stuck credit holds accumulating

- **Detect**: `ops:credit_holds_stuck` (critical); customers report a lower available
  balance; `credit_held_vs_open_holds` in `scripts/ops/sql/integrity.sql` non-zero.
- **Contain**: holds only reserve credits; nothing is lost while they wait. If the tick is
  down, it is 4.1.
- **Recover**: run a tick — `releaseStaleHolds` releases every HELD hold older than 15
  minutes, one by one (a failing hold does not block the others). A hold that still does
  not release: read the tick log for its error; fix forward. **Never** edit balances or
  ledger rows by hand (the ledger is append-only); corrections go through the admin
  credits page (audited, ledger entry).
- **Verify**: `credit_holds_stuck` 0; integrity SQL `credit_held_vs_open_holds` 0 for the
  affected workspaces.
- **Record**: holds released (count), workspaces affected, any manual adjustment (ledger
  entry id, admin who made it).

### 4.3a Credit ledger inconsistency

- **Detect**: `ops:credit_ledger_balance_without_ledger`, `…_balance_mismatch` or
  `…_held_mismatch` (critical), or `credit_ledger_integrity_check_failed`.
- **Contain**: treat balances as untrusted until explained. If the counts grow, consider
  `AI_PROVIDER=disabled` (no new charges) while investigating. Do not deploy migrations.
- **Investigate**: run `scripts/ops/sql/integrity.sql` (read-only) on a replica or the
  database to list the affected workspaces; compare with recent credit audit entries
  (grants, plan changes) and deploys. A `check_failed` with `error_code = 'timeout'` in
  `ops_check_results` means the check could not finish (lock contention or load) — rerun
  at a quiet time before concluding anything.
- **Recover**: **never** edit balances or ledger rows by hand; corrections go through the
  admin credits page (audited ledger entry). A systematic cause (code defect) is fixed
  forward, then corrected per workspace.
- **Verify**: the next run (or after `LEDGER_INTEGRITY_INTERVAL_MINUTES`) reports 0 for
  all three counts.

### 4.4 Failed or uncertain sends (replies, posts, WhatsApp)

- **Detect**: `ops:social_replies_uncertain`, `ops:social_posts_uncertain`,
  `ops:whatsapp_messages_uncertain`, `*_sending_stuck`, `*_failed_24h` alerts; the
  workspace's social / WhatsApp pages.
- **Contain**: if sends are going wrong at scale (wrong content, duplicates, platform
  errors), `SOCIAL_SENDING_ENABLED=false` / `WHATSAPP_SENDING_ENABLED=false` immediately.
- **Recover**: UNCERTAIN means "the platform may or may not have it" — never resend
  blindly. Use the reply's or post's "check" action (reads the platform; answers sent /
  not sent / unknown; up to 10 pages); for WhatsApp, look the message up in WhatsApp
  Manager, then resolve it on the WhatsApp page. Not sent → retry is allowed; sent → it is marked sent;
  unknown → leave it UNCERTAIN and check on the platform by hand. Stuck SENDING is moved to
  UNCERTAIN by the tick after 10 minutes. Failed: read the error code (`graph_error`,
  `stale`, `superseded`, `claimed_elsewhere`, `missed_window`) — only delivery errors need
  action.
- **Verify**: uncertain count goes down only through checks; no duplicate on the platform.
- **Record**: items, outcome per item (sent / not sent / unknown), duplicates if any and
  the customer contact.

### 4.5 Suspected unauthorized access or data leak

- **Detect**: unexpected `admin.mfa_required` warnings, audit entries (`user.mfa_*`,
  `user.password_*`, `storage.*`, credit grants and plan changes) nobody claims, unusual logins, a
  report from outside, secrets found in a public place.
- **Contain** (in this order, as fast as possible):
  1. Remove `is_platform_admin` from any administrator not verified as safe
     (`docs/runbooks/ADMIN_PROVISIONING.md` § 3). Check `platform_admin.granted` audit
     entries against the access tickets.
  2. End sessions: `DELETE FROM sessions WHERE user_id = '<id>';` (or all sessions:
     `TRUNCATE sessions;` — everyone signs in again).
  3. If a session/cookie secret may be exposed, rotate `AUTH_SECRET` (§ 4.6 — it also
     resets every two-factor enrollment).
  4. Stop external effects: `SOCIAL_SENDING_ENABLED`, `WHATSAPP_SENDING_ENABLED`,
     `ADS_EXECUTION_ENABLED` = false.
  5. Rotate exposed provider keys (Meta app secret, OpenAI, Resend, storage keys,
     `AUTOMATION_CRON_SECRET`, `OPS_STATUS_SECRET`, `ALERT_WEBHOOK_TOKEN`) at the provider,
     then in the secret store.
  6. Preserve evidence: export the relevant audit_logs rows and app/hosting logs for the
     window before anything rotates them.
- **Recover**: fix the entry point; restore data only if it was altered (BACKUP_RESTORE.md
  — into a new database, then reconcile).
- **Verify**: no unexplained audit entries after containment; admins re-enrolled in MFA;
  rotated secrets in use (old ones rejected).
- **Record**: what was accessed (tables, workspaces, counts), how, when; notification
  decision (customers, Meta platform terms, regulators).

### 4.6 Encryption key lost or needing rotation

Keys: `AUTH_SECRET` (sessions, signed tokens, **encryption of two-factor secrets and
backup codes**), `ENCRYPTION_KEY` (AES-256-GCM of stored platform tokens: Meta, WhatsApp,
ads).

- **Rotation is not automated yet** (no key versioning in Flexibx code). Effects of
  replacing a key:
  - `AUTH_SECRET`: every session and pending email-verification/reset link becomes
    invalid (users sign in again); **every two-factor secret and backup code becomes
    undecryptable** — reset each enrolled user with `pnpm admin:mfa-reset` and have them
    enroll again (administrators cannot reach the admin area until they do).
  - `ENCRYPTION_KEY`: every stored platform token becomes unreadable — the integrations
    fail until each workspace reconnects (Meta, WhatsApp, ads).
- **Lost key** (no copy anywhere): same effects; there is no recovery of the encrypted
  values. Generate a new key, follow the effects above.
- **Contain** (suspected exposure): rotate as above; revoke platform tokens at the
  provider (Meta app → remove app access / reset app secret) so the old ciphertexts are
  worthless even with the old key.
- **Verify**: sign-in + second factor works for an operator; one workspace reconnects
  Meta and syncs.
- **Record**: which key, why, when, users/workspaces affected.
- Follow-up (recommended): add versioned keys (Better Auth supports a versioned
  `secrets` list; `ENCRYPTION_KEY` would need a key id prefix on ciphertexts) so a rotation
  re-encrypts instead of resetting.

### 4.7 Database failure or restore

- **Detect**: `/api/health?scope=readiness` 503, `server_error:*` alerts everywhere,
  provider alarms (storage full, failover, corruption).
- **Contain**: stop the scheduler; `SOCIAL_SENDING_ENABLED=false` (state may be behind
  reality after a restore); maintenance page.
- **Recover**: provider failover first (managed HA). Data loss or corruption → restore per
  BACKUP_RESTORE.md § 4 (PITR to just before the incident, else the latest verified dump)
  into a **new** database.
- **Verify**: BACKUP_RESTORE.md § 5 (all checks 0, migrations up to date), ops-status 200
  after one tick.
- **Record**: recovery point, data-loss window, items possibly sent twice/never (social,
  WhatsApp, ads) — check UNCERTAIN items and the platforms for that window.

### 4.8 Stopping social sending (`SOCIAL_SENDING_ENABLED`)

- When: wrong or duplicate replies/posts, a platform policy problem, a compromised Meta
  connection, any restore.
- How: set `SOCIAL_SENDING_ENABLED=false`, restart. Approving or retrying is refused
  (`social_sending_disabled`), AUTO agents only draft, the sweep sends nothing; the social
  page shows a notice. Nothing is deleted; replies decided while it is off stay queued.
- Turning it back on: first review the queue — replies older than 2 h (AUTO) / 24 h
  (approved) go back to a person automatically (`stale_reply`); posts more than 24 h late
  fail (`missed_window`). Check UNCERTAIN items (4.4) before enabling.

### 4.9 Lost administrator second factor

- The administrator uses one backup code to sign in, then regenerates codes or re-enrolls
  on `/{locale}/account/security`.
- Lost device **and** all backup codes: verify the person's identity out of band (video
  call with a known colleague, company ID — never by email alone), then an operator with
  database access runs:

  ```bash
  pnpm admin:mfa-reset --email <their email> --confirm <their email> \
    --operator "<operator name>" --reason "<ticket>: identity verified by <how>"
  ```

  Two-factor is removed, **every session of the account ends**, the platform-admin flag
  is removed by the database (`platform_admin.revoked`, `cause: mfa_reset`), and the reset
  is in the audit log (`user.mfa_reset_by_operator`, operator and reason). The person signs
  in with the password and enrolls again during a live call with the operator; admin
  authority comes back **only** through a new grant
  (`docs/runbooks/ADMIN_PROVISIONING.md` § 2) — re-enrolling alone does not restore it.

## 5. After every incident: verification checklist

- [ ] `/api/health?scope=readiness` 200; ops-status 200 after a tick.
- [ ] No new `server_error:*` alerts for 30 minutes.
- [ ] Kill switches back to their pre-incident values (and the change recorded).
- [ ] UNCERTAIN items reviewed; no duplicates on the platforms.
- [ ] Integrity SQL (`scripts/ops/sql/integrity.sql`) all 0 when money or a restore was
      involved.
- [ ] Secrets rotated where exposure was possible; old ones rejected.
- [ ] Incident log complete; follow-ups assigned.
