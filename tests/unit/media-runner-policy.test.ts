// Pass 42: the isolated media runner's argument policy, its refusal of credentials in its
// own environment, and the worker side's refusal to run FFmpeg locally once a runner is
// configured (no fallback).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyFailure } from "@/server/creator/errors";
import {
  encodeAudioPiece,
  extractAudio,
  probeMedia,
  renderClip,
  type MediaTools,
} from "@/server/creator/media/media";
import { mediaIsolationProblem, sensitiveEnvNames } from "@/server/creator/media/runner-env";
import {
  mediaPolicyViolation,
  mediaRunRequestSchema,
  type MediaRunRequest,
} from "@/server/creator/media/runner-protocol";
import { MediaToolError, runMediaTool } from "@/server/creator/media/tools";

const ROOT = "/work";
const JOB = "/work/creator-job-1";

const req = (args: string[], extra: Partial<MediaRunRequest> = {}): MediaRunRequest => ({
  tool: "ffmpeg",
  args,
  timeoutMs: 1000,
  ...extra,
});
const violation = (args: string[], extra: Partial<MediaRunRequest> = {}) =>
  mediaPolicyViolation(req(args, extra), ROOT);

/** Every command the worker really builds, captured from media.ts through `tools.run`. */
async function workerCommands(): Promise<MediaRunRequest[]> {
  const seen: MediaRunRequest[] = [];
  const probeJson = JSON.stringify({
    format: { format_name: "mov", duration: "1.0" },
    streams: [],
  });
  const tools: MediaTools = {
    ffmpeg: "unused",
    ffprobe: "unused",
    threads: 2,
    run: (tool, args, options) => {
      seen.push({
        tool,
        args: [...args],
        timeoutMs: options.timeoutMs,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      return Promise.resolve({ stdout: tool === "ffprobe" ? probeJson : "" });
    },
  };
  const scratch = mkdtempSync(join(tmpdir(), "policy-"));
  try {
    await probeMedia(tools, `${JOB}/source`, { timeoutMs: 1000, container: "mp4" });
    await probeMedia(tools, `${JOB}/clip.mp4`, { timeoutMs: 1000 });
    for (const container of ["mp4", "mov", "m4a", "webm", "mp3", "wav"] as const) {
      await extractAudio(tools, `${JOB}/source`, `${JOB}/audio.wav`, {
        timeoutMs: 1000,
        container,
      });
    }
    await encodeAudioPiece(
      tools,
      `${JOB}/audio.wav`,
      `${JOB}/piece-0.ogg`,
      { startMs: 600_000, durationMs: 600_000 },
      { timeoutMs: 1000 },
    );
    for (const subtitles of [null, [{ startMs: 0, endMs: 900, text: "مرحبا" }]]) {
      for (const aspect of ["PORTRAIT_9_16", "LANDSCAPE_16_9", "SQUARE_1_1"] as const) {
        await renderClip(tools, {
          input: `${JOB}/source`,
          output: `${JOB}/clip.mp4`,
          // renderClip writes subtitles.srt into workDir itself: a real directory here.
          workDir: scratch,
          startMs: 1500,
          endMs: 31_500,
          source: { width: 1920, height: 1080, hasAudio: subtitles === null },
          aspect,
          cropX: 37,
          subtitles,
          maxBytes: 524_288_000,
          container: "webm",
          timeoutMs: 1000,
        });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // The renders ran in a scratch directory outside /work: check them as if in the job's.
  return seen.map((entry) => (entry.cwd === undefined ? entry : { ...entry, cwd: JOB }));
}

describe("media runner policy (Pass 42)", () => {
  it("accepts every command the worker builds, and the preflight's build queries", async () => {
    const commands = await workerCommands();
    expect(commands).toHaveLength(15);
    for (const command of commands) {
      expect(mediaRunRequestSchema.safeParse(command).success).toBe(true);
      expect({ args: command.args, violation: mediaPolicyViolation(command, ROOT) }).toEqual({
        args: command.args,
        violation: null,
      });
    }
    for (const info of ["-version", "-encoders", "-filters"]) {
      expect(violation(["-hide_banner", info])).toBeNull();
    }
  });

  const base = ["-v", "error", "-protocol_whitelist", "file"];
  const input = ["-i", `file:${JOB}/source`];
  const out = `file:${JOB}/out.wav`;

  it.each([
    ["no protocol whitelist", ["-v", "error", ...input, out], "protocol_whitelist"],
    [
      "a second whitelist",
      [...base, "-protocol_whitelist", "file", ...input, out],
      "protocol_whitelist",
    ],
    [
      "a network whitelist",
      ["-protocol_whitelist", "file,http,tcp", ...input, out],
      "value:-protocol_whitelist",
    ],
    [
      "lavfi input format",
      [...base, "-f", "lavfi", "-i", "movie=/proc/1/environ", out],
      "value:-f",
    ],
    ["concat demuxer", [...base, "-f", "concat", ...input, out], "value:-f"],
    ["hls demuxer", [...base, "-f", "hls", ...input, out], "value:-f"],
    [
      "an input outside the work volume",
      [...base, "-i", "file:/etc/passwd", out],
      "input_outside_work",
    ],
    ["/proc as input", [...base, "-i", "file:/proc/self/environ", out], "input_outside_work"],
    ["a .. escape", [...base, "-i", "file:/work/../etc/shadow", out], "input_outside_work"],
    ["the work root itself", [...base, "-i", "file:/work", out], "input_outside_work"],
    ["a relative input", [...base, "-i", "file:source", out], "input_outside_work"],
    ["a bare path input", [...base, "-i", `${JOB}/source`, out], "input_outside_work"],
    [
      "an http input",
      [...base, "-i", "http://169.254.169.254/latest/meta-data", out],
      "input_outside_work",
    ],
    ["a pipe input", [...base, "-i", "pipe:0", out], "input_outside_work"],
    ["a data: URI", [...base, "-i", "data:text/plain,hi", out], "input_outside_work"],
    ["a concat: protocol", [...base, "-i", `concat:${JOB}/a|${JOB}/b`, out], "input_outside_work"],
    ["an output outside the volume", [...base, ...input, "file:/tmp/out.wav"], "path_outside_work"],
    ["an output to a device", [...base, ...input, "file:/dev/tcp"], "path_outside_work"],
    ["an output URL", [...base, ...input, "tcp://10.0.0.1:9000"], "path_outside_work"],
    ["a bare output path", [...base, ...input, `${JOB}/out.wav`], "path_outside_work"],
    [
      "filter_complex",
      [...base, ...input, "-filter_complex", "amovie=/etc/passwd", out],
      "option:-filter_complex",
    ],
    ["a movie filter", [...base, ...input, "-vf", "movie=/proc/1/environ", out], "value:-vf"],
    [
      "subtitles from another file",
      [
        ...base,
        ...input,
        "-vf",
        "crop=2:2:0:0,scale=2:2,setsar=1,subtitles=filename=/etc/passwd",
        out,
      ],
      "value:-vf",
    ],
    ["an audio filter", [...base, ...input, "-af", "amovie=/etc/passwd", out], "option:-af"],
    [
      "dump_attachment",
      [...base, "-dump_attachment:t", "", ...input, out],
      "option:-dump_attachment:t",
    ],
    ["an unknown codec", [...base, ...input, "-c:a", "copy", out], "value:-c:a"],
    ["a value-less option at the end", [...base, ...input, "-ss"], "value:-ss"],
    ["a non-numeric seek", [...base, "-ss", "1;rm", ...input, out], "value:-ss"],
    ["an info query with an input", ["-hide_banner", "-version", ...input], "option:-version"],
  ])("refuses %s", (_name, args, expected) => {
    expect(violation(args)).toBe(expected);
  });

  it("refuses a working directory outside the volume", () => {
    expect(violation([...base, ...input, out], { cwd: "/" })).toBe("cwd_outside_work");
    expect(violation([...base, ...input, out], { cwd: "/work/../root" })).toBe("cwd_outside_work");
    expect(violation(["-hide_banner", "-version"], { cwd: JOB })).toBe("cwd_outside_work");
    expect(violation([...base, ...input, out], { cwd: JOB })).toBeNull();
  });

  it("refuses malformed requests at the schema", () => {
    expect(mediaRunRequestSchema.safeParse({ ...req(["-version"]), tool: "sh" }).success).toBe(
      false,
    );
    expect(mediaRunRequestSchema.safeParse(req(["-i", "file:/work/a\0b"])).success).toBe(false);
    expect(mediaRunRequestSchema.safeParse({ ...req(["x"]), env: { A: "1" } }).success).toBe(false);
    expect(mediaRunRequestSchema.safeParse(req([])).success).toBe(false);
    expect(mediaRunRequestSchema.safeParse({ ...req(["x"]), timeoutMs: 0 }).success).toBe(false);
  });
});

describe("media runner environment (Pass 42)", () => {
  it("names every credential-looking variable, never its value", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/node",
      NODE_ENV: "production",
      LC_ALL: "C.UTF-8",
      MEDIA_RUNNER_LISTEN: "/work/.media-runner/runner.sock",
      MEDIA_RUNNER_WORK_ROOT: "/work",
      CREATOR_FFMPEG_THREADS: "2",
      DATABASE_URL: "postgresql://synthetic:synthetic@db/x",
      OWNER_DATABASE_URL: "postgresql://synthetic",
      AUTH_SECRET: "synthetic-secret",
      ENCRYPTION_KEY: "synthetic-key",
      S3_ACCESS_KEY_ID: "synthetic",
      S3_SECRET_ACCESS_KEY: "synthetic",
      VIDEO_RETENTION_CRON_SECRET: "synthetic",
      AUTOMATION_CRON_SECRET: "synthetic",
      OPS_STATUS_SECRET: "synthetic",
      OPENAI_API_KEY: "synthetic",
      RESEND_API_KEY: "synthetic",
      PGPASSWORD: "synthetic",
      ALERT_WEBHOOK_URL: "https://synthetic.invalid",
      EMPTY_SECRET: "",
    };
    const names = sensitiveEnvNames(env);
    expect(names).toEqual([
      "ALERT_WEBHOOK_URL",
      "AUTH_SECRET",
      "AUTOMATION_CRON_SECRET",
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "OPENAI_API_KEY",
      "OPS_STATUS_SECRET",
      "OWNER_DATABASE_URL",
      "PGPASSWORD",
      "RESEND_API_KEY",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "VIDEO_RETENTION_CRON_SECRET",
    ]);
    expect(JSON.stringify(names)).not.toContain("synthetic");
  });

  it("a production worker without the runner is refused; development is not", () => {
    expect(mediaIsolationProblem({ NODE_ENV: "production" })).toMatch(
      /CREATOR_MEDIA_RUNNER_SOCKET/,
    );
    expect(
      mediaIsolationProblem({ NODE_ENV: "production", CREATOR_MEDIA_RUNNER_SOCKET: "" }),
    ).not.toBeNull();
    expect(
      mediaIsolationProblem({
        NODE_ENV: "production",
        CREATOR_MEDIA_RUNNER_SOCKET: "/work/.media-runner/runner.sock",
      }),
    ).toBeNull();
    expect(mediaIsolationProblem({ NODE_ENV: "development" })).toBeNull();
  });
});

describe("no local fallback once a runner is configured (Pass 42)", () => {
  const saved = process.env.CREATOR_MEDIA_RUNNER_SOCKET;
  afterEach(() => {
    if (saved === undefined) delete process.env.CREATOR_MEDIA_RUNNER_SOCKET;
    else process.env.CREATOR_MEDIA_RUNNER_SOCKET = saved;
  });

  it("refuses to start a local process, and nothing runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-fallback-"));
    const marker = join(dir, "ran");
    process.env.CREATOR_MEDIA_RUNNER_SOCKET = "/work/.media-runner/runner.sock";
    try {
      const error = await runMediaTool("touch", [marker], { timeoutMs: 5000 }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(MediaToolError);
      expect(error).toMatchObject({ code: "unavailable" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unavailable runner is a retryable step failure, not a customer-file error", () => {
    const failure = classifyFailure(new MediaToolError("unavailable"), false);
    expect(failure).toMatchObject({ failure: "ffmpeg_failed", retryable: true });
  });
});
