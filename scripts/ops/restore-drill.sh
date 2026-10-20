#!/usr/bin/env bash
# Restore drill on DISPOSABLE databases (runbook: docs/runbooks/OPERATIONAL_RELIABILITY.md § 3.2).
# Proves, with the real scripts, that a backup can be verified and restored — and that the
# verification FAILS when it should. Used by CI and by hand on a throwaway server only.
#
#   DRILL_ADMIN_URL=postgresql://user@localhost:5432/postgres scripts/ops/restore-drill.sh
#
# DRILL_ADMIN_URL: a role that may CREATE/DROP databases, on a server that holds nothing of
# value. The drill only ever creates and drops databases named flexibx_drill_* (dropped
# again at the end, also on failure), and refuses a server that is not local unless
# DRILL_ALLOW_REMOTE=yes. Never point it at production.
#
# Steps (each must turn out as expected, or the drill exits 1):
#   1. migrate and seed flexibx_drill_src; back it up (db-backup.sh)
#   2. restore into an empty database and verify (db-verify.sh): VERIFIED
#   3. a restore over a non-empty database is refused — also one holding only an unrelated
#      table (nothing would collide), refused before any change
#   4. a tampered row-count manifest fails verification (checksum), and so does a re-signed
#      manifest with the wrong counts (row counts)
#   5. a tampered dump is refused before anything is restored; the target stays empty
#   6. an index dropped after the restore fails verification (schema objects)
#   7. a guard trigger disabled in the SOURCE survives backup and restore and fails
#      verification (integrity.sql guard_triggers_inactive)
#   8. a missing manifest, or a manifest without its checksum, fails verification
#   9. a restore without --confirm-target, or naming another database, is refused
#  10. a cut-off dump (with a checksum matching it) fails to restore and leaves nothing;
#      the full dump then restores and verifies
#  11. a backup that fails (unreachable database) leaves no partial file behind
#  12. a restored copy carries no environment marker: refused as "staging" until it is
#      marked on purpose (db-environment.sh), then accepted (Pass 16)
#  13. backup files are private: directory 700, files 600 (Pass 17)
#  14. a backup interrupted while pg_dump runs (SIGTERM to its process group, as by Ctrl-C
#      or a stopped container) fails and leaves no partial file
#  15. a restore whose database connection is cut late — every table and row already
#      written, indexes being built — fails and leaves the target empty (one transaction);
#      the same restore then succeeds into the same target
#  16. the restored copy equals the source: schema (tables, indexes, constraints, triggers
#      and their enabled state), and the audit log row for row
#  17. nothing else was touched: the source still matches its manifest, and an unrelated
#      database on the same server is unchanged
# Prints step names, results and check names only: no URL, password or row data.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
: "${DRILL_ADMIN_URL:?set DRILL_ADMIN_URL to an admin connection on a disposable server}"

failures=0
expect() { # expect <description> <expected: ok|fail> <actual exit code>
  local ok=0
  if [[ "$2" == ok && "$3" -eq 0 ]] || [[ "$2" == fail && "$3" -ne 0 ]]; then ok=1; fi
  if [[ $ok -eq 1 ]]; then echo "PASS  $1"; else
    echo "FAIL  $1 (exit $3, expected $2)"
    failures=$((failures + 1))
  fi
}

# URLs of the drill databases, built from the admin URL (never printed).
url_for() { # url_for <database> | url_for :host
  FLEXIBX_DRILL_URL="$DRILL_ADMIN_URL" FLEXIBX_DRILL_TARGET="$1" node -e '
    const u = new URL(process.env.FLEXIBX_DRILL_URL);
    const target = process.env.FLEXIBX_DRILL_TARGET;
    if (target === ":host") { console.log(u.hostname); process.exit(0); }
    u.pathname = "/" + target;
    console.log(u.toString());'
}
host="$(url_for :host)" || exit 2
if [[ "$host" != localhost && "$host" != 127.0.0.1 && "$host" != "::1" && "${DRILL_ALLOW_REMOTE:-}" != yes ]]; then
  echo '{"status":"REFUSED","why":"not a local server (set DRILL_ALLOW_REMOTE=yes for a disposable remote one)"}' >&2
  exit 2
