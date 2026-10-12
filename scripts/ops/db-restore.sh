#!/usr/bin/env bash
# Restores a db-backup.sh dump into an EMPTY database (runbook: docs/runbooks/BACKUP_RESTORE.md).
#
#   RESTORE_DATABASE_URL=postgresql://…/flexibx_restore \
#     scripts/ops/db-restore.sh /secure/backups/flexibx-….dump --confirm-target flexibx_restore
#
# Safety: refuses unless the dump matches its .sha256 file, --confirm-target repeats the
# target database's name exactly, and the target has no tables in the public schema (it can
# never overwrite a live database). Runs in one transaction: a failure leaves it empty.
# Then run scripts/ops/db-verify.sh against the target.
set -euo pipefail

url="${RESTORE_DATABASE_URL:?set RESTORE_DATABASE_URL to the EMPTY target database}"
dump="${1:?usage: db-restore.sh <file.dump> --confirm-target <database name>}"
[[ "${2:-}" == "--confirm-target" && -n "${3:-}" ]] || {
  echo '{"status":"REFUSED","why":"--confirm-target <database name> is required"}' >&2; exit 2; }
confirm="$3"

refuse() { printf '{"status":"REFUSED","why":"%s"}\n' "$1" >&2; exit 2; }

[[ -f "$dump" && -f "$dump.sha256" ]] || refuse "dump or its .sha256 file is missing"
[[ "$(sha256sum "$dump" | cut -d' ' -f1)" == "$(cat "$dump.sha256")" ]] || refuse "checksum mismatch"

q() { psql --dbname="$url" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
name="$(q 'SELECT current_database()')"
[[ "$name" == "$confirm" ]] || refuse "--confirm-target does not match the target database name"
tables="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[[ "$tables" == "0" ]] || refuse "target database is not empty"

pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$url" "$dump"
printf '{"status":"RESTORED","database":"%s","tables":%s}\n' "$name" \
  "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
