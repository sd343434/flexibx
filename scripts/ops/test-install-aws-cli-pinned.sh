#!/usr/bin/env bash
# Tests scripts/ops/install-aws-cli-pinned.sh without the network (Pass 23): a stub curl
# serves a fixture installer (made up; not the AWS CLI). Proves: the pinned installer is
# installed and its version checked; a checksum mismatch, a failed download, a version
# change without a new checksum and an installer reporting another version are refused,
# and on a checksum mismatch or failed download nothing is installed.
#   scripts/ops/test-install-aws-cli-pinned.sh
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
script="$src/scripts/ops/install-aws-cli-pinned.sh"

# The stub accepts only the versioned HTTPS URL for STUB_VERSION and copies STUB_ZIP to -o.
cat >"$work/curl" <<'STUB'
#!/usr/bin/env bash
out="" url=""
while [[ $# -gt 0 ]]; do
  case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac
done
[[ "$url" == "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-$STUB_VERSION.zip" ]] || exit 22
[[ -n "${STUB_ZIP:-}" ]] || exit 22
cp "$STUB_ZIP" "$out"
STUB
chmod +x "$work/curl"

# fixture <name> <version the installed aws reports>
fixture() {
  mkdir -p "$work/f-$1/aws"
  cat >"$work/f-$1/aws/install" <<INSTALL
#!/usr/bin/env bash
# args: -i <dir> -b <bin> --update
mkdir -p "\$2" "\$4"
printf '#!/usr/bin/env bash\necho "aws-cli/$2 Python/3.13 Linux x86_64"\n' >"\$4/aws"
chmod +x "\$4/aws"
INSTALL
  chmod +x "$work/f-$1/aws/install"
  (cd "$work/f-$1" && zip -qr "$work/$1.zip" aws)
}
fixture good 2.0.1
fixture other 2.0.9
good_sha="$(sha256sum "$work/good.zip" | cut -d' ' -f1)"
other_sha="$(sha256sum "$work/other.zip" | cut -d' ' -f1)"

failures=0
run() { # run <name> <expected exit> <stub version> <zip or ""> [env...] [-- fragment]
  local name="$1" expected="$2" stub_version="$3" zip="$4" status=0
  shift 4
  local fragment="" envs=()
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--" ]]; then fragment="$2"; shift 2; else envs+=("$1"); shift; fi
  done
  rm -rf "$work/inst" "$work/bin"
  env CURL="$work/curl" STUB_VERSION="$stub_version" STUB_ZIP="$zip" "${envs[@]}" \
    "$script" "$work/inst" "$work/bin" >"$work/stdout" 2>"$work/stderr" || status=$?
  local ok=1
  [[ "$status" == "$expected" ]] || ok=0
  [[ -z "$fragment" ]] || grep -qF -- "$fragment" "$work/stderr" || ok=0
  if [[ "$ok" == 1 ]]; then echo "ok    $name"; else
    echo "FAIL  $name (exit $status)"; sed 's/^/      /' "$work/stdout" "$work/stderr"; failures=$((failures + 1)); fi
}
nothing_installed() {
  if [[ -e "$work/bin/aws" ]]; then echo "FAIL    …but aws was installed"; failures=$((failures + 1));
  else echo "ok      …and nothing was installed"; fi
}

run "the pinned installer is installed" 0 2.0.1 "$work/good.zip" \
  AWS_CLI_VERSION=2.0.1 AWS_CLI_SHA256="$good_sha"
if [[ "$("$work/bin/aws" --version)" == "aws-cli/2.0.1 "* ]]; then echo "ok      …and reports 2.0.1"
else echo "FAIL    …installed aws"; failures=$((failures + 1)); fi

run "a file with another checksum is refused" 1 2.0.1 "$work/other.zip" \
  AWS_CLI_VERSION=2.0.1 AWS_CLI_SHA256="$good_sha" -- "checksum mismatch"
nothing_installed
run "the default pin refuses a file that is not the pinned one" 1 2.38.2 "$work/good.zip" \
  -- "checksum mismatch"
nothing_installed
run "a failed download is refused" 1 2.0.1 "" \
  AWS_CLI_VERSION=2.0.1 AWS_CLI_SHA256="$good_sha" -- "download failed"
nothing_installed
run "a version change without a checksum is refused" 2 2.0.1 "$work/good.zip" \
  AWS_CLI_VERSION=2.0.1 -- "without AWS_CLI_SHA256"
run "a v1 or malformed version is refused" 2 1.0.0 "$work/good.zip" \
  AWS_CLI_VERSION=1.0.0 AWS_CLI_SHA256="$good_sha" -- "not an AWS CLI v2 version"
run "a malformed checksum is refused" 2 2.0.1 "$work/good.zip" \
  AWS_CLI_VERSION=2.0.1 AWS_CLI_SHA256=abc -- "not a SHA-256"
run "an installer reporting another version is refused" 1 2.0.1 "$work/other.zip" \
  AWS_CLI_VERSION=2.0.1 AWS_CLI_SHA256="$other_sha" -- "installed version is not 2.0.1"

if [[ "$failures" -gt 0 ]]; then echo "$failures check(s) FAILED"; exit 1; fi
echo "all checks passed"
