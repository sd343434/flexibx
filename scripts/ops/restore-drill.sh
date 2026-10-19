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
#   3. a restore over a non-empty database is refused
#   4. a tampered row-count manifest fails verification (checksum)
#   5. a tampered dump is refused before anything is restored; the target stays empty
#   6. an index dropped after the restore fails verification (schema objects)
#   7. a guard trigger disabled in the SOURCE survives backup and restore and fails
#      verification (integrity.sql guard_triggers_inactive)
#   8. a missing manifest, or a manifest without its checksum, fails verification
#   9. a restore without --confirm-target, or naming another database, is refused
#  10. a restore that fails part-way (a cut-off dump) rolls back completely: the target
#      stays empty, and the full dump then restores and verifies
#  11. a backup that fails (unreachable database) leaves no partial file behind
#  12. a restored copy carries no environment marker: refused as "staging" until it is
#      marked on purpose (db-environment.sh), then accepted (Pass 16)
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

DBS=(flexibx_drill_src flexibx_drill_restore flexibx_drill_refused flexibx_drill_guard flexibx_drill_cut)
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
fresh() { admin "DROP DATABASE IF EXISTS $1 WITH (FORCE)" && admin "CREATE DATABASE $1"; }
cleanup() {
  for db in "${DBS[@]}"; do admin "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1; done
  rm -rf -- "$work"
}
trap cleanup EXIT

echo "== 1. source: migrate, seed, back up"
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

echo "== 4. tampered manifest"
cp "$manifest" "$work/tampered.counts.tsv"
cp "$manifest.sha256" "$work/tampered.counts.tsv.sha256"
awk -F'\t' 'BEGIN { OFS = "\t" } !done && $2 ~ /^[0-9]+$/ { $2 = $2 + 1; done = 1 } { print }' \
  "$manifest" >"$work/tampered.counts.tsv"
VERIFY_DATABASE_URL="$(url_for flexibx_drill_restore)" "$here/db-verify.sh" "$work/tampered.counts.tsv" \
  >"$work/verify-manifest.log" 2>&1
expect "verification with a tampered manifest fails" fail $?

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
# A dump cut off after its table of contents (as by an interrupted copy), with a checksum
# that matches it, so only pg_restore itself can notice: it must roll everything back.
head -c "$(($(stat -c%s "$dump") * 2 / 3))" "$dump" >"$work/cut.dump"
sha256sum "$work/cut.dump" | cut -d' ' -f1 >"$work/cut.dump.sha256"
RESTORE_DATABASE_URL="$(url_for flexibx_drill_cut)" "$here/db-restore.sh" "$work/cut.dump" \
  --confirm-target flexibx_drill_cut >/dev/null 2>&1
expect "restore of a cut-off dump fails" fail $?
tables="$(on flexibx_drill_cut "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[[ "$tables" == 0 ]]
expect "…and left the target empty (single transaction)" ok $?
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

if [[ $failures -gt 0 ]]; then
  echo "{\"status\":\"DRILL FAILED\",\"failures\":$failures}"
  exit 1
fi
echo '{"status":"DRILL PASSED"}'