fi

DBS=(flexibx_drill_src flexibx_drill_restore flexibx_drill_refused flexibx_drill_guard flexibx_drill_cut
  flexibx_drill_net flexibx_drill_bystander)
work="$(mktemp -d)"
chmod 700 "$work"
admin() { # admin <sql>: one statement on the maintenance database
  (
    export FLEXIBX_DRILL_ADMIN="$DRILL_ADMIN_URL"
    # shellcheck source=lib/pgenv.sh
    source "$here/lib/pgenv.sh"
    pg_use_url FLEXIBX_DRILL_ADMIN
    psql -X -q -At -v ON_ERROR_STOP=1 -c "$1"
  )
}
on() { # on <database> <sql>
  (
    export FLEXIBX_DRILL_DB
    FLEXIBX_DRILL_DB="$(url_for "$1")"
    # shellcheck source=lib/pgenv.sh
    source "$here/lib/pgenv.sh"
    pg_use_url FLEXIBX_DRILL_DB
    psql -X -q -At -v ON_ERROR_STOP=1 -c "$2"
  )
}
onf() { # onf <database> <file>: a SQL file (psql meta-commands allowed)
  (
    export FLEXIBX_DRILL_DB
    FLEXIBX_DRILL_DB="$(url_for "$1")"
    # shellcheck source=lib/pgenv.sh
    source "$here/lib/pgenv.sh"
    pg_use_url FLEXIBX_DRILL_DB
    psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$2"
  )
}
schema_of() { # schema_of <database>: schema-only dump, without pg_dump's per-run token lines
  (
    export FLEXIBX_DRILL_DB
    FLEXIBX_DRILL_DB="$(url_for "$1")"
    # shellcheck source=lib/pgenv.sh
    source "$here/lib/pgenv.sh"
    pg_use_url FLEXIBX_DRILL_DB
    pg_dump --schema-only --no-owner --no-privileges | grep -v -e '^\\restrict ' -e '^\\unrestrict ' -e '^--'
  )
}
wait_for() { # wait_for <database> <condition on pg_stat_activity>: up to 30 s
  local i
  for i in $(seq 1 300); do
    [[ "$(admin "SELECT count(*) FROM pg_stat_activity WHERE datname = '$1' AND $2")" -gt 0 ]] && return 0
    sleep 0.1
  done
  return 1
}
fresh() { admin "DROP DATABASE IF EXISTS $1 WITH (FORCE)" && admin "CREATE DATABASE $1"; }
cleanup() {
  for db in "${DBS[@]}"; do admin "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1; done
  rm -rf -- "$work"
}
trap cleanup EXIT

echo "== 1. source: migrate, seed, back up"
# An unrelated database on the same server: nothing in the drill may change it (step 17).
fresh flexibx_drill_bystander || exit 2
on flexibx_drill_bystander "CREATE TABLE sentinel (v text); INSERT INTO sentinel VALUES ('untouched')" >/dev/null
fresh flexibx_drill_src || exit 2
(cd "$root" && DATABASE_URL="$(url_for flexibx_drill_src)" pnpm exec prisma migrate deploy >/dev/null 2>&1)
expect "migrations applied to the source" ok $?
(cd "$root" && DATABASE_URL="$(url_for flexibx_drill_src)" NODE_ENV=development pnpm exec tsx prisma/seed.ts >/dev/null 2>&1)
expect "seed data written" ok $?
BACKUP_DATABASE_URL="$(url_for flexibx_drill_src)" "$here/db-backup.sh" "$work/clean" >/dev/null
expect "backup written" ok $?
dump="$(ls "$work"/clean/*.dump)"
manifest="$(ls "$work"/clean/*.counts.tsv)"

