#!/usr/bin/env bash
# Tests scripts/release/staging-preflight.sh without AWS or a real Terraform run (Pass 20):
#   scripts/release/test-staging-preflight.sh
# A throwaway clone with a bare "origin", a stub terraform, and variables files that are
# right or wrong in one way each. Exit 0 = every case behaved.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

repo="$work/repo"
mkdir -p "$repo/scripts/release" "$repo/deploy/staging/aws"
cp "$src/scripts/release/staging-preflight.sh" "$repo/scripts/release/"
cp "$src/deploy/staging/aws/.terraform.lock.hcl" "$repo/deploy/staging/aws/"
echo 'terraform {}' >"$repo/deploy/staging/aws/versions.tf"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=t -c user.email=t@localhost commit -qm pushed
git init -q --bare "$work/origin.git"
git -C "$repo" remote add origin "$work/origin.git"
git -C "$repo" push -q origin main 2>/dev/null
git -C "$repo" fetch -q origin
pushed="$(git -C "$repo" rev-parse HEAD)"
echo local >"$repo/local.txt"
git -C "$repo" add local.txt
git -C "$repo" -c user.name=t -c user.email=t@localhost commit -qm unpushed
unpushed="$(git -C "$repo" rev-parse HEAD)"

mkdir "$work/bin"
printf '#!/usr/bin/env bash\necho "terraform $*" >>"%s/tf.log"\nexit "${STUB_TF_EXIT:-0}"\n' "$work" >"$work/bin/terraform"
chmod +x "$work/bin/terraform"

good="$work/good.tfvars"
printf 'region     = "me-central-1"\napp_domain = "staging.flexibx-demo.net"\n' >"$good"

failures=0
case_() { # case_ <name> <expected exit> <expected line or -> [VAR=value ...] -- <args>
  local name="$1" expected="$2" line="$3"
  shift 3
  local -a env=()
  while [[ "$1" != -- ]]; do env+=("$1"); shift; done
  shift
  local status=0
  env TERRAFORM="$work/bin/terraform" "${env[@]}" "$repo/scripts/release/staging-preflight.sh" "$@" >"$work/out" 2>&1 || status=$?
  if [[ "$status" == "$expected" ]] && { [[ "$line" == - ]] || grep -qF -- "$line" "$work/out"; }; then
    echo "ok    $name"
  else
    echo "FAIL  $name (exit $status, expected $expected, line: $line)"; sed 's/^/      /' "$work/out"
    failures=$((failures + 1))
  fi
}

case_ "all inputs right" 0 "PREFLIGHT PASSED" -- "$good" "$pushed"
grep -q "terraform validate" "$work/tf.log" && echo "ok    …and terraform validate ran" ||
  { echo "FAIL  …terraform validate did not run"; failures=$((failures + 1)); }
grep -qE "plan|apply" "$work/tf.log" && { echo "FAIL  …terraform plan/apply ran"; failures=$((failures + 1)); } ||
  echo "ok    …and never plan or apply"
case_ "missing variables file" 1 "FAIL  variables file" -- "$work/none.tfvars" "$pushed"
printf 'region     = "me-central-1"\napp_domain = "staging.example.com"\n' >"$work/example.tfvars"
case_ "the example's placeholder domain" 1 "FAIL  app_domain" -- "$work/example.tfvars" "$pushed"
for tld in test invalid localhost local; do
  printf 'region     = "me-central-1"\napp_domain = "staging.flexibx.%s"\n' "$tld" >"$work/reserved.tfvars"
  case_ "a reserved name (.$tld)" 1 "FAIL  app_domain" -- "$work/reserved.tfvars" "$pushed"
done
printf 'region     = ""\napp_domain = "staging.flexibx-demo.net"\n' >"$work/noregion.tfvars"
case_ "no region" 1 "FAIL  region" -- "$work/noregion.tfvars" "$pushed"
cp "$good" "$repo/tracked.tfvars"
git -C "$repo" add tracked.tfvars
case_ "a variables file tracked by git" 1 "FAIL  variables file is not tracked" -- "$repo/tracked.tfvars" "$pushed"
git -C "$repo" rm -q --cached tracked.tfvars
case_ "a short SHA" 1 "FAIL  release commit is a full" -- "$good" "${pushed:0:12}"
case_ "an unknown commit" 1 "FAIL  release commit $(printf '%040d' 0) exists" -- "$good" "$(printf '%040d' 0)"
case_ "a commit not on any remote branch" 1 "FAIL  release commit is on a remote branch" -- "$good" "$unpushed"
case_ "terraform validate failing" 1 "FAIL  terraform" STUB_TF_EXIT=1 -- "$good" "$pushed"
mv "$repo/deploy/staging/aws/.terraform.lock.hcl" "$work/lock"
case_ "no lock file" 1 "FAIL  lock file" -- "$good" "$pushed"
mv "$work/lock" "$repo/deploy/staging/aws/.terraform.lock.hcl"

if [[ "$failures" != 0 ]]; then echo "staging preflight tests FAILED: $failures"; exit 1; fi
echo "staging preflight tests passed"
