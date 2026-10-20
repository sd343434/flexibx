#!/usr/bin/env bash
# Pinned AWS CLI v2 install for the staging host (Pass 23, R-9 proposal; NOT wired into
# user-data until the owner chooses it over the snap — RELEASE_READINESS_DECISIONS.md R-9).
# Downloads exactly one versioned installer from AWS, refuses it unless its SHA-256 is the
# pinned one, installs it and refuses an installed version other than the pinned one.
# The pinned hash was taken on 2026-10-20 from a file whose signature is cryptographically
# valid for the AWS CLI team key FB5DB77FD5C118B80511ADA8A6310ACC4672475C, but the only
# copy of that key reachable then (keyserver.ubuntu.com) was EXPIRED (2026-07-07), so
# scripts/ops/verify-aws-cli-signature.sh refuses it: the pin's provenance is NOT fully
# established until that script passes with the current key from AWS's documentation
# (RELEASE_READINESS_DECISIONS.md R-9). The hash, not the key, is checked at install time.
#   scripts/ops/install-aws-cli-pinned.sh [install dir] [bin dir]
# To move to a newer version, change AWS_CLI_VERSION and AWS_CLI_SHA256 together (both, or
# the script refuses), after verify-aws-cli-signature.sh passes for the new file.
set -euo pipefail

pinned_version="2.38.2"
pinned_sha256="16a4d39d60b631d884f1260fd7755b72daef15baf6cac21131c6c71676164b37"
version="${AWS_CLI_VERSION:-$pinned_version}"
sha256="${AWS_CLI_SHA256:-$pinned_sha256}"
if [[ "$version" != "$pinned_version" && "$sha256" == "$pinned_sha256" ]]; then
  echo "AWS_CLI_VERSION changed without AWS_CLI_SHA256: refusing an unpinned install" >&2
  exit 2
fi
[[ "$version" =~ ^2\.[0-9]+\.[0-9]+$ ]] || { echo "not an AWS CLI v2 version: $version" >&2; exit 2; }
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "not a SHA-256: $sha256" >&2; exit 2; }

install_dir="${1:-/usr/local/aws-cli}"
bin_dir="${2:-/usr/local/bin}"
curl_bin="${CURL:-curl}"
url="https://awscli.amazonaws.com/awscli-exe-linux-x86_64-$version.zip"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

"$curl_bin" -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/awscli.zip" "$url" ||
  { echo "download failed: $url" >&2; exit 1; }
actual="$(sha256sum "$work/awscli.zip" | cut -d' ' -f1)"
if [[ "$actual" != "$sha256" ]]; then
  echo "checksum mismatch for $url: expected $sha256, got $actual; nothing installed" >&2
  exit 1
fi
unzip -q "$work/awscli.zip" -d "$work/x"
"$work/x/aws/install" -i "$install_dir" -b "$bin_dir" --update
installed="$("$bin_dir/aws" --version 2>&1)"
if [[ "$installed" != "aws-cli/$version "* ]]; then
  echo "installed version is not $version: $installed" >&2
  exit 1
fi
echo "AWS CLI $version installed (sha256 $sha256)"