echo "== 2. restore into an empty database and verify"
fresh flexibx_drill_restore || exit 2
RESTORE_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-restore.sh" "$dump" \
  --confirm-target flexibx_drill_restore >/dev/null 2>&1
expect "restore into an empty database" ok $?
VERIFY_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-verify.sh" "$manifest" >"$work/verify.log" 2>&1
expect "verification of the clean restore (VERIFIED)" ok $?

echo "== 3. restore over a non-empty database"
RESTORE_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-restore.sh" "$dump" \
  --confirm-target flexibx_drill_restore >/dev/null 2>&1
expect "restore over a non-empty database is refused" fail $?
# The dangerous case: a target whose tables do not collide with the dump's (pg_restore
# itself would not fail; the data would be mixed in). Refused before any change: exit 2.
fresh flexibx_drill_refused || exit 2
on flexibx_drill_refused "CREATE TABLE unrelated (v text)" >/dev/null
RESTORE_DATABASE_URL="$(url_for flexibx_drill_refused)" "$here/db-restore.sh" "$dump" \
  --confirm-target flexibx_drill_refused >/dev/null 2>&1
[[ $? -eq 2 ]]
expect "restore into a database holding another table is refused (exit 2)" ok $?

echo "== 4. tampered manifest"
cp "$manifest" "$work/tampered.counts.tsv"
cp "$manifest.sha256" "$work/tampered.counts.tsv.sha256"
awk -F'\t' 'BEGIN { OFS = "\t" } !done && $2 ~ /^[0-9]+$/ { $2 = $2 + 1; done = 1 } { print }' \
  "$manifest" >"$work/tampered.counts.tsv"
VERIFY_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-verify.sh" "$work/tampered.counts.tsv" \
  >"$work/verify-manifest.log" 2>&1
expect "verification with a tampered manifest fails" fail $?
# A manifest whose checksum is valid but whose counts are not this backup's (e.g. another
# backup's manifest): only the row-count comparison itself can catch it.
sha256sum "$work/tampered.counts.tsv" | cut -d' ' -f1 >"$work/tampered.counts.tsv.sha256"
VERIFY_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-verify.sh" "$work/tampered.counts.tsv" \
  >"$work/verify-resigned.log" 2>&1
expect "verification with a re-signed wrong manifest fails" fail $?
grep -q $'^row_counts\tMISMATCH' "$work/verify-resigned.log"
expect "…on the row counts" ok $?

echo "== 5. tampered dump"
cp "$dump" "$work/tampered.dump"
sed "s#$(basename "$dump")#tampered.dump#" "$dump.sha256" >"$work/tampered.dump.sha256"
printf 'x' >>"$work/tampered.dump"
fresh flexibx_drill_refused || exit 2
RESTORE_DATABASE_URL="$(url_for flexibx_drill_refused)" "$here/db-restore.sh" "$work/tampered.dump" \
  --confirm-target flexibx_drill_refused >/dev/null 2>&1
expect "restore of a tampered dump is refused" fail $?
tables="$(on flexibx_drill_refused "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[[ "$tables" == 0 ]]
expect "the refused restore left the target empty" ok $?

echo "== 6. index dropped after the restore"
on flexibx_drill_restore "DROP INDEX creator_storage_deletions_completed_at_next_attempt_at_idx" >/dev/null
VERIFY_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-verify.sh" "$manifest" >"$work/verify-index.log" 2>&1
expect "verification with a missing index fails" fail $?

