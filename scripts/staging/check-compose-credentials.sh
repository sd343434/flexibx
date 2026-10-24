#!/usr/bin/env bash
# Which staging services receive the database owner login (Pass 37): exactly the one-off
# jobs migrate, backup, check and rehash-sessions (Pass 41); never app, worker or scheduler
# (they run as the runtime login). Also the runtime hardening of app, worker and scheduler
# (Pass 39). Reads the rendered Compose file; prints service names only, never a value.
#   FLEXIBX_TAG=<tag> scripts/staging/check-compose-credentials.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker compose -f "$root/deploy/staging/compose.yaml" --profile jobs config --format json |
  python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
have = sorted(name for name, s in services.items() if "OWNER_DATABASE_URL" in (s.get("environment") or {}))
expected = ["backup", "check", "migrate", "rehash-sessions"]
if have != expected:
    sys.exit(f"owner login reaches {have}, expected exactly {expected}")
runtime = sorted(name for name in services if name not in expected)
print("owner login:", " ".join(have), "only; not in", " ".join(runtime))
# Pass 39: the long-running services run without capabilities or privilege gain, with a PID
# cap; the worker (FFmpeg on customer uploads) also with memory (no swap) and CPU caps.
for name in ("app", "worker", "scheduler"):
    s = services[name]
    problems = []
    if s.get("cap_drop") != ["ALL"] or s.get("cap_add"):
        problems.append("capabilities not dropped")
    if "no-new-privileges:true" not in (s.get("security_opt") or []):
        problems.append("no-new-privileges missing")
    # Pass 40: the default Docker seccomp and AppArmor profiles stay on (FFmpeg CVEs open).
    if any(o.replace("=", ":").endswith(":unconfined") for o in (s.get("security_opt") or [])):
        problems.append("seccomp/apparmor unconfined")
    if not s.get("pids_limit") or s.get("privileged"):
        problems.append("no PID cap or privileged")
    if name == "worker" and not (s.get("mem_limit") and s.get("memswap_limit") == s.get("mem_limit") and s.get("cpus")):
        problems.append("worker memory/CPU caps missing")
    if problems:
        sys.exit(f"{name}: " + ", ".join(problems))
print("hardening: app worker scheduler without capabilities, no-new-privileges, default seccomp, PID caps; worker memory/CPU capped")
'
