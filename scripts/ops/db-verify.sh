#!/usr/bin/env bash
# Verifies a restored database (runbook: docs/runbooks/BACKUP_RESTORE.md):
#   1. row counts equal the backup's manifest (when given; exact for a backup taken while
#      writes were stopped, approximate for one taken from a live database),
#   2. integrity checks (sql/integrity.sql) all report 0,
#   3. Prisma sees every repository migration applied (`prisma migrate status`).
#
#   VERIFY_DATABASE_URL=postgresql://…/flexibx_restore scripts/ops/db-verify.sh [backup.counts.tsv]
#
# Prints counts and check names only. Exit code 0 = every check passed.
set -euo pipefail

url="${VERIFY_DATABASE_URL:?set VERIFY_DATABASE_URL to the restored database}"
counts="${1:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
failed=0

if [[ -n "$counts" ]]; then
  actual="$(psql --dbname="$url" -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/row-counts.sql")"
  if diff <(sort "$counts") <(sort <<<"$actual") >/dev/null; then
    echo "row_counts	match ($(wc -l < "$counts") tables)"
  else
    echo "row_counts	MISMATCH"
    diff <(sort "$counts") <(sort <<<"$actual") | sed 's/^/  /' || true
    failed=1
  fi
fi

while IFS=$'\t' read -r check value; do
  [[ -z "$check" ]] && continue
  echo "$check	$value"
  [[ "$value" == "0" ]] || failed=1
done < <(psql --dbname="$url" -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/integrity.sql")

if (cd "$repo" && DATABASE_URL="$url" pnpm exec prisma migrate status >/dev/null 2>&1); then
  echo "prisma_migrate_status	up to date"
else
  echo "prisma_migrate_status	NOT up to date (pending, failed or unknown migrations)"
  failed=1
fi

if [[ "$failed" == "0" ]]; then echo '{"status":"VERIFIED"}'; else echo '{"status":"FAILED"}'; exit 1; fi
