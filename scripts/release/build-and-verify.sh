#!/usr/bin/env bash
# Builds the three release images from one commit, verifies them, and pushes them only
# when asked (Pass 18; docs/runbooks/RELEASE_PIPELINE.md):
#   scripts/release/build-and-verify.sh <tag>            # build + verify, local tags only
#   FLEXIBX_REGISTRY=<registry> scripts/release/build-and-verify.sh <tag> --push
# - The build context is `git archive HEAD`: only committed files, never the working
#   tree (uncommitted edits, untracked files, .env, local state cannot reach an image).
# - Images: $FLEXIBX_REGISTRY/{app,worker,ops}:<tag>, labelled with the full commit SHA.
# - <tag> must be an immutable release name (the commit SHA is recommended; a SHA must be
#   HEAD's); "latest" and anything Docker would reject are refused; --push refuses a dirty
#   working tree and a tag that already exists in the registry (ECR repositories are
#   immutable too: deploy/staging/aws). Nothing is pushed unless every check passed.
# - Tested without Docker by scripts/release/test-release-guards.sh.
# - Verification: scripts/release/verify-images.sh (the same checks as CI).
# Local build options (e.g. a proxy, mirrored base images) go in DOCKER_BUILD_ARGS;
# DOCKERFILE replaces the Dockerfile (absolute path) for such local builds only.
set -euo pipefail

tag="${1:?usage: build-and-verify.sh <tag> [--push]}"
push="${2:-}"
registry="${FLEXIBX_REGISTRY:-flexibx}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "invalid tag: $tag" >&2; exit 2; }
[[ "$tag" != latest ]] || { echo "refused: \"latest\" is not a release tag" >&2; exit 2; }
[[ -z "$push" || "$push" == --push ]] || { echo "unknown option: $push" >&2; exit 2; }
if [[ "$push" == --push && "$registry" == flexibx ]]; then
  echo "refused: --push needs FLEXIBX_REGISTRY (the registry to push to)" >&2
  exit 2
fi

cd "$root"
sha="$(git rev-parse HEAD)"
# A tag that is a commit SHA must be this commit (never publish one commit under another's name).
if [[ "$tag" =~ ^[0-9a-f]{40}$ && "$tag" != "$sha" ]]; then
  echo "refused: tag $tag is a commit SHA, but HEAD is $sha" >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  # A release is published from a clean checkout of its commit, so what was tested locally
  # and what is pushed cannot differ.
  if [[ "$push" == --push ]]; then
    echo "refused: --push needs a clean working tree (uncommitted or untracked files)" >&2
    exit 2
  fi
  echo "note: the working tree has uncommitted changes; they are NOT in these images ($sha)"
fi
context="$(mktemp -d)"
trap 'rm -rf -- "$context"' EXIT
git archive --format=tar HEAD | tar -x -C "$context"

declare -A targets=([app]=runner [worker]=worker [ops]=ops)
for name in app worker ops; do
  echo "== build $registry/$name:$tag (target ${targets[$name]}, $sha)"
  # shellcheck disable=SC2086 # DOCKER_BUILD_ARGS is a list of options
  docker build --target "${targets[$name]}" --build-arg GIT_SHA="$sha" \
    -f "${DOCKERFILE:-$context/Dockerfile}" ${DOCKER_BUILD_ARGS:-} \
    -t "$registry/$name:$tag" "$context"
done

"$root/scripts/release/verify-images.sh" "$registry/app:$tag" "$registry/worker:$tag" "$registry/ops:$tag" "$sha"

if [[ "$push" == --push ]]; then
  for name in app worker ops; do
    if docker manifest inspect "$registry/$name:$tag" >/dev/null 2>&1; then
      echo "refused: $registry/$name:$tag already exists (release tags are immutable)" >&2
      exit 1
    fi
  done
  for name in app worker ops; do docker push "$registry/$name:$tag"; done
  for name in app worker ops; do
    docker image inspect --format '{{index .RepoDigests 0}}' "$registry/$name:$tag"
  done
fi
echo "release $tag ($sha): built and verified${push:+, pushed}"
