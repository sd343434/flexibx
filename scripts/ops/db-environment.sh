#!/usr/bin/env bash
# Which environment a database belongs to (Pass 15). A database is marked once by an
# administrator; jobs that write to it (the staging `migrate` job) and the staging gate
# assert the marker first, so a staging command pointed at another environment's database
# stops before doing anything (docs/runbooks/STAGING_CREATOR_STUDIO.md § 3).
#
#   DATABASE_URL=… scripts/ops/db-environment.sh mark staging --confirm-database <name>
#   DATABASE_URL=… scripts/ops/db-environment.sh assert staging
#   DATABASE_URL=… scripts/ops/db-environment.sh show
#
# The marker is the database's comment, `flexibx-environment=<name>`. pg_dump does not
# carry it into a restore, so a restored copy is unmarked until someone marks it on
# purpose. `mark` refuses to replace a different marker (a production database never
# becomes "staging" by mistake) and needs the database's name repeated. Marking needs
# the database owner. Prints one JSON line, never the URL. Exit 0 = ok, 1 = assertion
# failed or database error, 2 = refused (usage, confirmation, conflicting marker).
set -euo pipefail

ENVIRONMENTS="staging production development"
action="${1:-}"
wanted="${2:-}"
refuse() {
  printf '{"status":"REFUSED","why":"%s"}\n' "$1"
  exit 2
}
case "$action" in
  mark | assert)
    [[ " $ENVIRONMENTS " == *" $wanted "* ]] || refuse "environment must be one of: $ENVIRONMENTS"
    ;;
  show) ;;
  *) refuse "usage: db-environment.sh mark|assert <environment> | show" ;;
esac
: "${DATABASE_URL:?set DATABASE_URL to the database to check}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgenv.sh
source "$here/lib/pgenv.sh"
pg_use_url DATABASE_URL
trap 'echo "{\"status\":\"FAILED\",\"why\":\"database error\"}"; exit 1' ERR

query() { psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
database="$(query -c "SELECT current_database()")"
comment="$(query -c "SELECT coalesce(shobj_description(oid, 'pg_database'), '')
  FROM pg_database WHERE datname = current_database()")"
current=""
if [[ "$comment" =~ ^flexibx-environment=([a-z]+)$ ]]; then current="${BASH_REMATCH[1]}"; fi

case "$action" in
  show)
    printf '{"status":"OK","database":"%s","environment":"%s"}\n' "$database" "${current:-unmarked}"
    ;;
  assert)
    if [[ "$current" == "$wanted" ]]; then
      printf '{"status":"OK","database":"%s","environment":"%s"}\n' "$database" "$current"
    else
      printf '{"status":"FAILED","why":"database %s is %s, expected %s"}\n' \
        "$database" "${current:-unmarked}" "$wanted"
      exit 1
    fi
    ;;
  mark)
    [[ "${3:-}" == "--confirm-database" && "${4:-}" == "$database" ]] ||
      refuse "repeat the database name: --confirm-database <name>"
    if [[ -n "$current" && "$current" != "$wanted" ]]; then
      refuse "database $database is already marked $current"
    fi
    if [[ -z "$current" && -n "$comment" ]]; then
      refuse "database $database has another comment; remove it first"
    fi
    # Identifier and literal quoted by PostgreSQL itself (format %I / %L).
    psql -X -q -v ON_ERROR_STOP=1 -v env="$wanted" >/dev/null <<'SQL'
SELECT format('COMMENT ON DATABASE %I IS %L', current_database(), 'flexibx-environment=' || :'env')
\gexec
SQL
    printf '{"status":"MARKED","database":"%s","environment":"%s"}\n' "$database" "$wanted"
    ;;
esac
