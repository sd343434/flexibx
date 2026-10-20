#!/usr/bin/env bash
# Checks before the first hosted staging launch, without AWS credentials (Pass 20;
# docs/runbooks/STAGING_LAUNCH.md step 1). It never calls AWS, never plans or applies, and
# never builds or pushes an image:
#   scripts/release/staging-preflight.sh <terraform.tfvars> <release commit SHA>
# 1. the variables file: present, not tracked by git, region and domain filled in (not
#    the example's placeholder domain);
# 2. the release commit: a full SHA, a commit of this repository, on a remote branch (a
#    release is built from pushed history only);
# 3. the Terraform lock file: hashicorp/aws pinned to one version with checksums;
# 4. Terraform: `fmt -check`, `init -backend=false`, `validate` (no provider credentials).
#    TERRAFORM names the binary (default: terraform); TF_INIT_ARGS adds init options
#    (e.g. -plugin-dir for an offline mirror).
# Prints PASS/FAIL per check; exit 0 only when all pass.
set -uo pipefail

tfvars="${1:?usage: staging-preflight.sh <terraform.tfvars> <release commit SHA>}"
sha="${2:?usage: staging-preflight.sh <terraform.tfvars> <release commit SHA>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tfdir="$root/deploy/staging/aws"
terraform="${TERRAFORM:-terraform}"
failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }

# 1. Variables file.
if [[ ! -f "$tfvars" ]]; then
  fail "variables file $tfvars exists"
else
  pass "variables file exists"
  if git -C "$root" ls-files --error-unmatch -- "$(realpath --relative-to="$root" "$tfvars" 2>/dev/null || echo "$tfvars")" >/dev/null 2>&1; then
    fail "variables file is not tracked by git (it is: remove it from the index)"
  else
    pass "variables file is not tracked by git"
  fi
  value() { sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" "$tfvars" | head -1; }
  region="$(value region)"
  domain="$(value app_domain)"
  [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] && pass "region set ($region)" ||
    fail "region set to an AWS region name (got '${region}')"
  if [[ -z "$domain" || "$domain" == *example.* || ! "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    fail "app_domain set to the real staging host (got '${domain}')"
  else
    pass "app_domain set ($domain)"
  fi
fi

# 2. Release commit.
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  fail "release commit is a full 40-character SHA (got '$sha')"
elif ! git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null; then
  fail "release commit $sha exists in this repository"
else
  pass "release commit exists"
  if [[ -n "$(git -C "$root" branch -r --contains "$sha" 2>/dev/null)" ]]; then
    pass "release commit is on a remote branch"
  else
    fail "release commit is on a remote branch (push it, then fetch)"
  fi
fi

# 3. Lock file.
lock="$tfdir/.terraform.lock.hcl"
if [[ -f "$lock" ]] && [[ "$(grep -c '^provider "registry.terraform.io/hashicorp/aws"' "$lock")" == 1 ]] &&
  grep -qE '^  version += "[0-9]+\.[0-9]+\.[0-9]+"$' "$lock" && grep -q '"zh:' "$lock"; then
  pass "lock file pins hashicorp/aws $(sed -nE 's/^  version += "([^"]+)"$/\1/p' "$lock") with checksums"
else
  fail "lock file pins hashicorp/aws to one version with checksums"
fi

# 4. Terraform (local only: no backend, no credentials).
if ! command -v "$terraform" >/dev/null 2>&1; then
  fail "terraform available ($terraform)"
else
  work="$(mktemp -d)"
  trap 'rm -rf -- "$work"' EXIT
  cp -R "$tfdir/." "$work/"
  rm -rf "$work/.terraform" "$work/terraform.tfstate"*
  # shellcheck disable=SC2086 # TF_INIT_ARGS is a list of options
  if (cd "$work" && "$terraform" fmt -recursive -check >/dev/null &&
    "$terraform" init -backend=false -input=false -no-color ${TF_INIT_ARGS:-} >/dev/null &&
    "$terraform" validate -no-color >/dev/null); then
    pass "terraform fmt, init (no backend) and validate"
  else
    fail "terraform fmt, init (no backend) and validate"
  fi
fi

if [[ "$failures" != 0 ]]; then
  echo "{\"status\":\"PREFLIGHT FAILED\",\"failed\":$failures}"
  exit 1
fi
echo '{"status":"PREFLIGHT PASSED","next":"terraform plan -out staging.plan, reviewed by the owner; apply only after a separate approval"}'
