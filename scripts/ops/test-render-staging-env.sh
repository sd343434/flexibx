#!/usr/bin/env bash
# Tests scripts/ops/render-staging-env.sh without AWS (Pass 22): a stub AWS CLI returns a
# test secret (made-up values, none real). Proves: a complete secret is written with mode
# 600 and the output names no value; a missing key, an empty value, a placeholder, a
# duplicate or malformed line, a test-only setting, a non-production NODE_ENV and an
# unreadable secret are refused, write nothing and leave an existing file untouched.
#   scripts/ops/test-render-staging-env.sh
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
script="$src/scripts/ops/render-staging-env.sh"

# The stub prints the file named by STUB_SECRET as the secret string (or fails).
cat >"$work/aws" <<'STUB'
#!/usr/bin/env bash
[[ "$*" == "secretsmanager get-secret-value --secret-id flexibx-staging/env --query SecretString --output text" ]] || exit 9
[[ -n "${STUB_SECRET:-}" ]] || { echo "AccessDenied" >&2; exit 255; }
cat "$STUB_SECRET"
STUB
chmod +x "$work/aws"

# A complete secret from the example's keys, with made-up values that look nothing like
# the placeholders; every value carries a marker the output must never contain.
python3 - "$src/deploy/staging/staging.env.example" "$work/good.env" <<'PY'
import re, sys
keys = [m.group(1) for line in open(sys.argv[1]) if (m := re.match(r"^([A-Z][A-Z0-9_]*)=", line))]
fixed = {"NODE_ENV": "production", "STORAGE_DRIVER": "s3", "MAIL_TRANSPORT": "resend",
         "CREATOR_AI_PROVIDER": "disabled", "S3_FORCE_PATH_STYLE": "false", "LOG_LEVEL": "info",
         "CREATOR_MAX_UPLOAD_MB": "2000"}
with open(sys.argv[2], "w") as f:
    for k in keys:
        f.write(f"{k}={fixed.get(k, 'MARKER-' + k.lower() + '-zq')}\n")
PY

failures=0
run() { # run <name> <expected exit> <secret file or ""> [expected stderr fragment]
  local name="$1" expected="$2" secret="$3" fragment="${4:-}" status=0
  printf 'KEEP=me\n' >"$work/out.env"; chmod 600 "$work/out.env"
  env AWS_CLI="$work/aws" STUB_SECRET="$secret" "$script" flexibx-staging/env "$work/out.env" \
    >"$work/stdout" 2>"$work/stderr" || status=$?
  local ok=1
  [[ "$status" == "$expected" ]] || ok=0
  [[ -z "$fragment" ]] || grep -qF -- "$fragment" "$work/stderr" || ok=0
  if grep -q "MARKER-" "$work/stdout" "$work/stderr"; then ok=0; echo "      a value was printed"; fi
  if [[ "$expected" != 0 ]] && [[ "$(cat "$work/out.env")" != "KEEP=me" ]]; then
    ok=0; echo "      the existing file was changed"
  fi
  if [[ "$ok" == 1 ]]; then echo "ok    $name"; else
    echo "FAIL  $name (exit $status)"; sed 's/^/      /' "$work/stdout" "$work/stderr"; failures=$((failures + 1)); fi
}
variant() { # variant <name> <python expression transforming text t>
  python3 -c "import sys; t=open(sys.argv[1]).read(); open(sys.argv[2],'w').write($2)" "$work/good.env" "$work/$1.env"
}

run "a complete secret is written" 0 "$work/good.env"
if [[ "$(stat -c %a "$work/out.env")" == 600 ]] && cmp -s "$work/out.env" "$work/good.env"; then
  echo "ok      …with mode 600 and exactly the secret's content"
else echo "FAIL    …mode or content"; failures=$((failures + 1)); fi
ls -a "$work" | grep -q '^\.staging\.env\.' && { echo "FAIL    …a temp file was left"; failures=$((failures + 1)); } ||
  echo "ok      …and no temp file left behind"

variant missing "t.replace('ENCRYPTION_KEY=','DROPPED=',1)"
run "a missing key" 1 "$work/missing.env" "missing: ENCRYPTION_KEY"
variant empty "t.replace('MARKER-auth_secret-zq','',1)"
run "an empty value" 1 "$work/empty.env" "empty: AUTH_SECRET"
variant optional "t.replace('MARKER-alert_webhook_token-zq','',1)"
run "ALERT_WEBHOOK_TOKEN may be empty" 0 "$work/optional.env"
variant placeholder "t.replace('MARKER-database_url-zq','postgresql://u:CHANGE_ME@db/x',1)"
run "a placeholder left in" 1 "$work/placeholder.env" "placeholder value in: DATABASE_URL"
variant domain "t.replace('MARKER-app_url-zq','https://staging.example.com',1)"
run "the example domain left in" 1 "$work/domain.env" "placeholder value in: APP_URL"
variant duplicate "t + 'AUTH_SECRET=MARKER-again-zq\\n'"
run "a duplicate key" 1 "$work/duplicate.env" "AUTH_SECRET appears twice"
variant malformed "t + 'export X=1\\n'"
run "a malformed line" 1 "$work/malformed.env" "is not KEY=value"
variant testonly "t + 'FLEXIBX_TEST_PROVIDERS=allow\\n'"
run "a test-only setting" 1 "$work/testonly.env" "test-only setting present: FLEXIBX_TEST_PROVIDERS"
variant devmode "t.replace('NODE_ENV=production','NODE_ENV=development',1)"
run "NODE_ENV not production" 1 "$work/devmode.env" "NODE_ENV is not production"
variant simulated "t.replace('CREATOR_AI_PROVIDER=disabled','CREATOR_AI_PROVIDER=simulated',1)"
run "the simulated media provider" 1 "$work/simulated.env" "CREATOR_AI_PROVIDER=simulated"
run "an unreadable secret" 1 "" "the secret could not be read"

if [[ "$failures" != 0 ]]; then echo "render-staging-env tests FAILED: $failures"; exit 1; fi
echo "render-staging-env tests passed"
