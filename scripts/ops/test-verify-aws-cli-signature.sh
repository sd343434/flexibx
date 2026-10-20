#!/usr/bin/env bash
# Tests scripts/ops/verify-aws-cli-signature.sh with throwaway GPG keys made here (Pass 24;
# no network, no AWS key). Proves: a good signature from the expected, current key passes;
# a changed file, a signature by another key, a key file that only holds an EXPIRED copy
# of the expected key (gpg itself exits 0 for that) and a revoked key are refused.
#   scripts/ops/test-verify-aws-cli-signature.sh
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'gpgconf --homedir "$work/g" --kill all >/dev/null 2>&1 || true; rm -rf -- "$work"' EXIT
script="$src/scripts/ops/verify-aws-cli-signature.sh"
mkdir -m 700 "$work/g"
g() { gpg --homedir "$work/g" --batch --quiet --pinentry-mode loopback --passphrase '' "$@"; }
fpr() { g --with-colons --list-keys "$1" | awk -F: '/^fpr/ {print $10; exit}'; }

# signer: current, never expires; other: a different key; old: created in 2020 with a
# one-year expiry, so it signed while valid and is expired now; gone: revoked.
g --quick-gen-key "Signer <signer@test.invalid>" rsa2048 sign never
g --quick-gen-key "Other <other@test.invalid>" rsa2048 sign never
g --faked-system-time 20200101T000000 --quick-gen-key "Old <old@test.invalid>" rsa2048 sign 1y
g --quick-gen-key "Gone <gone@test.invalid>" rsa2048 sign never
signer="$(fpr signer@test.invalid)" other="$(fpr other@test.invalid)"
old="$(fpr old@test.invalid)" gone="$(fpr gone@test.invalid)"
for k in signer other old gone; do g --armor --export "$k@test.invalid" >"$work/$k.asc"; done

head -c 4096 /dev/urandom >"$work/awscli.zip"
g --local-user "$signer" --detach-sign -o "$work/by-signer.sig" "$work/awscli.zip"
g --local-user "$other" --detach-sign -o "$work/by-other.sig" "$work/awscli.zip"
g --faked-system-time 20200601T000000 --local-user "$old" --detach-sign -o "$work/by-old.sig" "$work/awscli.zip"
g --local-user "$gone" --detach-sign -o "$work/by-gone.sig" "$work/awscli.zip"
cp "$work/awscli.zip" "$work/changed.zip"; printf x >>"$work/changed.zip"
# Revoked after it signed: gpg writes a revocation certificate at key creation, its
# armor line guarded by ":".
sed 's/^:-----BEGIN/-----BEGIN/' "$work/g/openpgp-revocs.d/$gone.rev" >"$work/gone.rev"
g --import "$work/gone.rev"; g --armor --export "$gone" >"$work/gone-revoked.asc"

failures=0
run() { # run <name> <expected exit> <expected fpr> <file> <sig> <key> [fragment]
  local status=0
  EXPECTED_FPR="$3" "$script" "$4" "$5" "$6" >"$work/out" 2>&1 || status=$?
  if [[ "$status" == "$2" ]] && { [[ -z "${7:-}" ]] || grep -qF -- "$7" "$work/out"; }; then echo "ok    $1"
  else echo "FAIL  $1 (exit $status)"; sed 's/^/      /' "$work/out"; failures=$((failures + 1)); fi
}
run "a good signature from the current expected key" 0 "$signer" "$work/awscli.zip" "$work/by-signer.sig" "$work/signer.asc" "signature OK"
run "a changed file" 1 "$signer" "$work/changed.zip" "$work/by-signer.sig" "$work/signer.asc" "does not verify"
run "signed by another key" 1 "$signer" "$work/awscli.zip" "$work/by-other.sig" "$work/other.asc" "not $signer"
run "only an expired copy of the expected key" 1 "$old" "$work/awscli.zip" "$work/by-old.sig" "$work/old.asc" "expired"
GNUPGHOME="$work/g" gpg --batch --verify "$work/by-old.sig" "$work/awscli.zip" >/dev/null 2>&1 &&
  echo "ok      …while gpg --verify alone exits 0 for it" ||
  { echo "FAIL    …gpg --verify itself refused (the premise changed)"; failures=$((failures + 1)); }
run "a revoked key" 1 "$gone" "$work/awscli.zip" "$work/by-gone.sig" "$work/gone-revoked.asc" "revoked"
run "an unreadable key file" 1 "$signer" "$work/awscli.zip" "$work/by-signer.sig" "$work/none.asc" "could not be imported"

if [[ "$failures" -gt 0 ]]; then echo "$failures check(s) FAILED"; exit 1; fi
echo "all checks passed"
