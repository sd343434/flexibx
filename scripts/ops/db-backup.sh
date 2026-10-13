#!/usr/bin/env bash
# Logical backup of the Flexibx PostgreSQL database (runbook: docs/runbooks/BACKUP_RESTORE.md).
#
#   BACKUP_DATABASE_URL=postgresql://… scripts/ops/db-backup.sh /secure/backups/dir
#
# Writes, into a directory OUTSIDE the repository (refused otherwise, so a dump can never
# be committed), readable by the current user only:
#   flexibx-<UTC timestamp>.dump         pg_dump custom format (compressed)
#   flexibx-<UTC timestamp>.dump.sha256  SHA-256 of the dump (checked before any restore)
#   flexibx-<UTC timestamp>.counts.tsv   exact row count per table (compared after restore)
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
cleanup() { rm -f "$base.dump" "$base.dump.sha256" "$base.counts.tsv"; }
trap 'cleanup; echo "{\"status\":\"FAILED\"}" >&2; exit 1' ERR INT TERM

pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$base.dump"
sha256sum "$base.dump" | cut -d' ' -f1 > "$base.dump.sha256"
psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/row-counts.sql" > "$base.counts.tsv"

trap - ERR INT TERM
printf '{"status":"OK","dump":"%s","bytes":%s,"sha256":"%s","tables":%s}\n' \
  "$base.dump" "$(stat -c%s "$base.dump")" "$(cat "$base.dump.sha256")" "$(wc -l < "$base.counts.tsv")"
