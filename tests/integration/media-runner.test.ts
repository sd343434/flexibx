// The isolated media runner end to end (Pass 42), with the real runner process and the real
// FFmpeg: a clip is probed, rendered with burned-in subtitles and verified through the
// socket; the policy refuses what the worker never sends; a timeout and an abort kill
// FFmpeg; a runner that is down is "unavailable" (no fallback); and the runner refuses to
// start with a credential in its environment. Every credential here is synthetic.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  probeMedia,
  renderClip,
  verifyRender,
  type MediaTools,
} from "@/server/creator/media/media";
import { createRemoteMediaRun, mediaRunnerReady } from "@/server/creator/media/runner-client";
import { MediaToolError } from "@/server/creator/media/tools";

const SCRIPT = join(process.cwd(), "scripts/creator/media-runner.ts");
const root = mkdtempSync(join(tmpdir(), "mr-"));
const job = join(root, "creator-job-1");
const socket = join(root, ".media-runner", "runner.sock");
const SOURCE = join(job, "source");

/** Only what a runner container gets: no credential of any kind. */
const RUNNER_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  MEDIA_RUNNER_LISTEN: socket,
  MEDIA_RUNNER_WORK_ROOT: root,
  MEDIA_RUNNER_CONCURRENCY: "2",
};

function startRunner(env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT], {
    // Exactly this environment: nothing inherited from the test process.
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { child, output: () => output };
}

async function waitReady(path: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await mediaRunnerReady(path, 500)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runner did not start");
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else
      child.once("exit", (code) => {
        resolve(code);
      });
  });

/** FFmpeg processes whose parent is `pid`. */
function ffmpegChildren(pid: number): string[] {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return Number(fields[1]) === pid && stat.includes("(ffmpeg)");
      } catch {
        return false;
      }
    });
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

let runner: ReturnType<typeof startRunner>;
const remote = createRemoteMediaRun(socket);
const tools: MediaTools = { ffmpeg: "unused", ffprobe: "unused", threads: 1, run: remote };

beforeAll(async () => {
  spawnSync("mkdir", ["-p", job]);
  const made = spawnSync("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine",
    "-t",
    "20",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    "-f",
    "mp4",
    "-y",
    SOURCE,
  ]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  runner = startRunner(RUNNER_ENV);
  await waitReady(socket);
}, 60_000);

afterAll(async () => {
  runner.child.kill("SIGTERM");
  await exited(runner.child);
  rmSync(root, { recursive: true, force: true });
});

