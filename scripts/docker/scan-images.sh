#!/usr/bin/env bash
# Known vulnerabilities in built images (Passes 17–18): OS packages and Node packages, by
# Trivy run from its official image pinned by digest (the same index digest is published
# by Aqua on ghcr.io and on Docker Hub; read through mirror.gcr.io, 2026-10-20). The
# image's signature could not be verified with cosign where this was written (sigstore
# unreachable): the provenance check is the digest match between the two registries.
#   EXPECT_REVISION=<git sha> scripts/docker/scan-images.sh <image>...
# Fails when:
#   - .trivyignore.yaml is malformed: every entry needs id, paths, statement and an
#     expired_at no more than 30 days ahead (an expired entry no longer applies: Trivy
#     reports the finding again, and this gate fails on it);
#   - EXPECT_REVISION is set and an image's org.opencontainers.image.revision label differs
#     (a stale image with the same name is never scanned in place of the one just built);
#   - the vulnerability database cannot be downloaded, or a scan errors (never a pass);
#   - Trivy did not detect the image's operating system (OS packages would go unscanned);
#   - any HIGH or CRITICAL finding has a fixed version available.
# Findings without a fix anywhere are listed, not failed on (nothing to upgrade to).
# Prints, per image, counts by layer (OS packages / Node packages) and severity.
# Needs the Docker socket and network access for the database
# (mirror.gcr.io/aquasec/trivy-db). TRIVY_REPORT_DIR keeps the JSON reports;
# TRIVY_DOCKER_ARGS adds `docker run` options where the network needs them (e.g. a local
# proxy: "--network host -v /path/ca.crt:/etc/ssl/certs/ca-certificates.crt:ro");
# TRIVY_CACHE_VOLUME names the database cache volume (default flexibx-trivy-cache).
set -euo pipefail

TRIVY_IMAGE="mirror.gcr.io/aquasec/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ignorefile="${TRIVY_IGNOREFILE:-$root/.trivyignore.yaml}"
cache="${TRIVY_CACHE_VOLUME:-flexibx-trivy-cache}"
[[ $# -gt 0 ]] || { echo "usage: scan-images.sh <image>..." >&2; exit 2; }

# 1. The exception file: a strict reading of the only shape it may have.
python3 - "$ignorefile" <<'PY'
import datetime, re, sys
path = sys.argv[1]
lines = [l.rstrip("\n") for l in open(path, encoding="utf-8")]
entries, current, in_paths = [], None, False
for n, line in enumerate(lines, 1):
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    if line == "vulnerabilities:":
        continue
    m = re.fullmatch(r"  - id: (\S+)", line)
    if m:
        current = {"id": m.group(1), "paths": [], "line": n}; entries.append(current); in_paths = False; continue
    if current is None:
        sys.exit(f"{path}:{n}: unexpected line outside an entry")
    if line == "    paths:":
        in_paths = True; continue
    m = re.fullmatch(r'      - "([^"]+)"', line)
    if m and in_paths:
        current["paths"].append(m.group(1)); continue
    m = re.fullmatch(r'    (statement|expired_at): (.+)', line)
    if m:
        in_paths = False; current[m.group(1)] = m.group(2).strip().strip('"'); continue
    sys.exit(f"{path}:{n}: unexpected line (only id, paths, statement, expired_at are allowed)")
today = datetime.date.today()
for e in entries:
    missing = [k for k in ("statement", "expired_at") if not e.get(k)] + ([] if e["paths"] else ["paths"])
    if missing:
        sys.exit(f"{path}:{e['line']}: {e['id']} lacks {', '.join(missing)}")
    expiry = datetime.date.fromisoformat(e["expired_at"])
    if (expiry - today).days > 30:
        sys.exit(f"{path}:{e['line']}: {e['id']} expires {expiry}: more than 30 days ahead")
    state = "EXPIRED (no longer applied)" if expiry < today else f"until {expiry}"
    print(f"exception {e['id']}: {state}")
print(f"exceptions file OK: {len(entries)} entr{'y' if len(entries) == 1 else 'ies'}")
PY

# 2. Each image is the one expected.
if [[ -n "${EXPECT_REVISION:-}" ]]; then
  for image in "$@"; do
    revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
    [[ "$revision" == "$EXPECT_REVISION" ]] ||
      { echo "vulnerability scan FAILED: $image was built from '$revision', not $EXPECT_REVISION" >&2; exit 1; }
  done
fi

reports="${TRIVY_REPORT_DIR:-$(mktemp -d)}"
docker volume create "$cache" >/dev/null
trivy() {
  docker run --rm -v "$cache:/root/.cache" -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$ignorefile:/trivyignore.yaml:ro" -v "$reports:/report" \
    -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY ${TRIVY_DOCKER_ARGS:-} "$TRIVY_IMAGE" "$@"
}
# 3. The database: a failed download fails the gate (set -e).
trivy image --download-db-only --quiet

failed=0
for image in "$@"; do
  report="$(tr '/:@' '___' <<<"$image").json"
  trivy image --skip-db-update --quiet --scanners vuln --ignorefile /trivyignore.yaml \
    --format json --output "/report/$report" "$image"
  python3 - "$reports/$report" "$image" <<'PY' || failed=1
import collections, json, sys
report, image = sys.argv[1], sys.argv[2]
data = json.load(open(report))
os_info = (data.get("Metadata") or {}).get("OS")
if not os_info:
    print(f"== {image}: operating system NOT detected — OS packages unscanned"); sys.exit(1)
layer = {"os-pkgs": "OS packages", "lang-pkgs": "Node packages"}
counts, blocking, unfixed = collections.Counter(), [], set()
for result in data.get("Results") or []:
    for v in result.get("Vulnerabilities") or []:
        where = layer.get(result.get("Class"), result.get("Class"))
        counts[(where, v["Severity"])] += 1
        if v["Severity"] in ("HIGH", "CRITICAL"):
            entry = (v["Severity"], where, v["PkgName"], v["InstalledVersion"], v["VulnerabilityID"])
            if v.get("FixedVersion"):
                blocking.append(entry + (v["FixedVersion"],))
            else:
                unfixed.add(entry)
print(f"== {image} ({os_info.get('Family')} {os_info.get('Name')})")
for where in ("OS packages", "Node packages"):
    line = ", ".join(f"{s} {counts[(where, s)]}" for s in ("CRITICAL", "HIGH", "MEDIUM", "LOW") if counts[(where, s)])
    print(f"   {where}: {line or 'none'}")
for e in sorted(unfixed):
    print("   no fix published: {} {} {} {} {}".format(*e))
for e in sorted(set(blocking)):
    print("   FIXABLE: {} {} {} {} {} -> {}".format(*e))
sys.exit(1 if blocking else 0)
PY
done
[[ $failed -eq 0 ]] || { echo "vulnerability scan FAILED: see above" >&2; exit 1; }
echo "vulnerability scan OK: no fixable HIGH or CRITICAL finding in $*"
