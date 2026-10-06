// Validates `.phase-status.json` against the phase completion protocol.
//
//   pnpm phase:validate                 # validates ./.phase-status.json
//   pnpm phase:validate path/to/file    # validates another file
//
// Read-only. Exit codes: 0 = valid, 1 = invalid, 2 = file missing or unreadable.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { MAX_FILE_BYTES, validatePhaseStatusText } from "./schema";

const target = resolve(process.argv[2] ?? ".phase-status.json");

let size: number;
let text = "";
try {
  size = statSync(target).size;
  // Never load oversized files into memory; the size problem is reported below.
  if (size <= MAX_FILE_BYTES) text = readFileSync(target, "utf8");
} catch {
  process.stderr.write(`phase-status: cannot read ${target}\n`);
  process.exit(2);
}

if (size > MAX_FILE_BYTES) {
  process.stderr.write(
    `phase-status: INVALID (1 problem(s))\n  - (root): file exceeds ${String(MAX_FILE_BYTES)} bytes\n`,
  );
  process.exit(1);
}

const result = validatePhaseStatusText(text);
if (result.valid && result.status !== undefined) {
  const { phase, status } = result.status;
  process.stdout.write(`phase-status: VALID (phase ${String(phase)}, ${status})\n`);
  process.exit(0);
}

process.stderr.write(`phase-status: INVALID (${String(result.errors.length)} problem(s))\n`);
for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
process.exit(1);
