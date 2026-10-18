import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { billedMinutes } from "@/server/creator/config";
import { classifyFailure, StepFailure } from "@/server/creator/errors";
import { cuesForClip, reframeCrop, toSrt, toVtt } from "@/server/creator/media/media";
import { containerMatches, sniffContainer } from "@/server/creator/media/sniff";
import { MediaToolError, runMediaTool } from "@/server/creator/media/tools";
import { suggestClips } from "@/server/creator/providers/clip-suggester";
import {
  createSimulatedTranscription,
  createSimulatedTranslation,
} from "@/server/creator/providers/simulated";
import { CreatorProviderError, validateTimedText } from "@/server/creator/providers/types";
import { creatorEnvSchema, EnvValidationError, parseCreatorEnv } from "@/server/env-schema";
import { AppError } from "@/server/errors/app-error";

// Creator Studio pure parts: file recognition, reframe math, subtitle files, the clip
// rules, provider output validation, failure mapping, the simulator's labelling and the
// safety of how FFmpeg-like tools are started.

const bytes = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap((value) =>
      typeof value === "string" ? Array.from(Buffer.from(value, "latin1")) : [value],
    ),
  );

describe("container recognition from the file's own bytes", () => {
  it("recognises the accepted containers and nothing else", () => {
    expect(sniffContainer(bytes(0, 0, 0, 0x18, "ftypisom", 0, 0))).toBe("mp4");
    expect(sniffContainer(bytes(0, 0, 0, 0x14, "ftypqt  ", 0, 0))).toBe("mov");
    expect(sniffContainer(bytes(0, 0, 0, 0x20, "ftypM4A ", 0, 0))).toBe("m4a");
    expect(sniffContainer(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0))).toBe("webm");
    expect(sniffContainer(bytes("RIFF", 0, 0, 0, 0, "WAVE"))).toBe("wav");
    expect(sniffContainer(bytes("ID3", 4, 0))).toBe("mp3");
    expect(sniffContainer(bytes(0xff, 0xfb, 0x90))).toBe("mp3");
    expect(sniffContainer(bytes("#!/bin/sh\necho"))).toBeNull();
    expect(sniffContainer(bytes(0x89, "PNG\r\n"))).toBeNull();
    expect(sniffContainer(new Uint8Array())).toBeNull();
  });

  it("the header must match the family declared at upload start", () => {
    expect(containerMatches("video/mp4", "mov")).toBe(true);
    expect(containerMatches("video/mp4", "webm")).toBe(false);
    expect(containerMatches("audio/wav", "mp4")).toBe(false);
    expect(containerMatches("audio/mp4", "m4a")).toBe(true);
  });
});

describe("reframe crop (fixed and adjustable — no tracking)", () => {
  it("cuts the widest window of the target ratio, moved by the focus", () => {
    expect(reframeCrop(1920, 1080, "PORTRAIT_9_16", 50)).toEqual({
      width: 606,
      height: 1080,
      x: 657,
      y: 0,
    });
    expect(reframeCrop(1920, 1080, "PORTRAIT_9_16", 0).x).toBe(0);
    expect(reframeCrop(1920, 1080, "PORTRAIT_9_16", 100).x).toBe(1314);
    expect(reframeCrop(1920, 1080, "SQUARE_1_1", 50)).toEqual({
      width: 1080,
      height: 1080,
      x: 420,
      y: 0,
    });
    // A tall source going landscape is centred vertically.
    expect(reframeCrop(1080, 1920, "LANDSCAPE_16_9", 50)).toEqual({
      width: 1080,
      height: 606,
      x: 0,
      y: 657,
    });
    // Out-of-range focus is clamped; sizes stay even (H.264).
    const crop = reframeCrop(641, 361, "PORTRAIT_9_16", 250);
    expect(crop.width % 2).toBe(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(641);
  });
});

describe("subtitle files", () => {
  const cues = [
    { startMs: 0, endMs: 1500, text: "مرحبا\nبكم" },
    { startMs: 61_250, endMs: 3_725_004, text: "<b>{\\an8}</b> hi" },
  ];
  it("writes SubRip and WebVTT without interpreting markup", () => {
    const srt = toSrt(cues);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nمرحبا بكم\n\n2\n00:01:01,250 --> 01:02:05,004\nban8/b hi\n",
    );
    expect(toVtt(cues)).toMatch(/^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:01\.500/);
  });
  it("re-times the cues inside a clip from zero", () => {
    expect(
      cuesForClip(
        [
          { startMs: 0, endMs: 5000, text: "a" },
          { startMs: 5000, endMs: 9000, text: "b" },
          { startMs: 9000, endMs: 12000, text: "c" },
        ],
        4000,
        10_000,
      ),
    ).toEqual([
      { startMs: 0, endMs: 1000, text: "a" },
      { startMs: 1000, endMs: 5000, text: "b" },
      { startMs: 5000, endMs: 6000, text: "c" },
    ]);
  });
});

