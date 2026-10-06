// Validates an AI review response file against the review contract.
//
//   pnpm ai:review-validate <file>
//
// Read-only and offline: reads one file (size-checked first), validates it, prints the
// result. AI-generated text is never executed, interpolated into a shell, or echoed —
// only fixed messages and schema paths are printed.
// Exit codes: 0 = valid, 1 = invalid, 2 = missing argument or unreadable file.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { REVIEW_LIMITS, validateReviewText, type ReviewValidationResult } from "./review-schema";

const argument = process.argv[2];
if (argument === undefined || argument.trim() === "") {
  process.stderr.write("ai-review: usage: pnpm ai:review-validate <file>\n");
  process.exit(2);
}
const target = resolve(argument);

let size: number;
let text = "";
try {
  size = statSync(target).size;
  // Oversized files are never loaded into memory.
  if (size <= REVIEW_LIMITS.fileBytes) text = readFileSync(target, "utf8");
} catch {
  process.stderr.write("ai-review: cannot read review file\n");
  process.exit(2);
}

const result: ReviewValidationResult =
  size > REVIEW_LIMITS.fileBytes
    ? { valid: false, errors: [`(root): review exceeds ${String(REVIEW_LIMITS.fileBytes)} bytes`] }
    : validateReviewText(text);

if (result.valid && result.review !== undefined) {
  const { decision, phase } = result.review;
  process.stdout.write(`ai-review: VALID (decision ${decision}, phase ${String(phase)})\n`);
  process.exit(0);
}

process.stderr.write(`ai-review: INVALID (${String(result.errors.length)} problem(s))\n`);
for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
process.exit(1);
