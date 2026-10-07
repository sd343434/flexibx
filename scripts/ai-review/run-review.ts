// Entry point for `pnpm ai:review`. Wires the real OpenAI client into the orchestrator.
// Reads OPENAI_API_KEY / AI_REVIEW_MODEL from the process environment only; accepts no
// command-line options. Read-only: prints the validated review; writes nothing.
import { createOpenAIReviewerClient } from "./openai-reviewer";
import { runReviewCli } from "./review-orchestrator";

process.exitCode = await runReviewCli({
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  createClient: createOpenAIReviewerClient,
});
