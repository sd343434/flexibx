#!/usr/bin/env bash
# What a runtime image must not contain, and how it must run (Pass 17), checked from the
# outside on the built image so the same rules hold for all three:
#   scripts/docker/check-image-contents.sh <image> app|worker|ops
# - runs as a non-root user;
# - no environment file, credential, key, Terraform state or variables anywhere it could
#   be read from (/app, /home, /etc, /tmp), and no secret in the image's environment;
# - nothing from the checkout that no command reads: repository history, deployment
#   definitions, CI files, docs, tests, agent or development-process state;
# - the app image carries no package manager (npm, npx, corepack, pnpm): the server never
#   runs one, and their bundled packages were most of its scanner findings;
# - the scratch volume of the worker (/work) and the backup volume of ops (/backups) are
#   writable by the image's user (a new named volume takes that directory's owner).
# Offline (--network none); never starts the application.
set -euo pipefail

image="${1:?image}"
kind="${2:?app|worker|ops}"
case "$kind" in app | worker | ops) ;; *) echo "kind must be app, worker or ops" >&2 && exit 2 ;; esac

fail() {
  echo "image contents check FAILED ($image): $*" >&2
  exit 1
}

# Secrets passed at build time would show up in the image's configuration.
env_names="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | cut -d= -f1)"
for name in DATABASE_URL AUTH_SECRET BETTER_AUTH_SECRET ENCRYPTION_KEY S3_SECRET_ACCESS_KEY \
  S3_ACCESS_KEY_ID OPS_STATUS_SECRET AUTOMATION_CRON_SECRET VIDEO_RETENTION_CRON_SECRET \
  ALERT_WEBHOOK_TOKEN RESEND_API_KEY OPENAI_API_KEY PGPASSWORD AWS_SECRET_ACCESS_KEY; do
  grep -qx "$name" <<<"$env_names" && fail "$name is set in the image environment"
done

# shellcheck disable=SC2016 # expanded inside the container
docker run --rm --network none --entrypoint sh -e KIND="$kind" "$image" -c '
  set -eu
  bad() { echo "$*" >&2; exit 1; }
  [ "$(id -u)" != 0 ] || bad "runs as root"
  found="$(find /app /home /etc /tmp -xdev \
    \( -path /app/node_modules -o -path /etc/ssl -o -path /etc/ca-certificates \) -prune -o -type f \
    \( -name ".env" -o -name ".env.*" -o -name ".pgpass" -o -name "pgpass*" -o -name "*.tfstate" \
       -o -name "*.tfstate.*" -o -name "*.tfvars" -o -name "id_rsa*" -o -name "id_ed25519*" \
       -o -name "*.pem" -o -name "*.key" -o -name "credentials" \) \
    ! -name ".env.example" -print 2>/dev/null || true)"
  [ -z "$found" ] || bad "credential, key or Terraform files: $found"
  for path in .git .github deploy docs tests e2e coverage test-results playwright-report \
    .phase-status.json AGENTS.md CLAUDE.md .terraform; do
    [ ! -e "/app/$path" ] || bad "/app/$path is in the image"
  done
  case "$KIND" in
    app)
      for tool in npm npx corepack pnpm yarn; do
        ! command -v "$tool" >/dev/null 2>&1 || bad "package manager $tool in the app image"
      done
      [ ! -e /usr/local/lib/node_modules ] || bad "/usr/local/lib/node_modules in the app image"
      [ -f /app/server.js ] || bad "server.js missing"
      ;;
    worker) [ -d /work ] && [ -w /work ] || bad "/work missing or not writable by $(id -un)" ;;
    ops) [ -d /backups ] && [ -w /backups ] || bad "/backups missing or not writable by $(id -un)" ;;
  esac
  echo "user $(id -un) ($(id -u)); node $(node --version)"
' || fail "see above"

echo "image contents OK: $image ($kind)"
