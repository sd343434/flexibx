#!/usr/bin/env bash
# Tests scripts/release/build-and-verify.sh's guards without Docker or a registry (Pass 19):
#   scripts/release/test-release-guards.sh
# The script under test runs in a throwaway git repository (its own copy, plus either a
# stub verifier or the real verify-images.sh), with a stub `docker` on PATH that logs every
# call. Proves: refused tags and options build nothing; a SHA tag must be HEAD; --push needs
# a registry and a clean tree; the images get GIT_SHA = HEAD and are built from an archive
# of the commit; a failing check (stub or real) pushes nothing; an existing tag pushes
# nothing; pushes come only after verification. Exit 0 = every case behaved.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
log="$work/docker.log"

mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$DOCKER_LOG"
case "$1 ${2:-}" in
  "manifest inspect") [[ "${STUB_TAG_EXISTS:-0}" == 1 ]] && exit 0 || exit 1 ;;
  "image inspect")
    if [[ "$*" == *revision* ]]; then echo "${STUB_LABEL:-}"; else echo "registry/image@sha256:0"; fi ;;
esac
exit 0
STUB
chmod +x "$work/bin/docker"

# repo <name> <stub|real>: a repository holding the script under test and a verifier.
repo() {
  local dir="$work/$1"
  mkdir -p "$dir/scripts/release"
  cp "$src/scripts/release/build-and-verify.sh" "$dir/scripts/release/"
  if [[ "$2" == stub ]]; then
    printf '#!/usr/bin/env bash\necho "verify $*" >>"$DOCKER_LOG"\nexit "${STUB_VERIFY_EXIT:-0}"\n' \
      >"$dir/scripts/release/verify-images.sh"
  else
    cp "$src/scripts/release/verify-images.sh" "$dir/scripts/release/"
  fi
  chmod +x "$dir/scripts/release/"*.sh
  echo "FROM scratch" >"$dir/Dockerfile"
  git -C "$dir" init -q
  git -C "$dir" add -A
  git -C "$dir" -c user.name=test -c user.email=test@localhost commit -qm release
}
repo stubbed stub
repo real real

failures=0
# case <name> <expected exit> <repo> [VAR=value ...] -- <arguments>
case_() {
  local name="$1" expected="$2" dir="$work/$3"
  shift 3
  local -a env=()
  while [[ "$1" != -- ]]; do env+=("$1"); shift; done
  shift
  : >"$log"
  local status=0
  env PATH="$work/bin:$PATH" DOCKER_LOG="$log" "${env[@]}" \
    "$dir/scripts/release/build-and-verify.sh" "$@" >"$work/out" 2>&1 || status=$?
  if [[ "$status" == "$expected" ]]; then
    echo "ok    $name (exit $status)"
  else
    echo "FAIL  $name: exit $status, expected $expected"; sed 's/^/      /' "$work/out"
    failures=$((failures + 1))
  fi
}
count() { grep -c "^$1" "$log" || true; }
expect() { # expect <description> <condition result: 0 = true>
  if [[ "$2" == 0 ]]; then echo "ok      $1"; else echo "FAIL    $1"; failures=$((failures + 1)); fi
}

head_stub="$(git -C "$work/stubbed" rev-parse HEAD)"
head_real="$(git -C "$work/real" rev-parse HEAD)"
other="$(printf '%040d' 0)"

case_ '"latest" is refused' 2 stubbed -- latest
expect "…and nothing was built" "$([[ "$(count 'docker build')" == 0 ]]; echo $?)"
case_ "a tag Docker would reject is refused" 2 stubbed -- 'bad tag'
case_ "an unknown option is refused" 2 stubbed -- v1 --force
case_ "a SHA tag that is not HEAD is refused" 2 stubbed -- "$other"
expect "…and nothing was built" "$([[ "$(count 'docker build')" == 0 ]]; echo $?)"
case_ "--push without FLEXIBX_REGISTRY is refused" 2 stubbed -- "$head_stub" --push

touch "$work/stubbed/untracked"
case_ "--push from a dirty working tree is refused" 2 stubbed FLEXIBX_REGISTRY=reg.example/f -- "$head_stub" --push
expect "…and nothing was built" "$([[ "$(count 'docker build')" == 0 ]]; echo $?)"
case_ "a build without --push from a dirty tree goes ahead" 0 stubbed -- "$head_stub"
rm "$work/stubbed/untracked"

case_ "a failing check fails the release" 1 stubbed FLEXIBX_REGISTRY=reg.example/f STUB_VERIFY_EXIT=1 -- "$head_stub" --push
expect "…three images were built first" "$([[ "$(count 'docker build')" == 3 ]]; echo $?)"
expect "…and nothing was pushed" "$([[ "$(count 'docker push')" == 0 ]]; echo $?)"

case_ "the real verifier fails on a wrong commit label" 1 real FLEXIBX_REGISTRY=reg.example/f STUB_LABEL="$other" -- "$head_real" --push
expect "…and nothing was pushed" "$([[ "$(count 'docker push')" == 0 ]]; echo $?)"

case_ "a tag that already exists in the registry is refused" 1 stubbed FLEXIBX_REGISTRY=reg.example/f STUB_TAG_EXISTS=1 -- "$head_stub" --push
expect "…after verification, and nothing was pushed" \
  "$([[ "$(count 'verify')" == 1 && "$(count 'docker push')" == 0 ]]; echo $?)"

case_ "a verified release is pushed" 0 stubbed FLEXIBX_REGISTRY=reg.example/f -- "$head_stub" --push
expect "…all three images, each once" "$([[ "$(count 'docker push')" == 3 ]]; echo $?)"
expect "…only after verification" \
  "$([[ "$(grep -n -m1 '^verify' "$log" | cut -d: -f1)" -lt "$(grep -n -m1 '^docker push' "$log" | cut -d: -f1)" ]]; echo $?)"
expect "…every build labelled with HEAD (GIT_SHA=$head_stub)" \
  "$([[ "$(grep -c -- "--build-arg GIT_SHA=$head_stub " "$log")" == 3 ]]; echo $?)"
expect "…every build from an archive of the commit, not the checkout" \
  "$(! grep '^docker build' "$log" | grep -q " $work/stubbed\$"; echo $?)"
expect "…verified against HEAD" "$(grep -q "^verify .* $head_stub\$" "$log"; echo $?)"

case_ "a build without --push pushes nothing" 0 stubbed -- "$head_stub"
expect "…and asks no registry" "$([[ "$(count 'docker push')" == 0 && "$(count 'docker manifest')" == 0 ]]; echo $?)"

if [[ "$failures" != 0 ]]; then echo "release guard tests FAILED: $failures"; exit 1; fi
echo "release guard tests passed"
