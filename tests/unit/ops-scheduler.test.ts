// scripts/ops/scheduler.ts (Pass 13): the single-host scheduler calls the app's protected
// internal endpoints with their own bearer secrets, skips an endpoint whose secret is not
// set, never logs a secret, refuses to start without the app's address or with a too short
// interval, and stops on SIGTERM. Runs the real script against a local HTTP server.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Each test starts the real script (`node --import tsx`), which may wait up to RUN_DEADLINE_MS.
vi.setConfig({ testTimeout: 40_000 });

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/ops/scheduler.ts");
// Test values, built from parts so secret scanners do not take them for real keys.
const TICK_SECRET = ["tick", "test", "bearer", "value"].join("-");
const RETENTION_SECRET = ["retention", "test", "bearer", "value"].join("-");

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function app(status = 200) {
  const calls: { path: string; method: string; auth: string | undefined }[] = [];
  server = createServer((req, res) => {
    calls.push({ path: req.url ?? "", method: req.method ?? "", auth: req.headers.authorization });
    res.writeHead(status).end('{"secret":"response bodies are never logged"}');
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, calls };
}

/** Upper bound for one scheduler run; a cold `node --import tsx` start can take seconds. */
const RUN_DEADLINE_MS = 30_000;
/** After the expected output appears, how long to keep running (catches extra calls). */
const SETTLE_MS = 500;

/**
 * Runs the scheduler until its output shows `done` (then SETTLE_MS more, then SIGTERM),
 * until it exits by itself, or until RUN_DEADLINE_MS — not for a fixed time, which a slow
 * start can use up before the first call is made.
 */
function run(env: Record<string, string>, done: (out: string) => boolean = () => false) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      ["--import", "tsx", SCRIPT],
      {
        cwd: ROOT,
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    let settle: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (settle === undefined && done(out)) {
        settle = setTimeout(() => child.kill("SIGTERM"), SETTLE_MS);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const deadline = setTimeout(() => child.kill("SIGTERM"), RUN_DEADLINE_MS);
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(settle);
      resolve({ code, out, err });
    });
  });
}

describe("ops scheduler", () => {
  it("calls the tick and the retention endpoints with their own secrets, then stops on SIGTERM", async () => {
    const { url, calls } = await app();
    const result = await run(
      {
        SCHEDULER_APP_URL: url,
        AUTOMATION_CRON_SECRET: TICK_SECRET,
        VIDEO_RETENTION_CRON_SECRET: RETENTION_SECRET,
      },
      (out) => out.split('"status":200').length - 1 >= 2,
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        { path: "/api/internal/automation-tick", method: "POST", auth: `Bearer ${TICK_SECRET}` },
        {
          path: "/api/internal/video-retention",
          method: "POST",
          auth: `Bearer ${RETENTION_SECRET}`,
        },
      ]),
    );
    expect(calls).toHaveLength(2); // the next round is one interval (120 s) away
    expect(result.code).toBe(0);
    const lines = result.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.status === 200)).toHaveLength(2);
    expect(lines.at(-1)).toMatchObject({ msg: "scheduler stopped", signal: "SIGTERM" });
    expect(result.out).not.toContain(TICK_SECRET);
    expect(result.out).not.toContain(RETENTION_SECRET);
    expect(result.out).not.toContain("response bodies");
  });

  it("skips an endpoint whose secret is not set, and logs a refused call as a warning", async () => {
    const { url, calls } = await app(404);
    const result = await run(
      { SCHEDULER_APP_URL: url, AUTOMATION_CRON_SECRET: TICK_SECRET },
      (out) => out.includes('"status":404'),
    );
    expect(calls.map((call) => call.path)).toEqual(["/api/internal/automation-tick"]);
    expect(result.out).toContain('"msg":"secret not set: endpoint not scheduled"');
    expect(result.out).toContain(
      '"level":"warn","endpoint":"/api/internal/automation-tick","status":404',
    );
  });

  it("refuses to start without the app's address or with an interval under a minute", async () => {
    const missing = await run({ AUTOMATION_CRON_SECRET: TICK_SECRET });
    expect(missing.code).toBe(64);
    expect(missing.err).toContain("SCHEDULER_APP_URL is not set");
    const { url } = await app();
    const fast = await run({
      SCHEDULER_APP_URL: url,
      AUTOMATION_CRON_SECRET: TICK_SECRET,
      SCHEDULER_TICK_SECONDS: "5",
    });
    expect(fast.code).toBe(64);
    expect(fast.out).toContain("interval must be at least 60 s");
  });
});
