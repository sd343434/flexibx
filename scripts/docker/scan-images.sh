#!/usr/bin/env bash
# Known vulnerabilities in built images (Pass 17): OS packages and Node packages, by
# Trivy run from its official image pinned by digest (the same index digest is published
# by Aqua on ghcr.io and on Docker Hub; read through mirror.gcr.io, 2026-10-20).
#   scripts/docker/scan-images.sh <image>...
# Fails on any HIGH or CRITICAL finding that has a fixed version available. A finding with
# no fix yet is reported, not failed on (nothing to upgrade to). Exceptions only in
# .trivyignore.yaml, each with its reason and an expiry date after which it fails again.
# Needs the Docker socket and network access for the vulnerability database
# (mirror.gcr.io/aquasec/trivy-db). Set TRIVY_REPORT_DIR to also write a JSON report, and
# TRIVY_DOCKER_ARGS for extra `docker run` options where the network needs them (e.g. a
# local proxy: "--network host -v /path/ca.crt:/etc/ssl/certs/ca-certificates.crt:ro").
set -euo pipefail

TRIVY_IMAGE="mirror.gcr.io/aquasec/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ $# -gt 0 ]] || { echo "usage: scan-images.sh <image>..." >&2; exit 2; }

docker volume create flexibx-trivy-cache >/dev/null
trivy() {
  docker run --rm -v flexibx-trivy-cache:/root/.cache -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$root/.trivyignore.yaml:/trivyignore.yaml:ro" ${TRIVY_REPORT_DIR:+-v "$TRIVY_REPORT_DIR:/report"} \
    -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY ${TRIVY_DOCKER_ARGS:-} "$TRIVY_IMAGE" "$@"
}
trivy image --download-db-only --quiet

failed=0
for image in "$@"; do
  echo "== $image"
  if [[ -n "${TRIVY_REPORT_DIR:-}" ]]; then
    trivy image --skip-db-update --scanners vuln --ignorefile /trivyignore.yaml --format json \
      --output "/report/$(tr '/:' '__' <<<"$image").json" "$image" >/dev/null
  fi
  trivy image --skip-db-update --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed \
    --ignorefile /trivyignore.yaml --exit-code 1 --format table "$image" || failed=1
done
[[ $failed -eq 0 ]] || { echo "vulnerability scan FAILED: fixable HIGH/CRITICAL findings above" >&2; exit 1; }
echo "vulnerability scan OK: no fixable HIGH or CRITICAL finding in $*"
