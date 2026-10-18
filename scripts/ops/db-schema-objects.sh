#!/usr/bin/env bash
# Prints the indexes and constraints of a database in the format of
# sql/expected-schema-objects.tsv (runbook: docs/runbooks/OPERATIONAL_RELIABILITY.md § 3).
# After adding a migration, run it against a freshly migrated DISPOSABLE database:
#
#   SCHEMA_DATABASE_URL=postgresql://…/scratch scripts/ops/db-schema-objects.sh \
#     > scripts/ops/sql/expected-schema-objects.tsv
#
# Names only. The URL never reaches a command line (lib/pgenv.sh).
set -euo pipefail

: "${SCHEMA_DATABASE_URL:?set SCHEMA_DATABASE_URL to a freshly migrated disposable database}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgenv.sh
source "$here/lib/pgenv.sh"
pg_use_url SCHEMA_DATABASE_URL
objects="$(psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -f "$here/sql/schema-objects.sql")"
echo "# Generated from the migrated schema by scripts/ops/db-schema-objects.sh (kind, table, name)."
echo "# Regenerate after a migration: docs/runbooks/OPERATIONAL_RELIABILITY.md § 3."
printf '%s\n' "$objects"
