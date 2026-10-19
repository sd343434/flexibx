#!/usr/bin/env bash
# Fails when a built image is larger than its budget (Pass 14), so a dependency that drags
# build tooling back into a runtime image is caught in CI instead of in a deploy.
#   scripts/docker/check-image-size.sh <image> <budget-MB>     (MB = 10^6 bytes, as docker shows)
# Budgets (docs/runbooks/STAGING_CREATOR_STUDIO.md § 11): measured size + about 15 %.
set -euo pipefail
image="${1:?image}"
budget_mb="${2:?budget in MB}"
bytes="$(docker image inspect --format '{{.Size}}' "$image")"
mb=$((bytes / 1000000))
if ((mb > budget_mb)); then
  echo "image size check FAILED: $image is ${mb} MB, budget ${budget_mb} MB" >&2
  exit 1
fi
echo "image size OK: $image ${mb} MB (budget ${budget_mb} MB)"
