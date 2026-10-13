#!/usr/bin/env bash
# Verifies a restored database (runbook: docs/runbooks/BACKUP_RESTORE.md):
#   1. row counts equal the backup's manifest (when given; exact for a backup taken while
#      writes were stopped, approximate for one taken from a live database),
#   2. integrity checks (sql/integrity.sql) all report 0,
#   3. every repository migration is applied, unchanged (same checksum Prisma recorded),
#      and the database has no unknown or unfinished migration — what `prisma migrate
#      status` checks, done in SQL: Prisma's schema engine receives the URL (password
#      included) on its command line.
#
#   VERIFY_DATABASE_URL=postgresql://…/flexibx_restore scripts/ops/db-verify.sh [backup.counts.tsv]
#
# Prints counts and check names only. Exit code 0 = every check passed. The URL never
# reaches a command line: psql gets libpq environment variables (lib/pgenv.sh).
set -euo pipefail

: "${VERIFY_DATABASE_URL:?set VERIFY_DATABASE_URL to the restored database}"
counts="${1:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
failed=0
# shellcheck source=lib/pgenv.sh
source "$here/lib/pgenv.sh"
pg_use_url VERIFY_DATABASE_URL
trap 'echo "{\"status\":\"FAILED\",\"why\":\"database error\"}"; exit 1' ERR

if [[ -n "$counts" ]]; then
  actual="$(psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/row-counts.sql")"
  if diff <(sort "$counts") <(sort <<<"$actual") >/dev/null; then
    echo "row_counts	match ($(wc -l < "$counts") tables)"
  else
    echo "row_counts	MISMATCH"
    diff <(sort "$counts") <(sort <<<"$actual") | sed 's/^/  /' || true
    failed=1
  fi
fi

# Captured first: a connection or query failure stops the script (exit 1) instead of
# reading as "no failed check".
checks="$(psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/integrity.sql")"
[[ -n "$checks" ]] || { echo "integrity_checks	NO OUTPUT"; failed=1; }
while IFS=$'\t' read -r check value; do
  [[ -z "$check" ]] && continue
  echo "$check	$value"
  [[ "$value" == "0" ]] || failed=1
done <<<"$checks"

expected="$(for file in "$repo"/prisma/migrations/*/migration.sql; do
  printf '%s\t%s\n' "$(basename "$(dirname "$file")")" "$(sha256sum "$file" | cut -d' ' -f1)"
done | sort)"
applied="$(psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -c "SELECT migration_name, checksum
  FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" | sort)"
if [[ -n "$expected" && "$expected" == "$applied" ]]; then
  echo "prisma_migrations	up to date ($(wc -l <<<"$expected") applied)"
else
  echo "prisma_migrations	NOT up to date (pending, modified or unknown migrations)"
  diff <(cut -f1 <<<"$expected") <(cut -f1 <<<"$applied") | sed -n 's/^< /  pending: /p; s/^> /  unknown: /p' || true
  failed=1
fi

if [[ "$failed" == "0" ]]; then echo '{"status":"VERIFIED"}'; else echo '{"status":"FAILED"}'; exit 1; fi
