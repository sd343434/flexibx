// Staging pre-rollout gate (docs/runbooks/STAGING_CREATOR_STUDIO.md § 3): run in the worker
// image (it has FFmpeg, the PostgreSQL client and the scratch volume) with the deployment's
// environment, after the app and the worker started and before the trial:
//
//   docker run --rm --env-file staging.env -v work:/work flexibx-worker \
//     node --import tsx --import ./scripts/video-retention/register.mjs scripts/staging/check.ts
//   … scripts/staging/check.ts --send-test-alert   # also delivers one test alert
//
// Exit code 0: PASSED. 1: FAILED (a check found a problem). 2: INCOMPLETE (nothing failed,
// but a check could not run here — not a pass). Writes only the preflight's random probe
// objects (deleted again); never calls an AI provider; prints names and reasons, never
// values. Logic and checks: src/server/staging/predeploy.ts.

import { spawn, spawnSync } from "node:child_process";

import { runPredeployGate, type CommandOutcome } from "@/server/staging/predeploy";

const TIMEOUT_MS = 5 * 60_000;

function installed(tool: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

function runScript(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TIMEOUT_MS,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      resolve({ kind: "missing", what: command });
    });
    child.on("close", (code) => {
      resolve({ kind: "exited", code: code ?? 1, stdout });
    });
  });
}

async function main(): Promise<number> {
  const summary = await runPredeployGate({
    env: process.env,
    sendTestAlert: process.argv.includes("--send-test-alert"),
    run: (name, env) => {
      if (name === "db-environment") {
        if (!installed("psql")) return Promise.resolve({ kind: "missing", what: "psql" });
        const { WANTED: wanted = "staging", ...rest } = env;
        return runScript("bash", ["scripts/ops/db-environment.sh", "assert", wanted], rest);
      }
      if (name === "db-verify") {
        if (!installed("psql")) return Promise.resolve({ kind: "missing", what: "psql" });
        return runScript("bash", ["scripts/ops/db-verify.sh", "--no-row-counts"], env);
      }
      return runScript(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./scripts/video-retention/register.mjs",
          "scripts/creator/preflight.ts",
        ],
        env,
      );
    },
    fetch: async (url, init) => {
      const response = await fetch(url, {
        method: init.method,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, text: await response.text() };
    },
  });
  for (const entry of summary.results) {
    const label = entry.status === "not_run" ? "NOT_RUN" : entry.status.toUpperCase();
    process.stdout.write(`${label.padEnd(8)}${entry.name}: ${entry.detail}\n`);
  }
  const count = (status: string) =>
    summary.results.filter((entry) => entry.status === status).length;
  process.stdout.write(
    `${JSON.stringify({
      status: `STAGING CHECK ${summary.verdict}`,
      pass: count("pass"),
      fail: count("fail"),
      notRun: count("not_run"),
    })}\n`,
  );
  return summary.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `staging check could not run: ${error instanceof Error ? error.name : "unknown error"}\n`,
    );
    process.exitCode = 1;
  },
);
