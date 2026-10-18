# Operational reliability (Pass 7)

What the scheduled work guarantees, what the operator can see, and how a restored database
is proven usable. Written in Pass 7 (2026-10-18). Everything here is verified **locally**
(automated tests and a drill on disposable databases); nothing has run on real hosting.
The production-readiness status of each item is in
[`PRODUCTION_READINESS_GAPS.md`](PRODUCTION_READINESS_GAPS.md) § 12.

## 1. Scheduled work: what holds under retries, overlap and restarts

The scheduler is one HTTP call, `POST /api/internal/automation-tick` (or
`pnpm automation:tick`), every 1–5 minutes. Delivery is **at least once**: a scheduler may
skip a slot, call twice, or call while a slow tick still runs. Nothing below assumes
exactly once.

| Situation                                              | What happens                                                                                                                                                                                                                                                                                                                                                                                                 | Test                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Two ticks at once                                      | Single flight: a PostgreSQL advisory lock (released on crash). The second returns `skipped` and raises a warning alert.                                                                                                                                                                                                                                                                                      | `automation-tick-lock.test.ts`                               |
| A tick runs long                                       | The 4-minute budget is now checked **before every item** of every phase (orchestration runs and scheduled slots, social publishing, drafting, sending and self-review, video jobs, Insights sources), not only between phases. The item in progress finishes; the rest waits for the next tick. The summary reports `cutShortPhases` and `skippedPhases`, status `partial`; the heartbeat records `partial`. | `automation-tick-lock.test.ts`, `video-generation.test.ts`   |
| A video job polls a slow provider                      | One tick polls a job at most `TICK_VIDEO_MAX_POLLS` (5) times, then resumes it next tick. The job's lease is **renewed before every poll and before storing**.                                                                                                                                                                                                                                               | `video-generation.test.ts` ("renews its lease…")             |
| A video runner loses its lease while still running     | Every attempt and job write is conditional on the state the runner read. A runner whose lease was taken over stops (`lease_lost`) and everything it was writing is rolled back: the clip is captured (charged) **once**, stored once. Before Pass 7, such a runner charged the workspace a second time.                                                                                                      | `video-generation.test.ts` ("…never charges twice")          |
| A reply's answer arrives after the stuck-send recovery | The late answer changes nothing: reply and interaction both stay UNCERTAIN (looked up on the Page), the auto-reply claim is kept. Before Pass 7 the interaction was overwritten (REPLIED or FAILED, and a FAILED released the claim) while the reply said UNCERTAIN.                                                                                                                                         | `social-manager.test.ts` ("…after the stuck-send recovery…") |
| A social step fails as a whole                         | Reported as a failed phase `social.<step>` (alert, heartbeat `failed`), no longer swallowed.                                                                                                                                                                                                                                                                                                                 | `automation-tick-lock.test.ts`                               |
| Outcome unknown (timeout after the request was sent)   | Unchanged and still never re-sent blindly: WhatsApp, replies, posts and video submissions go to UNCERTAIN / OUTCOME_UNKNOWN and are reconciled; EXTERNAL and SPEND agent tasks become `outcome_unknown`.                                                                                                                                                                                                     | existing suites                                              |

Known residual (low): a content-planning task that times out (120 s) may be retried
after a 30 s backoff while its AI call is still finishing. That call is bounded by its own
`AI_TIMEOUT_MS` (≤ 120 s), so in practice it has ended before the retry starts; the
signal is not yet passed into the AI call itself.

## 2. What the operator can see

`GET /api/internal/ops-status` (bearer `OPS_STATUS_SECRET`; 404 without it; 60 calls per
10 minutes, then 429 — tested) returns check names with counts or ages only: no ids,
names, page ids, content or error text (tested). 503 when anything is critical.

New in Pass 7:

