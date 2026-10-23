#!/usr/bin/env bash
# Logical backup of the Flexibx PostgreSQL database (runbook: docs/runbooks/BACKUP_RESTORE.md).
#
#   BACKUP_DATABASE_URL=postgresql://… scripts/ops/db-backup.sh /secure/backups/dir
#
# Writes, into a directory OUTSIDE the repository (refused otherwise, so a dump can never
# be committed), readable by the current user only:
#   flexibx-<UTC timestamp>.dump         pg_dump custom format (compressed)
#   flexibx-<UTC timestamp>.dump.sha256  SHA-256 of the dump (checked before any restore)
#   flexibx-<UTC timestamp>.counts.tsv   exact row count per table (compared after restore),
#                                        taken from the SAME snapshot as the dump (Pass 37:
#                                        counted afterwards, a database in use never matched)
#   flexibx-<UTC timestamp>.counts.tsv.sha256  SHA-256 of the manifest (checked by db-verify.sh)
# Prints one JSON line (path, size, hash). Never prints the connection string or data.
# The URL never reaches a command line (lib/pgenv.sh): its parts go to libpq environment
# variables and its password to a temporary 0600 file. A password may also come from
# ~/.pgpass or PGPASSWORD when the URL has none. Needs node (to parse the URL).
set -euo pipefail

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL to the database to back up}"
out="${1:?usage: db-backup.sh <output directory outside the repository>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgenv.sh
source "$here/lib/pgenv.sh"
repo="$(cd "$here/../.." && pwd)"
target="$(realpath -m "$out")"
case "$target/" in
  "$repo"/*) echo '{"status":"REFUSED","why":"output directory is inside the repository"}' >&2; exit 2 ;;
esac

pg_use_url BACKUP_DATABASE_URL

umask 077
mkdir -p "$target"
chmod 700 "$target"
base="$target/flexibx-$(date -u +%Y%m%dT%H%M%SZ)"
# A failed or interrupted run leaves no partial dump that could be mistaken for a backup.
snap_pid=""
cleanup() {
  rm -f "$base.dump" "$base.dump.sha256" "$base.counts.tsv" "$base.counts.tsv.sha256"
  if [[ -n "$snap_pid" ]]; then kill "$snap_pid" 2>/dev/null || true; fi
}
trap 'cleanup; echo "{\"status\":\"FAILED\"}" >&2; exit 1' ERR INT TERM

# One snapshot for the dump and the row counts: a read-only REPEATABLE READ transaction
# exports it and stays open until both are taken. Rows written meanwhile are in neither.
coproc SNAP { psql -X -q -A -t -v ON_ERROR_STOP=1 2>/dev/null; }
snap_pid="$SNAP_PID"
printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&"${SNAP[1]}"
snapshot=""
IFS= read -r -t 60 snapshot <&"${SNAP[0]}" || true
[[ "$snapshot" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || false

pg_dump --format=custom --compress=6 --no-owner --no-privileges --snapshot="$snapshot" \
  --file="$base.dump"
sha256sum "$base.dump" | cut -d' ' -f1 > "$base.dump.sha256"
psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -c "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" \
  -c "SET TRANSACTION SNAPSHOT '$snapshot'" -f "$here/sql/row-counts.sql" -c "COMMIT" \
  > "$base.counts.tsv"
sha256sum "$base.counts.tsv" | cut -d' ' -f1 > "$base.counts.tsv.sha256"
printf 'COMMIT;\n' >&"${SNAP[1]}"
exec {SNAP[1]}>&-
wait "$snap_pid" || true
snap_pid=""

trap - ERR INT TERM
printf '{"status":"OK","dump":"%s","bytes":%s,"sha256":"%s","tables":%s}\n' \
  "$base.dump" "$(stat -c%s "$base.dump")" "$(cat "$base.dump.sha256")" "$(wc -l < "$base.counts.tsv")"
