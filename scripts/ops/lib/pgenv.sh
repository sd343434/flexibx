# shellcheck shell=bash
# Sourced by the ops scripts. `pg_use_url VARIABLE` turns the connection URL held in the
# environment variable VARIABLE into libpq environment variables (PGHOST, PGPORT, PGUSER,
# PGDATABASE, PGSSLMODE, …) and, when the URL has a password, a private PGPASSFILE (mode
# 0600, in a private temporary directory removed when the script exits, fails or is
# interrupted). pg_dump, psql and pg_restore are then run WITHOUT the URL on their command
# line: arguments are visible to every user of the machine, the environment and the file
# are not. VARIABLE is removed from the environment so child processes do not inherit it.
# Refuses (exit 2, without printing the URL) when the URL cannot be mapped exactly
# (lib/pg-url.mjs).

pg_tmp=""
pg_cleanup() {
  if [[ -n "$pg_tmp" ]]; then rm -rf -- "$pg_tmp"; fi
  pg_tmp=""
}
trap pg_cleanup EXIT

pg_use_url() {
  local variable="$1" lib reason
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  command -v node >/dev/null 2>&1 || {
    echo '{"status":"REFUSED","why":"node is required to read the database URL safely"}' >&2
    exit 2
  }
  pg_tmp="$(mktemp -d)"
  chmod 700 "$pg_tmp"
  if ! reason="$(FLEXIBX_PG_URL="${!variable}" node "$lib/pg-url.mjs" "$pg_tmp" 2>&1 >/dev/null)"; then
    # The reason is a fixed code from pg-url.mjs (never part of the URL).
    reason="${reason//[^a-z_]/}"
    printf '{"status":"REFUSED","why":"%s cannot be used safely (%s)"}\n' "$variable" "${reason:-error}" >&2
    exit 2
  fi
  local pair
  while IFS= read -r -d '' pair; do
    case "${pair%%=*}" in
      PGHOST | PGPORT | PGUSER | PGDATABASE | PGPASSFILE | PGSSLMODE | PGSSLROOTCERT | PGSSLCERT | \
        PGSSLKEY | PGSSLCRL | PGCONNECT_TIMEOUT | PGAPPNAME | PGOPTIONS | PGTARGETSESSIONATTRS)
        export "${pair?}"
        ;;
      *)
        echo '{"status":"REFUSED","why":"unexpected connection setting"}' >&2
        exit 2
        ;;
    esac
  done < "$pg_tmp/env"
  rm -f -- "$pg_tmp/env"
  # A password in the URL wins, as it did with --dbname=<url>.
  if [[ -n "${PGPASSFILE:-}" && "$PGPASSFILE" == "$pg_tmp/"* ]]; then unset PGPASSWORD; fi
  unset "$variable"
}
