// The `pnpm video:retention` CLI, as a real child process on the test database: it must
// close its database pools when it finishes, whether the run succeeds or fails. An open
// pool keeps the process alive until its idle connections time out (10 s in pg-pool).
import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system } = createTestDb();
const ROOT = resolve(__dirname, "../..");
const IDLE_TIMEOUT_MS = 10_000;

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

/** Runs the CLI exactly as `pnpm video:retention` does, against the test database. */
function runCli(env: Record<string, string>) {
  const startedAt = performance.now();
  return new Promise<{ code: number | null; elapsedMs: number }>((done) => {
    execFile(
      resolve(ROOT, "node_modules/.bin/tsx"),
      [
        "--env-file-if-exists=.env",
        "--import",
        "./scripts/video-retention/register.mjs",
        "scripts/video-retention/run.ts",
      ],
      {
        cwd: ROOT,
        timeout: 30_000,
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? "",
          NODE_ENV: "test",
          STORAGE_DRIVER: "test-memory",
          AUTH_SECRET: "video-retention-cli-test-auth-secret-0123456789",
          LOG_LEVEL: "silent",
          ...env,
        },
      },
      (error) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        done({ code, elapsedMs: performance.now() - startedAt });
      },
    );
  });
}

describe("video retention CLI", () => {
  it("runs the job and exits promptly: its database pools are closed", async () => {
    const ctx = await createTenant(system);
    const video = await system.generatedVideo.create({
      data: {
        workspaceId: ctx.workspaceId,
        title: "Expired",
        provider: "fake",
        durationSeconds: 4,
        width: 1,
        height: 1,
        succeededAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
    });
    const { code, elapsedMs } = await runCli({});
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(IDLE_TIMEOUT_MS - 2_000);
    expect(
      (await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } })).status,
    ).toBe("DELETED");
  });

  it("also closes them when the run fails after the pool was opened", async () => {
    // Invalid mail settings: the run takes the lock (opening the retention pool), then
    // fails when it builds its mailer inside the lock.
    const { code, elapsedMs } = await runCli({ MAIL_TRANSPORT: "not-a-transport" });
    expect(code).toBe(1);
    expect(elapsedMs).toBeLessThan(IDLE_TIMEOUT_MS - 2_000);
  });
});
