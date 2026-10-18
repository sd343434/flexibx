#!/usr/bin/env bash
# Verifies a restored database (runbooks: docs/runbooks/BACKUP_RESTORE.md,
# docs/runbooks/OPERATIONAL_RELIABILITY.md § 3):
#   1. row counts equal the backup's manifest, whose own checksum
#      (<manifest>.sha256, written by db-backup.sh) must match first (exact for a backup
#      taken while writes were stopped, approximate for one taken from a live database).
#      The manifest is required: skipping it takes an explicit --no-row-counts,
#   2. integrity checks (sql/integrity.sql, sql/restore-checks.sql) all report 0,
#   2b. every index and constraint of the migrated schema is present, and nothing else
#      (sql/schema-objects.sql against sql/expected-schema-objects.tsv),
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
#   VERIFY_DATABASE_URL=postgresql://…/flexibx_restore scripts/ops/db-verify.sh <backup.counts.tsv>
#   VERIFY_DATABASE_URL=… scripts/ops/db-verify.sh --no-row-counts   # no manifest to compare
#
# Prints counts and check names only. Exit code 0 = every check passed. The URL never
# reaches a command line: psql gets libpq environment variables (lib/pgenv.sh).
set -euo pipefail

: "${VERIFY_DATABASE_URL:?set VERIFY_DATABASE_URL to the restored database}"
counts="${1:-}"
case "$counts" in
  --no-row-counts) counts="" ;;
  "")
    echo '{"status":"REFUSED","why":"give the backup'"'"'s .counts.tsv manifest, or --no-row-counts"}' >&2
    exit 2
    ;;
esac
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
failed=0
# shellcheck source=lib/pgenv.sh
source "$here/lib/pgenv.sh"
pg_use_url VERIFY_DATABASE_URL
trap 'echo "{\"status\":\"FAILED\",\"why\":\"database error\"}"; exit 1' ERR

if [[ -n "$counts" ]]; then
  # The manifest is evidence too: a swapped or edited one would make any restore "match".
  if [[ ! -f "$counts" || ! -f "$counts.sha256" ]]; then
    echo "row_counts_manifest	MISSING (manifest or its .sha256)"
    echo '{"status":"FAILED"}'
    exit 1
  fi
  if [[ "$(sha256sum "$counts" | cut -d' ' -f1)" != "$(cat "$counts.sha256")" ]]; then
    echo "row_counts_manifest	CHECKSUM MISMATCH"
    echo '{"status":"FAILED"}'
    exit 1
  fi
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
checks+=$'\n'"$(psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/restore-checks.sql")"
[[ -n "$checks" ]] || { echo "integrity_checks	NO OUTPUT"; failed=1; }
while IFS=$'\t' read -r check value; do
  [[ -z "$check" ]] && continue
  echo "$check	$value"
  [[ "$value" == "0" ]] || failed=1
done <<<"$checks"

# Every index and constraint the migrations create, and no other: a missing one is a guard
# the restored database does not enforce (a unique index refusing duplicate charges, a
# foreign key, a CHECK); an extra one is drift made by hand in the source. Names only.
expected="$(grep -v '^#' "$here/sql/expected-schema-objects.tsv")"
present="$(psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/schema-objects.sql")"
missing="$(comm -23 <(sort <<<"$expected") <(sort <<<"$present") | sed '/^$/d')"
extra="$(comm -13 <(sort <<<"$expected") <(sort <<<"$present") | sed '/^$/d')"
if [[ -n "$present" && -z "$missing" && -z "$extra" ]]; then
  echo "schema_objects	match ($(wc -l <<<"$present") indexes and constraints)"
else
  echo "schema_objects	MISMATCH ($(grep -c . <<<"$missing" || true) missing, $(grep -c . <<<"$extra" || true) unexpected)"
  [[ -n "$missing" ]] && head -20 <<<"$missing" | sed 's/^/  missing: /'
  [[ -n "$extra" ]] && head -20 <<<"$extra" | sed 's/^/  unexpected: /'
  failed=1
fi

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
