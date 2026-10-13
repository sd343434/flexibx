#!/usr/bin/env bash
# Verifies a restored database (runbook: docs/runbooks/BACKUP_RESTORE.md):
#   1. row counts equal the backup's manifest (when given; exact for a backup taken while
#      writes were stopped, approximate for one taken from a live database),
#   2. integrity checks (sql/integrity.sql) all report 0,
#   3. migrations, checked in SQL against _prisma_migrations (Prisma itself is not run: its
#      schema engine receives the URL, password included, on its command line). This is
#      STRICTER than `prisma migrate status`, which (Prisma 7.10, tested) reports "up to
#      date" for an edited migration file and ignores migrations that exist only in the
#      database. Here every repository migration must be applied with the checksum Prisma
#      recorded (SHA-256 of its migration.sql) — line-ending-only differences (CRLF/LF
#      checkouts) are tolerated, any other byte difference fails — and the database must
#      have no migration the repository does not have. Failed or rolled-back attempts are
#      integrity.sql's `migrations_unfinished`.
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

# Applied attempts as Prisma recorded them (rolled-back and failed attempts excluded).
applied="$(psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -c "SELECT migration_name, checksum
  FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
declare -A recorded=()
while IFS=$'\t' read -r name sum; do
  [[ -n "$name" ]] && recorded["$name"]+="$sum "
done <<<"$applied"
sha() { sha256sum | cut -d' ' -f1; }
pending=() modified=() total=0
for file in "$repo"/prisma/migrations/*/migration.sql; do
  name="$(basename "$(dirname "$file")")"
  total=$((total + 1))
  if [[ -z "${recorded[$name]:-}" ]]; then pending+=("$name"); continue; fi
  # The file as committed, with LF line endings, and with CRLF line endings.
  accepted=" $(sha <"$file") $(tr -d '\r' <"$file" | sha) $(tr -d '\r' <"$file" | sed ':a;N;$!ba;s/\n/\r\n/g' | sha) "
  ok=0
  for sum in ${recorded[$name]}; do [[ "$accepted" == *" $sum "* ]] && ok=1; done
  [[ "$ok" == "1" ]] || modified+=("$name")
  unset 'recorded[$name]'
done
unknown=("${!recorded[@]}")
if [[ "$total" -gt 0 && ${#pending[@]} -eq 0 && ${#modified[@]} -eq 0 && ${#unknown[@]} -eq 0 ]]; then
  echo "prisma_migrations	up to date ($total applied)"
else
  echo "prisma_migrations	NOT up to date (${#pending[@]} pending, ${#modified[@]} modified, ${#unknown[@]} unknown)"
  for name in "${pending[@]}"; do echo "  pending: $name"; done
  for name in "${modified[@]}"; do echo "  modified: $name"; done
  for name in "${unknown[@]}"; do echo "  unknown: $name"; done
  failed=1
fi

if [[ "$failed" == "0" ]]; then echo '{"status":"VERIFIED"}'; else echo '{"status":"FAILED"}'; exit 1; fi