echo "== 7. guard trigger disabled in the source"
on flexibx_drill_src "ALTER TABLE creator_jobs DISABLE TRIGGER creator_jobs_project_active" >/dev/null
BACKUP_DATABASE_URL="$(url_for flexibx_drill_src)" "$here/db-backup.sh" "$work/guard" >/dev/null
expect "backup with the guard switched off" ok $?
fresh flexibx_drill_guard || exit 2
RESTORE_DATABASE_URL="$(url_for flexibx_drill_guard)" "$here/db-restore.sh" "$(ls "$work"/guard/*.dump)" \
  --confirm-target flexibx_drill_guard >/dev/null 2>&1
expect "restore of that backup" ok $?
VERIFY_DATABASE_URL="$(url_for flexibx_drill_guard)" "$here/db-verify.sh" "$(ls "$work"/guard/*.counts.tsv)" \
  >"$work/verify-guard.log" 2>&1
expect "verification of a restore without the guard fails" fail $?
grep -q $'^guard_triggers_inactive\t1$' "$work/verify-guard.log"
expect "…and names guard_triggers_inactive" ok $?
on flexibx_drill_src "ALTER TABLE creator_jobs ENABLE TRIGGER creator_jobs_project_active" >/dev/null

echo "== 8. missing manifest or manifest checksum"
VERIFY_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-verify.sh" "$work/absent.counts.tsv" \
  >"$work/verify-absent.log" 2>&1
expect "verification without the manifest fails" fail $?
cp "$manifest" "$work/unsigned.counts.tsv"
VERIFY_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-verify.sh" "$work/unsigned.counts.tsv" \
  >"$work/verify-unsigned.log" 2>&1
expect "verification of a manifest without its checksum fails" fail $?

echo "== 9. restore confirmation"
fresh flexibx_drill_cut || exit 2
RESTORE_DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-restore.sh" "$dump" >/dev/null 2>&1
expect "restore without --confirm-target is refused" fail $?
RESTORE_DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-restore.sh" "$dump" \
  --confirm-target flexibx_drill_restore >/dev/null 2>&1
expect "restore naming another database is refused" fail $?

echo "== 10. restore that fails part-way"
# A dump cut off (as by an interrupted copy), with a checksum that matches it, so only
# pg_restore itself can notice. Where the cut lands decides how early it fails; the
# rollback of a restore that fails late is step 15.
head -c "$(($(stat -c%s "$dump") * 2 / 3))" "$dump" >"$work/cut.dump"
sha256sum "$work/cut.dump" | cut -d' ' -f1 >"$work/cut.dump.sha256"
RESTORE_DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-restore.sh" "$work/cut.dump" \
  --confirm-target flexibx_drill_cut >/dev/null 2>&1
expect "restore of a cut-off dump fails" fail $?
tables="$(on flexibx_drill_cut "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[[ "$tables" == 0 ]]
expect "…and left the target empty" ok $?
RESTORE_DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-restore.sh" "$dump" \
  --confirm-target flexibx_drill_cut >/dev/null 2>&1
expect "the full dump then restores into the same target" ok $?
VERIFY_DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-verify.sh" "$manifest" >"$work/verify-cut.log" 2>&1
expect "…and verifies" ok $?

echo "== 11. failed backup leaves nothing behind"
BACKUP_DATABASE_URL="$(url_for flexibx_drill_absent_database)" "$here/db-backup.sh" "$work/failed" \
  >/dev/null 2>&1
expect "backup of a database that does not exist fails" fail $?
[[ -z "$(ls -A "$work/failed" 2>/dev/null)" ]]
expect "…and left no partial file" ok $?

echo "== 12. environment marker on a restored copy"
DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-environment.sh" assert staging >/dev/null 2>&1
expect "a restored copy is not accepted as staging" fail $?
DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-environment.sh" mark staging \
  --confirm-database flexibx_drill_cut >/dev/null 2>&1
expect "it is marked on purpose (name repeated)" ok $?
DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-environment.sh" assert staging >/dev/null 2>&1
expect "…and then accepted" ok $?
DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-environment.sh" assert production >/dev/null 2>&1
expect "…but never as another environment" fail $?

