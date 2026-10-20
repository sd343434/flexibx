#!/usr/bin/env bash
# Verifies an AWS CLI installer's detached GPG signature before its SHA-256 is pinned in
# scripts/ops/install-aws-cli-pinned.sh (Pass 24, R-9). `gpg --verify` exits 0 for a good
# signature from an EXPIRED key (seen in Pass 23), so its exit status alone proves too
# little; this reads gpg's machine-readable status and passes only when:
#   - the signature is valid (VALIDSIG, which gpg emits only for a good signature);
#   - the signing key's primary fingerprint is the expected one (AWS CLI team key);
#   - the key is neither expired nor revoked (no EXPKEYSIG / REVKEYSIG / KEYEXPIRED /
#     KEYREVOKED), i.e. the key file is a current copy, not a stale one.
#   scripts/ops/verify-aws-cli-signature.sh <installer.zip> <installer.zip.sig> <public key file>
# The key file must come from AWS's documentation ("Install or update the AWS CLI", the
# PGP public key section), not from a keyserver: a keyserver copy may lack AWS's latest
# expiry extension. EXPECTED_FPR overrides the fingerprint (tests only).
set -euo pipefail

file="${1:?usage: verify-aws-cli-signature.sh <file> <file.sig> <public key file>}"
sig="${2:?usage: verify-aws-cli-signature.sh <file> <file.sig> <public key file>}"
key="${3:?usage: verify-aws-cli-signature.sh <file> <file.sig> <public key file>}"
expected="${EXPECTED_FPR:-FB5DB77FD5C118B80511ADA8A6310ACC4672475C}"

home="$(mktemp -d)"
trap 'rm -rf -- "$home"' EXIT
export GNUPGHOME="$home"
gpg --batch --quiet --import "$key" 2>/dev/null || { echo "REFUSED: the key file could not be imported" >&2; exit 1; }
status="$(gpg --batch --status-fd 1 --verify "$sig" "$file" 2>/dev/null || true)"

refuse() { echo "REFUSED: $1" >&2; exit 1; }
grep -qE '^\[GNUPG:\] (EXPKEYSIG|KEYEXPIRED)' <<<"$status" && refuse "the signing key is expired in this key file (get the current key from AWS's documentation)"
grep -qE '^\[GNUPG:\] (REVKEYSIG|KEYREVOKED)' <<<"$status" && refuse "the signing key is revoked"
grep -qE '^\[GNUPG:\] (BADSIG|ERRSIG)' <<<"$status" && refuse "the signature does not verify"
primary="$(sed -nE 's/^\[GNUPG:\] VALIDSIG .* ([0-9A-F]{40})$/\1/p' <<<"$status" | head -1)"
[[ "$primary" == "$expected" ]] || refuse "signed by ${primary:-an unknown key}, not $expected"
echo "signature OK: $(basename "$file") signed by $expected (key current); sha256 $(sha256sum "$file" | cut -d' ' -f1)"
