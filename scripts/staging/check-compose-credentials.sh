#!/usr/bin/env bash
# Which staging services receive the database owner login (Pass 37): exactly the one-off
# jobs migrate, backup, check and rehash-sessions (Pass 41); never app, worker or scheduler
# (they run as the runtime login). Also the runtime hardening of app, worker, media and
# scheduler (Pass 39), and the isolation of FFmpeg in `media` (Pass 42: no credential, no
# network, read-only root, only the work volume). Reads the rendered Compose file; prints
# service and variable names only, never a value.
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
for name in ("app", "worker", "media", "scheduler"):
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
    if name in ("worker", "media") and not (s.get("mem_limit") and s.get("memswap_limit") == s.get("mem_limit") and s.get("cpus")):
        problems.append("memory/CPU caps missing")
    if problems:
        sys.exit(f"{name}: " + ", ".join(problems))
print("hardening: app worker media scheduler without capabilities, no-new-privileges, default seccomp, PID caps; worker and media memory/CPU capped")
# Pass 42: FFmpeg runs only in media, which holds nothing worth stealing.
media = services["media"]
allowed = {"MEDIA_RUNNER_LISTEN", "MEDIA_RUNNER_WORK_ROOT", "MEDIA_RUNNER_CONCURRENCY"}
extra = sorted(set(media.get("environment") or {}) - allowed)
if extra:
    sys.exit(f"media: unexpected environment {extra} (no env file, no credential)")
if media.get("network_mode") != "none" or media.get("ports") or media.get("networks"):
    sys.exit("media: must have network_mode none and no port or network")
if media.get("read_only") is not True:
    sys.exit("media: root filesystem must be read-only")
if media.get("pid") or media.get("ipc") or media.get("devices") or media.get("volumes_from"):
    sys.exit("media: must not share a PID or IPC namespace, devices or volumes")
mounts = [(v.get("type"), v.get("source"), v.get("target")) for v in media.get("volumes") or []]
if mounts != [("volume", "work", "/work")]:
    sys.exit(f"media: mounts {mounts}, expected only the work volume at /work")
socket = (media.get("environment") or {}).get("MEDIA_RUNNER_LISTEN") or ""
if not socket.startswith("/work/"):
    sys.exit("media: the socket must be on the work volume")
for name in ("worker", "check"):
    if (services[name].get("environment") or {}).get("CREATOR_MEDIA_RUNNER_SOCKET") != socket:
        sys.exit(f"{name}: CREATOR_MEDIA_RUNNER_SOCKET must name the media socket")
if "media" not in (services["worker"].get("depends_on") or {}):
    sys.exit("worker: must depend on media")
# No service may reach the Docker daemon.
for name, s in services.items():
    for v in s.get("volumes") or []:
        if "docker.sock" in str(v.get("source")) or "docker.sock" in str(v.get("target")):
            sys.exit(f"{name}: mounts the Docker socket")
print("media: no credential, no network, read-only root, only /work; worker and check use its socket")
'