| Check                                      | Level    | Meaning                                                                              |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `automation_tick_last_run_partial`         | warning  | the last tick stopped at its time budget with work left                              |
| `automation_tick_running_seconds`          | warning  | a tick started more than 10 minutes ago and has not finished (hung)                  |
| `video_retention_last_success_age_seconds` | warning  | the daily retention job has not succeeded for 48 h (or never)                        |
| `video_jobs_overdue`                       | critical | a video job still active more than 1 h past its wall-time deadline                   |
| `video_jobs_needs_reconciliation`          | warning  | a video submission's outcome is unknown and waits for an operator (reservation held) |
| `video_attempts_failed_24h`                | warning  | ≥ 5 failed or timed-out video attempts in 24 h (provider problem)                    |
| `agent_tasks_lease_expired`                | critical | an agent task still RUNNING 15 min after its lease ended (recovery is not running)   |
| `insights_sources_lease_expired`           | warning  | an Insights source still held 15 min after its lease ended                           |
| `insights_sync_runs_failed_24h`            | warning  | ≥ 3 failed or abandoned Insights runs in 24 h                                        |
| `insights_sync_runs_partial_24h`           | warning  | ≥ 3 partly read Insights runs in 24 h                                                |
| `insights_sources_failing`                 | warning  | an enabled source failed 3 times in a row (reconnect or permissions)                 |

Existing checks (tick success age and failure, stuck holds, sends and publishes, uncertain
outcomes, AI failures, credit-ledger integrity) are unchanged. Every non-ok check is also
alerted by the tick (`ops:<check>`).

**Alert delivery:** a delivery that fails (non-2xx, timeout, network) now gives its
throttle slot back, so the next occurrence is delivered instead of being swallowed for 30
minutes (unit- and integration-tested, including a slot claimed meanwhile by another
process, which is left alone). Delivery is still not retried within the same occurrence,
and a stopped scheduler raises no alert by itself: an **external uptime monitor polling
ops-status (and `/api/health?scope=readiness`) is a launch requirement** — the
monitor service itself is not configured (no account).

## 3. Restore: what "verified" means

`db-restore.sh` already refuses a dump whose checksum does not match, a target whose name
is not confirmed, and a non-empty target, and restores in one transaction. Pass 7 adds to
`db-verify.sh`:

- **The row-count manifest is required** and its own checksum
  (`<backup>.counts.tsv.sha256`, now written by `db-backup.sh`) must match; skipping it
  takes an explicit `--no-row-counts`. An edited or swapped manifest fails.
- **`sql/restore-checks.sql`** (all must be 0): invalid or unready indexes, negative credit
  balances or ledger balances, holds whose settlement time does not match their status,
  video jobs whose reserved/captured/released totals differ from their usage ledger or
  exceed the reservation.
- **Schema objects**: every index and every CHECK / FOREIGN KEY / UNIQUE / EXCLUDE
  constraint of the migrated schema must be present, and no other
  (`sql/schema-objects.sql` against `sql/expected-schema-objects.tsv`, names only). A
  dropped unique index (a duplicate-charge guard) or a hand-made constraint fails.

These run next to the existing `integrity.sql` checks and the strict migration check.

**After adding a migration**, regenerate the expected list from a freshly migrated
disposable database (the integration test `ops-restore-checks.test.ts` fails until you do):

```sh
DATABASE_URL=<disposable database> pnpm exec prisma migrate deploy
SCHEMA_DATABASE_URL=<same database> scripts/ops/db-schema-objects.sh \
  > scripts/ops/sql/expected-schema-objects.tsv
```

### 3.1 Local drill (2026-10-18) — local only

Disposable PostgreSQL 16 databases on the development container (never a real
environment). Source: all 35 migrations plus the development seed (48 rows in 5
tables — a small data set; the financial checks were exercised on service-made data
in `ops-restore-checks.test.ts` instead).

| Step                                                              | Result                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Backup                                                            | dump + `.sha256`, manifest + `.sha256` (66 tables)                      |
| Restore with a wrong `--confirm-target` / into a non-empty target | REFUSED (exit 2), nothing restored                                      |
| Restore of a dump with one byte appended                          | REFUSED: checksum mismatch                                              |
| Restore                                                           | RESTORED, 66 tables                                                     |
| Verify without a manifest                                         | REFUSED (exit 2)                                                        |
| Verify                                                            | VERIFIED: counts match, all checks 0, 419 schema objects, 35 migrations |
| Verify with an edited manifest                                    | FAILED: manifest checksum mismatch                                      |
| Drop a unique index and disable a ledger guard trigger, verify    | FAILED: `schema_objects` 1 missing, ledger guard trigger reported       |

**Not proven:** a restore of production-sized data, of a managed provider's backup or
PITR, and any RTO/RPO figure. Those need the hosting decision (register § 6) and a staging
drill (register § 5.1).
