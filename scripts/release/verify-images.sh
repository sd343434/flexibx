#!/usr/bin/env bash
# Every check a release image must pass before it may be pushed (Pass 18). One list, used
# by CI's Docker job and by scripts/release/build-and-verify.sh, so the two cannot drift:
#   scripts/release/verify-images.sh <app image> <worker image> <ops image> <git sha>
# 1. each image is labelled with the commit it is said to be built from;
# 2. contents: non-root, no credentials / keys / state / tests, no package manager in the
#    app image, /work and /backups writable (scripts/docker/check-image-contents.sh);
# 3. size budgets (scripts/docker/check-image-size.sh; STAGING_CREATOR_STUDIO.md § 11);
# 4. the ops image's self-check and the worker's media tools and PostgreSQL 16 client,
#    offline, as the images' own users;
# 5. known vulnerabilities (scripts/docker/scan-images.sh, with that commit expected).
# Exit 0 only when every check passed.
set -euo pipefail

app="${1:?app image}"
worker="${2:?worker image}"
ops="${3:?ops image}"
sha="${4:?git sha the images were built from}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for image in "$app" "$worker" "$ops"; do
  label="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
  [[ "$label" == "$sha" ]] || { echo "image $image is labelled '$label', expected $sha" >&2; exit 1; }
done
echo "revision label OK: $sha"

"$root/scripts/docker/check-image-contents.sh" "$app" app
"$root/scripts/docker/check-image-contents.sh" "$worker" worker
"$root/scripts/docker/check-image-contents.sh" "$ops" ops

"$root/scripts/docker/check-image-size.sh" "$app" 500
"$root/scripts/docker/check-image-size.sh" "$worker" 1400
"$root/scripts/docker/check-image-size.sh" "$ops" 1250

docker run --rm --network none --entrypoint bash -e COREPACK_ENABLE_NETWORK=0 "$ops" \
  scripts/ops/check-ops-image.sh
docker run --rm --network none "$worker" sh scripts/creator/check-media-tools.sh
docker run --rm --network none "$worker" psql --version | grep -q " 16\." ||
  { echo "worker image: PostgreSQL client is not 16" >&2; exit 1; }
echo "worker PostgreSQL client 16 OK"

EXPECT_REVISION="$sha" "$root/scripts/docker/scan-images.sh" "$app" "$worker" "$ops"
echo "release images verified: $app $worker $ops ($sha)"
