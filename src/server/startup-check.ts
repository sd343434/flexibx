import { assertStartupEnv } from "./startup-env";

// Node.js start-up check (see src/instrumentation.ts): logs warnings, and in production
// refuses to start on an invalid environment — a fatal log line, then exit code 1 so the
// process manager or orchestrator sees the failure at once instead of a server that never
// becomes ready. Plain JSON lines on stderr (the app logger is a server-only module);
// variable names and rules only, never values.

function line(level: "warn" | "fatal", msg: string): void {
  process.stderr.write(
    `${JSON.stringify({ level, startup: true, msg, time: new Date().toISOString() })}\n`,
  );
}

export function runStartupCheck(source: NodeJS.ProcessEnv = process.env): void {
  try {
    const report = assertStartupEnv(source);
    for (const message of [...report.warnings, ...report.errors]) line("warn", message);
  } catch (error) {
    line("fatal", error instanceof Error ? error.message : "Invalid environment");
    process.exit(1);
  }
}