describe("rule-based clip suggestions (text and timestamps only)", () => {
  const segments = Array.from({ length: 20 }, (_, i) => ({
    startMs: i * 6000,
    endMs: (i + 1) * 6000,
    text:
      i === 10
        ? "Why does this work? Here are 3 steps!"
        : `Plain sentence ${String.fromCharCode(97 + i)}`,
  }));
  it("suggests non-overlapping clips of 15–60 s, best signals first, with reasons", () => {
    const clips = suggestClips(segments);
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.length).toBeLessThanOrEqual(5);
    for (const clip of clips) {
      expect(clip.endMs - clip.startMs).toBeGreaterThanOrEqual(15_000);
      expect(clip.endMs - clip.startMs).toBeLessThanOrEqual(60_000);
      expect(clip.score).toBeGreaterThanOrEqual(0);
      expect(clip.score).toBeLessThanOrEqual(100);
    }
    for (let i = 1; i < clips.length; i += 1) {
      expect(clips[i]?.startMs).toBeGreaterThanOrEqual(clips[i - 1]?.endMs ?? 0);
    }
    const best = [...clips].sort((a, b) => b.score - a.score)[0];
    expect(best?.reasons).toEqual(
      expect.arrayContaining(["question", "number", "exclamation", "hook_word"]),
    );
    expect(best?.text).toContain("Why does this work?");
  });
  it("suggests nothing from media shorter than a clip", () => {
    expect(suggestClips([{ startMs: 0, endMs: 5000, text: "Why?" }])).toEqual([]);
  });
});

describe("provider output is validated before anything is stored", () => {
  it("accepts ordered cues inside the media and refuses the rest", () => {
    expect(validateTimedText([{ startMs: 0, endMs: 1200, text: " ok " }], 1000)).toEqual([
      { startMs: 0, endMs: 1000, text: "ok" },
    ]);
    const bad = [
      [{ startMs: 500, endMs: 400, text: "x" }],
      [{ startMs: 0, endMs: 9000, text: "x" }],
      [{ startMs: 0, endMs: 100, text: "  " }],
      [
        { startMs: 0, endMs: 500, text: "a" },
        { startMs: 100, endMs: 600, text: "b" },
      ],
    ];
    for (const segments of bad) {
      expect(() => validateTimedText(segments, 1000)).toThrow(CreatorProviderError);
    }
  });
});

describe("failure mapping", () => {
  it("maps errors to stored codes, never messages", () => {
    expect(classifyFailure(new StepFailure("too_long", false), false)).toMatchObject({
      failure: "too_long",
      retryable: false,
    });
    expect(classifyFailure(new Error("x"), true)).toMatchObject({
      failure: "step_timeout",
      retryable: true,
    });
    expect(classifyFailure(new CreatorProviderError("quota_exceeded", false), false)).toMatchObject(
      { failure: "provider_quota" },
    );
    expect(classifyFailure(new MediaToolError("timeout"), false)).toMatchObject({
      failure: "step_timeout",
    });
    expect(classifyFailure(new MediaToolError("failed", 1, "boom"), false)).toMatchObject({
      failure: "ffmpeg_failed",
      retryable: false,
    });
    const short = new AppError("CONFLICT", {
      fields: [{ path: "credits", code: "credits_insufficient" }],
    });
    expect(classifyFailure(short, false)).toMatchObject({
      failure: "credits_insufficient",
      retryable: false,
    });
    expect(classifyFailure(new TypeError("?"), false)).toMatchObject({
      failure: "internal_error",
      retryable: true,
    });
  });
  it("bills started minutes", () => {
    expect([billedMinutes(1), billedMinutes(60_000), billedMinutes(60_001)]).toEqual([1, 1, 2]);
  });
});

