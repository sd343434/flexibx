"""Runs a command in a pseudo-terminal for tests/integration/admin-grant.test.ts.

Reads a JSON spec on stdin: {"argv": [...], "waitFor": "prompt text", "send": "keys",
"timeoutSeconds": 60}. The command runs as `argv ; stty -a` inside the terminal, so the
terminal settings AFTER the command (echo restored or not) are part of the output.
When `waitFor` appears in the output, `send` is typed. The environment is inherited.
Prints one JSON object: {"output": "...", "exitCode": n}. Nothing secret is passed on the
command line: the spec arrives on stdin.
"""

import json
import os
import pty
import select
import shlex
import sys
import time

spec = json.load(sys.stdin)
command = " ".join(shlex.quote(part) for part in spec["argv"])
script = f'{command}; code=$?; printf "\\n@@STTY "; stty -a | tr "\\n" " "; printf "@@\\n"; exit $code'

pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "--noprofile", "--norc", "-c", script])

output = b""
sent = False
deadline = time.time() + float(spec.get("timeoutSeconds", 60))
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    if not sent and spec["waitFor"].encode() in output:
        time.sleep(0.2)
        os.write(fd, spec["send"].encode())
        sent = True

try:
    _, status = os.waitpid(pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)
except ChildProcessError:
    exit_code = -1
print(json.dumps({"output": output.decode(errors="replace"), "exitCode": exit_code, "sent": sent}))
