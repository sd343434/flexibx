// Prints the AI review input for the current repository to stdout.
//
//   pnpm ai:review-input
//
// Read-only and offline: runs only the allowlisted git read commands in collect.ts and
// reads `.phase-status.json`. It never calls an AI provider. Exit codes: 0 = input
// produced (check `phase.state`), 2 = not a git repository / git unavailable.
import {
  collectReviewInput,
  createGitReader,
  createStatusFileReader,
  serializeReviewInput,
} from "./collect";

const cwd = process.cwd();
const git = createGitReader(cwd);

if (git("head") === null && git("branch") === null) {
  process.stderr.write("ai-review: not a git repository (or git is unavailable)\n");
  process.exit(2);
}

const input = collectReviewInput({ git, readStatusFile: createStatusFileReader(cwd) });
process.stdout.write(serializeReviewInput(input));