describe("the simulator never passes for a real provider", () => {
  it("is marked simulated and every line says so; timestamps follow the duration", async () => {
    const provider = createSimulatedTranscription();
    expect(provider.simulated).toBe(true);
    expect(provider.id).toBe("simulated");
    const result = await provider.transcribe({
      audioPath: "/dev/null",
      durationMs: 20_000,
      languageHint: "en",
      signal: new AbortController().signal,
    });
    expect(result.segments.at(-1)?.endMs).toBe(20_000);
    expect(result.segments.every((s) => s.text.startsWith("Simulated line"))).toBe(true);
    const translated = await createSimulatedTranslation().translate({
      segments: result.segments,
      from: "en",
      to: "ar",
      signal: new AbortController().signal,
    });
    expect(translated.every((s) => s.text.startsWith("[simulated ar]"))).toBe(true);
  });
  it("is refused in production", () => {
    const production = { NODE_ENV: "production", APP_URL: "https://app.example.com" };
    expect(() => parseCreatorEnv({ ...production, CREATOR_AI_PROVIDER: "simulated" })).toThrow(
      EnvValidationError,
    );
    // The opt-in of the local end-to-end run is not honoured for a real host.
    expect(() =>
      parseCreatorEnv({
        ...production,
        CREATOR_AI_PROVIDER: "simulated",
        FLEXIBX_TEST_PROVIDERS: "allow",
      }),
    ).toThrow(EnvValidationError);
    expect(
      parseCreatorEnv({
        NODE_ENV: "production",
        APP_URL: "http://127.0.0.1:3100",
        CREATOR_AI_PROVIDER: "simulated",
        FLEXIBX_TEST_PROVIDERS: "allow",
      }).CREATOR_AI_PROVIDER,
    ).toBe("simulated");
    expect(creatorEnvSchema.parse({ NODE_ENV: "production" }).CREATOR_AI_PROVIDER).toBe("disabled");
    expect(creatorEnvSchema.safeParse({ CREATOR_MAX_UPLOAD_MB: "501" }).success).toBe(false);
  });
});

describe("starting media tools safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "creator-unit-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never goes through a shell: metacharacters stay plain text", async () => {
    const marker = join(dir, "pwned");
    const { stdout } = await runMediaTool("echo", [`$(touch ${marker})`, ";", `touch ${marker}`], {
      timeoutMs: 5000,
    });
    expect(stdout).toContain("$(touch");
    expect(existsSync(marker)).toBe(false);
  });

  it("passes no secrets to the child process", async () => {
    process.env.DATABASE_URL_FOR_LEAK_TEST = "postgresql://user:secret@host/db";
    try {
      const { stdout } = await runMediaTool("env", [], { timeoutMs: 5000 });
      expect(stdout).not.toContain("secret");
      expect(
        stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")[0])
          .sort(),
      ).toEqual(["LC_ALL", "PATH"]);
    } finally {
      delete process.env.DATABASE_URL_FOR_LEAK_TEST;
    }
  });

  it("kills a run that outlives its timeout or is aborted", async () => {
    const started = Date.now();
    await expect(runMediaTool("sleep", ["30"], { timeoutMs: 200 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(5000);
    const controller = new AbortController();
    const run = runMediaTool("sleep", ["30"], { timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 100);
    await expect(run).rejects.toMatchObject({ code: "aborted" });
  });

  it("reports a missing binary, a failing exit and oversized output by code", async () => {
    await expect(
      runMediaTool("/nonexistent/ffmpeg", [], { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(runMediaTool("false", [], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "failed",
      exitCode: 1,
    });
    await expect(
      runMediaTool("yes", [], { timeoutMs: 5000, maxStdoutBytes: 1000 }),
    ).rejects.toMatchObject({ code: "failed" });
  });
});