echo "== 13. backup files are private"
[[ "$(stat -c %a "$work/clean")" == 700 ]]
expect "backup directory mode 700" ok $?
[[ -z "$(find "$work/clean" -type f ! -perm 600)" && -n "$(ls -A "$work/clean")" ]]
expect "every backup file mode 600" ok $?

echo "== 14. backup interrupted while pg_dump runs"
# A session holding an exclusive lock on one table keeps pg_dump waiting mid-run; the
# backup's process group is then stopped as Ctrl-C or `docker stop` would stop it.
on flexibx_drill_src "BEGIN; LOCK TABLE audit_logs IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60)" \
  >/dev/null 2>&1 &
holder=$!
wait_for flexibx_drill_src "query LIKE 'BEGIN; LOCK TABLE audit_logs%'" || echo "lock holder did not start"
BACKUP_DATABASE_URL="$(url_for flexibx_drill_src)" setsid "$here/db-backup.sh" "$work/interrupted" \
  >/dev/null 2>&1 &
backup=$!
wait_for flexibx_drill_src "application_name = 'pg_dump' AND wait_event_type = 'Lock'"
expect "pg_dump started and is waiting mid-backup" ok $?
kill -TERM -- "-$(ps -o pgid= "$backup" | tr -d ' ')" 2>/dev/null
wait "$backup"
expect "the interrupted backup fails" fail $?
admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'flexibx_drill_src' AND pid <> pg_backend_pid()" >/dev/null
wait "$holder" 2>/dev/null
[[ -z "$(ls -A "$work/interrupted" 2>/dev/null)" ]]
expect "…and left no partial file" ok $?

echo "== 15. connection cut late in a restore"
# An uncommitted relation named like one of the dump's indexes makes pg_restore wait when it
# reaches that index — after every table and row is written (post-data). Its connection is
# then terminated, as a network or server loss would. Only the single transaction can leave
# the target empty now.
fresh flexibx_drill_net || exit 2
late_index=creator_storage_deletions_completed_at_next_attempt_at_idx
on flexibx_drill_net "BEGIN; CREATE SEQUENCE public.$late_index; SELECT pg_sleep(60)" >/dev/null 2>&1 &
holder=$!
wait_for flexibx_drill_net "query LIKE 'BEGIN; CREATE SEQUENCE%'" || echo "blocking session did not start"
RESTORE_DATABASE_URL="$(url_for flexibx_drill_net)" "$here/db-restore.sh" "$dump" \
  --confirm-target flexibx_drill_net >/dev/null 2>&1 &
restore=$!
wait_for flexibx_drill_net "application_name = 'pg_restore' AND wait_event_type = 'Lock'"
expect "pg_restore has written the tables and data and waits at an index" ok $?
admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'flexibx_drill_net' AND application_name = 'pg_restore'" >/dev/null
wait "$restore"
expect "the cut-off restore fails" fail $?
admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'flexibx_drill_net' AND pid <> pg_backend_pid()" >/dev/null
wait "$holder" 2>/dev/null
tables="$(on flexibx_drill_net "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[[ "$tables" == 0 ]]
expect "…and left the target empty" ok $?
RESTORE_DATABASE_URL="$(url_for flexibx_drill_net)" "$here/db-restore.sh" "$dump" \
  --confirm-target flexibx_drill_net >/dev/null 2>&1
expect "the retry restores into the same target" ok $?
VERIFY_DATABASE_URL="$(url_for flexibx_drill_net)" "$here/db-verify.sh" "$manifest" >"$work/verify-net.log" 2>&1
expect "…and verifies" ok $?

