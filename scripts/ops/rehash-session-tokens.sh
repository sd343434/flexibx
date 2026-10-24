#!/usr/bin/env bash
# Hashes the session tokens a release before Pass 39 stored raw (Pass 41;
# docs/runbooks/SESSION_TOKENS.md). The migration 20261023120000_hash_session_tokens does
# this once; Prisma never re-runs it, so rows written raw afterwards — by the previous
# release still serving while a deploy switches over, or during a rollback to it — are
# not found by the current release until this runs. Idempotent: rows already hashed
# (`h1$…`) are left alone; only the `token` column of `sessions` changes.
#
#   REHASH_DATABASE_URL=… scripts/ops/rehash-session-tokens.sh
#
# Needs a login that may UPDATE sessions (the owner login in the staging jobs). Prints one
# JSON line with counts only — never a token or the URL; the URL never reaches a command
# line (lib/pgenv.sh). Exit 0 = done, 1 = database error, 2 = refused.
set -euo pipefail
: "${REHASH_DATABASE_URL:?set REHASH_DATABASE_URL to the database to update}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgenv.sh
source "$here/lib/pgenv.sh"
pg_use_url REHASH_DATABASE_URL
trap 'echo "{\"status\":\"FAILED\",\"why\":\"database error\"}"; exit 1' ERR

# Same expression as the migration: 'h1$' || hex(sha256(utf8 token)) = hashSessionToken().
counts="$(psql -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 <<'SQL'
WITH changed AS (
  UPDATE "sessions"
  SET "token" = 'h1$' || encode(sha256(convert_to("token", 'UTF8')), 'hex')
  WHERE "token" NOT LIKE 'h1$%'
  RETURNING 1
)
SELECT (SELECT count(*) FROM changed), (SELECT count(*) FROM "sessions");
SQL
)"
read -r rehashed total <<<"$counts"
printf '{"status":"OK","rehashed":%s,"sessions":%s}\n' "$rehashed" "$total"
