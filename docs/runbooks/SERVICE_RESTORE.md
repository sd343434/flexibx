# Service restore runbook (staging stack)

Pass 16. How to bring the Flexibx staging service back on a restored database and prove
it is serving correctly before traffic returns. The database steps themselves (backup
files, `db-restore.sh`, `db-verify.sh`) are in BACKUP_RESTORE.md; this runbook covers the
order of the whole service around them. Production has its own approval path
(DEPLOYMENT.md, INCIDENT_RESPONSE.md): nothing here is run against production.

**Status:** every step below exists as a script or a compose job and has been exercised
locally (Docker host + local PostgreSQL 16, `restore-drill.sh` steps 1–12). PITR on RDS
and the hosted stack have **never** been exercised: no hosted environment exists yet
(RELEASE_READINESS_DECISIONS.md).

## 0. Rules

- Restore into a **new, empty** database. Never over the database that failed — it is the
  evidence, and `db-restore.sh` refuses a non-empty target anyway.
- A restored database is **unmarked** (pg_dump and an RDS point-in-time copy do not carry
  `COMMENT ON DATABASE`). The migrate job and the staging gate refuse it until it is marked
  on purpose. Never remove the `db-environment.sh assert` from the migrate job to get
  past this.
- Social sending and the scheduler stay off until § 5 passes.
- Write down the times of every step (incident record): they are the measured RTO.

## 1. Contain (≈ 2 min)

```bash
cd /opt/flexibx   # the host checkout of deploy/staging
export FLEXIBX_TAG=<the release tag that was running>
docker compose -f deploy/staging/compose.yaml stop scheduler worker app
```

Stopping the worker hands its job back (SIGTERM); a job that was mid-way keeps its
lease and is reclaimed after the lease expires (2 min) — it is not charged twice
(ledger holds are released or settled once; tested). Set `SOCIAL_SENDING_ENABLED=false`
in `staging.env` if it was on.

## 2. Pick the recovery point

| Source                         | Recovery point                | How                     |
| ------------------------------ | ----------------------------- | ----------------------- |
| RDS point-in-time (if applied) | any second inside retention   | § 3a                    |
| Daily `db-backup.sh` set       | time of the last good backup  | § 3b                    |
| Older backup set               | when the newest set fails § 4 | § 3b with the older set |

Record the chosen point. Data written after it is lost (the RPO actually suffered).

## 3a. Point-in-time restore on RDS (configured in Terraform, never exercised)

The console or CLI restores to a **new instance** (`aws rds restore-db-instance-to-point-in-time
--source-db-instance-identifier flexibx-staging --target-db-instance-identifier
flexibx-staging-r<UTC> --restore-time <ISO8601> …`), into the same subnet group and
security group as the original (outputs of `deploy/staging/aws`). It is a paid resource
for as long as it exists: the owner approves it. Then the URL of the new instance is the
`<restored-url>` below. The database name is the same as the source's.

## 3b. Restore from a backup set

```bash
# on a machine that can reach the database server; the set is copied from off-host storage
createdb … flexibx_staging_r<UTC>        # empty, PostgreSQL 16
RESTORE_DATABASE_URL='<restored-url>' \
  scripts/ops/db-restore.sh /secure/restore/flexibx-<UTC>.dump \
  --confirm-target flexibx_staging_r<UTC>
```

Exit 2 = refused, nothing written. Exit 1 = `FAILED`: the single transaction rolled
back (drill step 10: a cut-off dump leaves the target with zero tables, and the full
dump then restores into the same target). Do not edit a `.sha256` to make a set pass;
take the previous set.

## 4. Verify the data (≈ seconds per GB)

```bash
VERIFY_DATABASE_URL='<restored-url>' \
  scripts/ops/db-verify.sh /secure/restore/flexibx-<UTC>.counts.tsv
```

Must print `VERIFIED`. A missing manifest, or a manifest without its `.sha256`, is a
failure, not a skip (drill step 8). After PITR there is no manifest: run
`VERIFY_DATABASE_URL='<restored-url>' scripts/ops/db-verify.sh --no-row-counts` — every
other check (integrity, schema objects, migrations) still runs and must pass.

## 5. Mark, migrate, start, gate

```bash
# 5.1 mark the restored database as staging — the name is typed twice on purpose
DATABASE_URL='<restored-url>' scripts/ops/db-environment.sh mark staging \
  --confirm-database flexibx_staging_r<UTC>
# 5.2 point staging at it: DATABASE_URL in staging.env (or the SSM parameter), then
docker compose -f deploy/staging/compose.yaml run --rm migrate   # forward only; refuses if unmarked
docker compose -f deploy/staging/compose.yaml up -d app worker
docker compose -f deploy/staging/compose.yaml run --rm check      # must say PASSED
docker compose -f deploy/staging/compose.yaml up -d scheduler
```

The `check` job is the release gate (PASS / FAIL / NOT_RUN, exit 0 / 1 / 2); it
re-asserts the marker, re-runs `db-verify`, the storage preflight, `/api/health`,
`/api/internal/ops-status` and sends a test alert. NOT_RUN is not a pass.

## 6. Verify the service

1. `ops-status` stays `ok` across at least two scheduler ticks (no `429`, no stale
   worker, no lease overdue). A job left running at the recovery point shows as lease
   expired, is reclaimed by the worker and finishes — or fails with its hold released.
2. Sign in as an operator (password + second factor); open one workspace; its credit
   balance and the last audit entries match the recovery point.
3. Media: files uploaded after the recovery point exist in the bucket without a row
   (harmless; removed by retention). Rows whose object is missing (bucket restored to an
   older version) fail on download — list them per BACKUP_RESTORE.md § 4 step 6.
4. Re-enable social sending if it was on.

## 7. Afterwards

- Keep the failed database (renamed, scaled down) until the incident is closed; then the
  owner deletes it.
- Take a fresh `backup` job run on the restored database and copy it off the host.
- Record: incident start, recovery point, the time each step finished, and the data
  window lost. Those are the measured RTO / RPO; § 8–9 of BACKUP_RESTORE.md are
  estimates until this happens on the hosted stack.
