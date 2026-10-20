#!/usr/bin/env bash
# Writes the staging host's env file from the Secrets Manager secret Terraform creates
# (Pass 22; docs/runbooks/STAGING_LAUNCH.md § 5 step 1). Runs ON the host, with the
# host's instance role (it may read that one secret: deploy/staging/aws/iam.tf):
#   scripts/ops/render-staging-env.sh <secret id or ARN> /opt/flexibx/staging.env
# The secret holds KEY=value lines (deploy/staging/staging.env.example). Before anything
# is written it must have every key of the example, each non-empty (ALERT_WEBHOOK_TOKEN
# may be empty), no placeholder left (CHANGE_ME, example.com, example.internal), no
# duplicate or malformed line, NODE_ENV=production and no test-only setting. Then the file
# is written atomically with mode 600 (a failed run leaves an existing file untouched).
# Never prints a value: only key names and counts. The secret never appears in argv.
# AWS_CLI names the AWS CLI (default: aws).
set -euo pipefail

secret_id="${1:?usage: render-staging-env.sh <secret id or ARN> <output file>}"
out="${2:?usage: render-staging-env.sh <secret id or ARN> <output file>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
example="$root/deploy/staging/staging.env.example"
aws="${AWS_CLI:-aws}"
umask 077

work="$(mktemp -d)"
tmp=""
trap 'rm -rf -- "$work"; if [[ -n "$tmp" ]]; then rm -f -- "$tmp"; fi' EXIT
if ! "$aws" secretsmanager get-secret-value --secret-id "$secret_id" \
  --query SecretString --output text >"$work/env" 2>"$work/err"; then
  echo '{"status":"FAILED","why":"the secret could not be read (aws secretsmanager get-secret-value)"}' >&2
  exit 1
fi

if ! python3 - "$example" "$work/env" <<'PY'; then
import re, sys
example, env = sys.argv[1], sys.argv[2]
required = [m.group(1) for line in open(example, encoding="utf-8")
            if (m := re.match(r"^([A-Z][A-Z0-9_]*)=", line))]
may_be_empty = {"ALERT_WEBHOOK_TOKEN"}
forbidden = {"FLEXIBX_TEST_PROVIDERS", "MAIL_OUTBOX_DIR"}
placeholder = re.compile(r"CHANGE_ME|example\.com|example\.internal")
values, problems = {}, []
for n, line in enumerate(open(env, encoding="utf-8").read().splitlines(), 1):
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    m = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
    if not m:
        problems.append(f"line {n} is not KEY=value"); continue
    key, value = m.groups()
    if key in values:
        problems.append(f"{key} appears twice")
    values[key] = value
missing = [k for k in required if k not in values]
empty = [k for k in required if k in values and values[k] == "" and k not in may_be_empty]
placeholders = sorted(k for k, v in values.items() if placeholder.search(v))
if missing: problems.append("missing: " + ", ".join(missing))
if empty: problems.append("empty: " + ", ".join(empty))
if placeholders: problems.append("placeholder value in: " + ", ".join(placeholders))
if values.get("NODE_ENV") not in (None, "production"): problems.append("NODE_ENV is not production")
bad = sorted(forbidden & values.keys())
if bad: problems.append("test-only setting present: " + ", ".join(bad))
if values.get("CREATOR_AI_PROVIDER") == "simulated": problems.append("CREATOR_AI_PROVIDER=simulated")
if problems:
    print('{"status":"REFUSED","why":"' + "; ".join(problems) + '"}', file=sys.stderr)
    sys.exit(1)
print(f"secret OK: {len(values)} keys, all {len(required)} required present")
PY
  exit 1
fi

dir="$(dirname -- "$out")"
tmp="$(mktemp "$dir/.staging.env.XXXXXX")"
cat "$work/env" >"$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" "$out"
echo "{\"status\":\"WRITTEN\",\"file\":\"$out\",\"mode\":\"600\"}"