echo "== 16. restored copy equals the source"
schema_of flexibx_drill_src >"$work/schema-src.sql" && schema_of flexibx_drill_net >"$work/schema-net.sql"
expect "schema dumps of source and copy taken" ok $?
# A dump and restore re-prints some CHECK expressions with their casts moved (PostgreSQL
# deparses the parsed form: `ANY ((ARRAY['a'::varchar])::text[])` comes back as
# `ANY (ARRAY[('a'::varchar)::text])`, 25 of 99 constraints here) — the same constraint in
# other words. So: everything but CHECK bodies must match to the byte, and every CHECK body
# of the source, parsed again by the server inside the copy (in a transaction that is
# rolled back), must print exactly as the copy's own constraint of that name.
diff <(grep -v 'CHECK (' "$work/schema-src.sql") <(grep -v 'CHECK (' "$work/schema-net.sql") >"$work/schema.diff"
expect "same schema: tables, columns, indexes, keys, triggers and their state" ok $?
head -20 "$work/schema.diff" # DDL only (no data), when they differ
# Hex, so the definitions cross unchanged (COPY's text format would read their backslashes).
on flexibx_drill_src "SELECT conrelid::regclass::text || E'\t' || conname || E'\t' ||
  encode(convert_to(pg_get_constraintdef(oid), 'UTF8'), 'hex')
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c'" >"$work/checks-src.tsv"
cat >"$work/checks-equal.sql" <<SQL
BEGIN;
CREATE TEMP TABLE source_checks (tbl text, name text, def text);
\\copy source_checks FROM '$work/checks-src.tsv'
DO \$\$
DECLARE r record; reparsed text; restored text; differing int := 0; missing int := 0;
BEGIN
  FOR r IN SELECT tbl, name, convert_from(decode(def, 'hex'), 'UTF8') AS def FROM source_checks LOOP
    SELECT pg_get_constraintdef(oid) INTO restored FROM pg_constraint
      WHERE conrelid = r.tbl::regclass AND conname = r.name AND contype = 'c';
    IF restored IS NULL THEN missing := missing + 1; CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT drill_reparsed %s NOT VALID', r.tbl, r.def);
    SELECT pg_get_constraintdef(oid) INTO reparsed FROM pg_constraint
      WHERE conrelid = r.tbl::regclass AND conname = 'drill_reparsed';
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT drill_reparsed', r.tbl);
    IF replace(reparsed, ' NOT VALID', '') <> restored THEN differing := differing + 1; END IF;
  END LOOP;
  RAISE NOTICE 'checks %, missing %, differing %', (SELECT count(*) FROM source_checks), missing, differing;
  IF missing + differing > 0 THEN RAISE EXCEPTION 'CHECK constraints differ'; END IF;
END \$\$;
ROLLBACK;
SQL
onf flexibx_drill_net "$work/checks-equal.sql" >"$work/checks-equal.log" 2>&1
status=$? # before the label's command substitution below, which would reset $?
expect "same CHECK constraints ($(grep -o 'checks [0-9]*' "$work/checks-equal.log" | head -1), compared by the server's parser)" ok $status
grep -o 'missing [0-9]*, differing [0-9]*' "$work/checks-equal.log" | grep -v 'missing 0, differing 0' # names no data
audit_digest="SELECT count(*) || ':' || md5(coalesce(string_agg(a::text, '|' ORDER BY a.id), '')) FROM audit_logs a"
[[ "$(on flexibx_drill_src "$audit_digest")" == "$(on flexibx_drill_net "$audit_digest")" ]]
expect "same audit log, row for row" ok $?

echo "== 17. nothing else was touched"
diff <(sort "$manifest") <(onf flexibx_drill_src "$here/sql/row-counts.sql" | sort) >/dev/null
expect "the source still matches its manifest" ok $?
[[ "$(on flexibx_drill_bystander "SELECT string_agg(v, ',') FROM sentinel")" == untouched ]]
expect "an unrelated database is unchanged" ok $?

if [[ $failures -gt 0 ]]; then
  echo "{\"status\":\"DRILL FAILED\",\"failures\":$failures}"
  exit 1
fi
echo '{"status":"DRILL PASSED"}'
