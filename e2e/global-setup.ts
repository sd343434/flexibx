import { execFileSync } from "node:child_process";

/**
 * Refuses to start the browser tests against a database that is not fully migrated.
 * Without this, an unmigrated database makes sign-up answer the generic error and most
 * tests fail far from the cause (Pass 20: 33 of 43 failed that way, the server logging
 * "The table `public.rate_limits` does not exist").
 */
export default function globalSetup() {
  // A server started elsewhere (E2E_BASE_URL) owns its own database.
  if (process.env.E2E_BASE_URL) return;
  try {
    execFileSync("pnpm", ["exec", "prisma", "migrate", "status"], { stdio: "pipe" });
  } catch (error) {
    const output =
      error instanceof Error && "stdout" in error
        ? String((error as { stdout: unknown }).stdout)
        : "";
    const reason = output.split("\n").find((line) => /migration|database/i.test(line)) ?? "";
    throw new Error(
      `The E2E database (DATABASE_URL) is not fully migrated: run \`pnpm exec prisma migrate deploy\` first. ${reason}`.trim(),
      { cause: error },
    );
  }
}
