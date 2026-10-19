#!/usr/bin/env bash
# Self-check of the ops image (Dockerfile target `ops`), run by CI with no network and no
# credentials:
#   docker run --rm --network none --entrypoint bash -e COREPACK_ENABLE_NETWORK=0 \
#     flexibx-ops:ci scripts/ops/check-ops-image.sh
# Checks: non-root user; /backups writable (the backup job's volume); PostgreSQL client
# tools are major version 16 (they must match the 16 server); pnpm and the Prisma CLI run offline as that user (migrate and the
# operator CLIs); no environment files or credentials were baked into the image; the ops
# scripts parse. Never connects to a database.
set -euo pipefail

fail() {
  echo "ops image check FAILED: $*" >&2
  exit 1
}

[[ "$(id -u)" != "0" ]] || fail "runs as root"
echo "user: $(id -un)"

for tool in psql pg_dump pg_restore; do
  version="$("$tool" --version)" || fail "$tool missing"
  [[ "$version" =~ \ 16\.[0-9]+ ]] || fail "$tool is not version 16: $version"
  echo "$version"
done

pnpm_version="$(pnpm --version)" || fail "pnpm needs the network (corepack cache not readable)"
expected="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
[[ "$pnpm_version" == "$expected" ]] || fail "pnpm $pnpm_version, expected $expected"
echo "pnpm $pnpm_version (offline)"
[[ -x node_modules/.bin/prisma ]] || fail "prisma CLI missing"
# The schema engine for this image's platform must already be in the image: as this user
# Prisma cannot download it into node_modules, and `migrate deploy` would fail at run time.
pnpm exec prisma version >/dev/null 2>&1 ||
  fail "prisma cannot run offline as $(id -un) (schema engine for this platform missing)"
echo "prisma CLI runs offline"

baked="$(find /app /home /etc /tmp -path /app/node_modules -prune -o -type f \
  \( -name '.env' -o -name '.env.*' -o -name '.pgpass' -o -name 'pgpass*' \) \
  ! -name '.env.example' -print 2>/dev/null || true)"
[[ -z "$baked" ]] || fail "environment or credential files in the image: $baked"
for name in DATABASE_URL BACKUP_DATABASE_URL RESTORE_DATABASE_URL VERIFY_DATABASE_URL \
  AUTH_SECRET BETTER_AUTH_SECRET ENCRYPTION_KEY PGPASSWORD; do
  [[ -z "${!name:-}" ]] || fail "$name is set in the image environment"
done
echo "no environment or credential files"

# Nothing from the checkout that no job reads: repository history, deployment definitions
# (Terraform state would hold secrets), agent or development-process state.
for path in .git deploy .phase-status.json AGENTS.md CLAUDE.md; do
  [[ ! -e "/app/$path" ]] || fail "/app/$path is in the image"
done
leftover="$(find /app -path /app/node_modules -prune -o -type f \
  \( -name '*.tfstate' -o -name '*.tfstate.*' -o -name '*.tfvars' \) -print 2>/dev/null || true)"
[[ -z "$leftover" ]] || fail "Terraform state or variables in the image: $leftover"
echo "no repository, deployment or agent state"

# The Compose `backup` job mounts a named volume at /backups: it inherits this directory's
# owner, so it must be writable by the job's user.
[[ -d /backups && -w /backups ]] || fail "/backups is missing or not writable by $(id -un)"
echo "/backups writable"

for script in scripts/ops/db-backup.sh scripts/ops/db-restore.sh scripts/ops/db-verify.sh \
  scripts/ops/db-environment.sh; do
  bash -n "$script" || fail "$script does not parse"
done
echo "ops image check passed"