describe("the isolated media runner (Pass 42)", () => {
  it("listens on a socket only its own user can open", () => {
    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });

  it("probes, renders with subtitles and verifies a clip through the socket", async () => {
    const info = await probeMedia(tools, SOURCE, { timeoutMs: 30_000, container: "mp4" });
    expect(info).toMatchObject({ hasVideo: true, hasAudio: true, width: 640, height: 360 });
    const output = join(job, "clip.mp4");
    await renderClip(tools, {
      input: SOURCE,
      output,
      workDir: job,
      startMs: 1000,
      endMs: 4000,
      source: { width: 640, height: 360, hasAudio: true },
      aspect: "PORTRAIT_9_16",
      cropX: 50,
      subtitles: [{ startMs: 0, endMs: 2000, text: "نص تجريبي" }],
      maxBytes: 50 * 1024 * 1024,
      container: "mp4",
      timeoutMs: 60_000,
    });
    const verified = await verifyRender(
      tools,
      output,
      { durationMs: 3000, aspect: "PORTRAIT_9_16" },
      { timeoutMs: 30_000 },
    );
    expect(verified).not.toBeNull();
  }, 90_000);

  it("refuses a file outside the work volume, and writes nothing", async () => {
    const out = join(job, "stolen.wav");
    const error = await failure(
      remote(
        "ffmpeg",
        ["-v", "error", "-protocol_whitelist", "file", "-i", "file:/etc/passwd", `file:${out}`],
        { timeoutMs: 10_000 },
      ),
    );
    expect(error).toBeInstanceOf(MediaToolError);
    expect(error).toMatchObject({ code: "failed" });
    expect((error as MediaToolError).detail).toContain("refused by runner: input_outside_work");
    expect(existsSync(out)).toBe(false);
    const network = await failure(
      remote(
        "ffprobe",
        ["-protocol_whitelist", "file", "-i", "http://169.254.169.254/latest/meta-data"],
        { timeoutMs: 10_000 },
      ),
    );
    expect((network as MediaToolError).detail).toContain("refused by runner");
  });

  it("an unreadable customer file fails fast as a failed run, not a runner error", async () => {
    writeFileSync(join(job, "broken"), Buffer.from("not a video at all".repeat(100)));
    const error = await failure(
      probeMedia(tools, join(job, "broken"), { timeoutMs: 30_000, container: "mp4" }),
    );
    expect(error).toMatchObject({ code: "failed" });
  });

  it("kills FFmpeg on a timeout and on an abort", async () => {
    const render = (signal?: AbortSignal, timeoutMs = 60_000) =>
      renderClip(tools, {
        input: SOURCE,
        output: join(job, "slow.mp4"),
        workDir: job,
        startMs: 0,
        endMs: 20_000,
        source: { width: 640, height: 360, hasAudio: true },
        aspect: "LANDSCAPE_16_9",
        cropX: 50,
        subtitles: null,
        maxBytes: 50 * 1024 * 1024,
        container: "mp4",
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    expect(await failure(render(undefined, 30))).toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const running = failure(render(controller.signal));
    for (let i = 0; i < 100 && ffmpegChildren(runner.child.pid ?? 0).length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    expect(await running).toMatchObject({ code: "aborted" });
    // The runner saw the connection close and killed its FFmpeg.
    for (let i = 0; i < 100 && ffmpegChildren(runner.child.pid ?? 0).length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(ffmpegChildren(runner.child.pid ?? 0)).toEqual([]);
    expect(await mediaRunnerReady(socket)).toBe(true);
  }, 90_000);

  it("FFmpeg's environment, and its parent's, carry no credential", async () => {
    // A stand-in binary that prints what FFmpeg would see: its own environment and the
    // runner's (/proc/$PPID/environ) — the read a compromised FFmpeg would try first.
    const probe = join(root, "print-env.sh");
    writeFileSync(probe, "#!/bin/sh\nenv\necho ---\ntr '\\0' '\\n' < /proc/$PPID/environ\n");
    chmodSync(probe, 0o755);
    const sock = join(root, ".media-runner", "env.sock");
    const second = startRunner({
      ...RUNNER_ENV,
      MEDIA_RUNNER_LISTEN: sock,
      CREATOR_FFMPEG_PATH: probe,
    });
    try {
      await waitReady(sock);
      const { stdout } = await createRemoteMediaRun(sock)("ffmpeg", ["-hide_banner", "-version"], {
        timeoutMs: 10_000,
      });
      const names = stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => line.slice(0, line.indexOf("=")));
      expect(names.length).toBeGreaterThan(2);
      for (const name of names) {
        expect(name).toMatch(
          /^(PATH|LC_ALL|PWD|SHLVL|_|NODE_ENV|MEDIA_RUNNER_\w+|CREATOR_FFMPEG_PATH)$/,
        );
      }
    } finally {
      second.child.kill("SIGTERM");
      await exited(second.child);
    }
  }, 60_000);

  it("refuses to start with a credential in its environment, naming it without its value", async () => {
    const value = "synthetic-db-password-7f3a";
    const bad = startRunner({
      ...RUNNER_ENV,
      MEDIA_RUNNER_LISTEN: join(root, ".media-runner", "bad.sock"),
      DATABASE_URL: `postgresql://app:${value}@db/flexibx`,
      AUTH_SECRET: value,
    });
    expect(await exited(bad.child)).toBe(78);
    expect(bad.output()).toContain("DATABASE_URL");
    expect(bad.output()).toContain("AUTH_SECRET");
    expect(bad.output()).not.toContain(value);
    expect(existsSync(join(root, ".media-runner", "bad.sock"))).toBe(false);
  }, 60_000);

  it("a runner that is down is unavailable: the step fails, nothing runs locally", async () => {
    const gone = join(root, ".media-runner", "gone.sock");
    expect(await mediaRunnerReady(gone, 500)).toBe(false);
    const error = await failure(
      probeMedia({ ...tools, run: createRemoteMediaRun(gone) }, SOURCE, { timeoutMs: 5000 }),
    );
    expect(error).toMatchObject({ code: "unavailable" });
  });
});
