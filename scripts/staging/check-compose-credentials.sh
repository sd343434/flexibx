#!/usr/bin/env bash
# Which staging services receive the database owner login (Pass 37): exactly the one-off
# jobs migrate, backup and check; never app, worker or scheduler (they run as the runtime
# login). Reads the rendered Compose file; prints service names only, never a value.
#   FLEXIBX_TAG=<tag> scripts/staging/check-compose-credentials.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker compose -f "$root/deploy/staging/compose.yaml" --profile jobs config --format json |
  python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
have = sorted(name for name, s in services.items() if "OWNER_DATABASE_URL" in (s.get("environment") or {}))
expected = ["backup", "check", "migrate"]
if have != expected:
    sys.exit(f"owner login reaches {have}, expected exactly {expected}")
runtime = sorted(name for name in services if name not in expected)
print("owner login:", " ".join(have), "only; not in", " ".join(runtime))
'
