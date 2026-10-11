import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FakeVideoProvider } from "@/server/ai/providers/video/fake";
import { VideoProviderError, type VideoSubmitRequest } from "@/server/ai/providers/video/gateway";
import { parseVideoEnv } from "@/server/env-schema";
import {
  attemptCharge,
  costMicros,
  FAKE_VIDEO_RATE_CARD,
  ledgerPeriod,
  reservationMicros,
} from "@/server/videos/generation/budget";
import {
  buildMp4,
  expectedDimensions,
  inspectMp4,
  validateClip,
} from "@/server/videos/generation/mp4";
import {
  ATTEMPT_TRANSITIONS,
  assertAttemptTransition,
  assertJobTransition,
  canTransitionAttempt,
  canTransitionJob,
  IllegalTransitionError,
  JOB_TRANSITIONS,
} from "@/server/videos/generation/states";

// Generative video core, pure parts: clip validation, state machine, cost rules, the
// deterministic fake provider and its configuration.

const SPEC = { durationSeconds: 8, aspectRatio: "16:9", resolution: "720p", audio: false } as const;
const clip = (overrides: Partial<Parameters<typeof buildMp4>[0]> = {}) =>
  buildMp4({ ...expectedDimensions(SPEC), durationSeconds: 8, audio: false, ...overrides });

describe("MP4 validation", () => {
  it("accepts a clip of exactly the requested shape and reads its structure", () => {
    const bytes = clip();
    expect(validateClip(bytes, SPEC)).toBeNull();
    expect(inspectMp4(bytes)).toMatchObject({
      durationSeconds: 8,
      video: { codec: "h264", width: 1280, height: 720 },
      audioTracks: 0,
      emptyTracks: 0,
    });
    expect(validateClip(clip({ codec: "hvc1" }), SPEC)).toBeNull();
    const portrait = { ...SPEC, aspectRatio: "9:16", resolution: "1080p", audio: true } as const;
    expect(
      validateClip(
        buildMp4({ ...expectedDimensions(portrait), durationSeconds: 8, audio: true }),
        portrait,
      ),
    ).toBeNull();
  });

  it("tolerates ±0.5 s and nothing more", () => {
    expect(validateClip(clip({ durationSeconds: 8.5 }), SPEC)).toBeNull();
    expect(validateClip(clip({ durationSeconds: 7.5 }), SPEC)).toBeNull();
    expect(validateClip(clip({ durationSeconds: 8.6 }), SPEC)).toBe("duration_mismatch");
    expect(validateClip(clip({ durationSeconds: 7.4 }), SPEC)).toBe("duration_mismatch");
  });

  it("names the first problem of a wrong clip", () => {
    expect(validateClip(clip({ width: 1920, height: 1080 }), SPEC)).toBe("resolution_mismatch");
    expect(validateClip(clip({ width: 720, height: 1280 }), SPEC)).toBe("resolution_mismatch");
    expect(validateClip(clip({ audio: true }), SPEC)).toBe("audio_mismatch");
    expect(validateClip(clip(), { ...SPEC, audio: true })).toBe("audio_mismatch");
    expect(validateClip(clip({ codec: "mp4v" }), SPEC)).toBe("unsupported_codec");
    expect(validateClip(clip({ frames: 0 }), SPEC)).toBe("empty_stream");
  });

  it("rejects bytes that are not a readable MP4", () => {
    expect(validateClip(new TextEncoder().encode("not a video"), SPEC)).toBe("corrupt");
    expect(validateClip(new Uint8Array(), SPEC)).toBe("not_mp4");
    const bytes = clip();
    expect(validateClip(bytes.subarray(0, bytes.length - 100), SPEC)).toBe("corrupt");
    const wrongBrand = clip();
    wrongBrand.set(new TextEncoder().encode("qt  "), 8);
    wrongBrand.set(new TextEncoder().encode("qt  qt  qt  qt  "), 16);
    expect(validateClip(wrongBrand, SPEC)).toBe("not_mp4");
  });

  it("is deterministic", () => {
    expect(clip()).toEqual(clip());
    expect(clip({ seed: 2 })).not.toEqual(clip({ seed: 3 }));
  });
});

describe("state machine", () => {
  it("allows the documented paths and staying in place", () => {
    for (const [from, to] of [
      ["RESERVED", "IN_PROGRESS"],
      ["IN_PROGRESS", "READY_FOR_REVIEW"],
      ["READY_FOR_REVIEW", "ACCEPTED"],
      ["IN_PROGRESS", "NEEDS_RECONCILIATION"],
      ["NEEDS_RECONCILIATION", "IN_PROGRESS"],
      ["IN_PROGRESS", "IN_PROGRESS"],
    ] as const) {
      expect(canTransitionJob(from, to), `${from}->${to}`).toBe(true);
    }
    for (const [from, to] of [
      ["INTENDED", "SUBMITTED"],
      ["INTENDED", "OUTCOME_UNKNOWN"],
      ["OUTCOME_UNKNOWN", "SUBMITTED"],
      ["SUBMITTED", "OUTPUT_READY"],
      ["OUTPUT_READY", "VALIDATED"],
    ] as const) {
      expect(canTransitionAttempt(from, to), `${from}->${to}`).toBe(true);
    }
  });

  it("refuses everything else, including leaving terminal states", () => {
    expect(() => {
      assertJobTransition("READY_FOR_REVIEW", "IN_PROGRESS");
    }).toThrow(IllegalTransitionError);
    expect(() => {
      assertJobTransition("FAILED", "IN_PROGRESS");
    }).toThrow(IllegalTransitionError);
    expect(() => {
      assertJobTransition("RESERVED", "READY_FOR_REVIEW");
    }).toThrow(IllegalTransitionError);
    // An unknown outcome is never released by skipping reconciliation.
    expect(() => {
      assertJobTransition("NEEDS_RECONCILIATION", "CANCELLED");
    }).toThrow();
    // A submission that may have been accepted is never resubmitted as INTENDED.
    expect(() => {
      assertAttemptTransition("OUTCOME_UNKNOWN", "INTENDED");
    }).toThrow();
    expect(() => {
      assertAttemptTransition("INTENDED", "OUTPUT_READY");
    }).toThrow();
    expect(() => {
      assertAttemptTransition("VALIDATED", "FAILED_RETRYABLE");
    }).toThrow();
    for (const terminal of [
      "ACCEPTED",
      "REJECTED",
      "FAILED",
      "LIMIT_REACHED",
      "CANCELLED",
    ] as const) {
      expect(JOB_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("matches the database triggers exactly", () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20261010110000_video_generation_core/migration.sql"),
      "utf8",
    );
    const pairsOf = (fn: string) => {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION "${fn}"`));
      const list = body.slice(body.indexOf("IN ("), body.indexOf(") THEN"));
      return [...list.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)]
        .map((match) => `${match[1] ?? ""}->${match[2] ?? ""}`)
        .sort();
    };
    const pairs = (table: Readonly<Record<string, readonly string[]>>) =>
      Object.entries(table)
        .flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`))
        .sort();
    expect(pairsOf("video_job_transition_trigger")).toEqual(pairs(JOB_TRANSITIONS));
    expect(pairsOf("video_attempt_transition_trigger")).toEqual(pairs(ATTEMPT_TRANSITIONS));
  });
});

describe("cost rules", () => {
  it("reserves the worst case: every attempt billed for the full clip", () => {
    expect(costMicros(FAKE_VIDEO_RATE_CARD, "DRAFT", 8)).toBe(400_000n);
    expect(reservationMicros(FAKE_VIDEO_RATE_CARD, "DRAFT", { durationSeconds: 8 }, 2)).toBe(
      800_000n,
    );
    expect(reservationMicros(FAKE_VIDEO_RATE_CARD, "STANDARD", { durationSeconds: 6 }, 2)).toBe(
      1_800_000n,
    );
    expect(() => costMicros(FAKE_VIDEO_RATE_CARD, "DRAFT", 1.5)).toThrow(RangeError);
  });

  it("charges reported seconds, else the flagged estimate, never above what is left", () => {
    expect(attemptCharge(FAKE_VIDEO_RATE_CARD, "DRAFT", 8, 8, 800_000n)).toEqual({
      micros: 400_000n,
      estimated: false,
    });
    expect(attemptCharge(FAKE_VIDEO_RATE_CARD, "DRAFT", 8, 0, 800_000n)).toEqual({
      micros: 0n,
      estimated: false,
    });
    expect(attemptCharge(FAKE_VIDEO_RATE_CARD, "DRAFT", 8, null, 800_000n)).toEqual({
      micros: 400_000n,
      estimated: true,
    });
    expect(attemptCharge(FAKE_VIDEO_RATE_CARD, "DRAFT", 8, 8, 100_000n).micros).toBe(100_000n);
  });

  it("counts a job against the UTC day of its reservation", () => {
    expect(ledgerPeriod(new Date("2026-10-09T23:59:59.999Z")).toISOString()).toBe(
      "2026-10-09T00:00:00.000Z",
    );
    expect(ledgerPeriod(new Date("2026-10-10T00:00:00.000Z")).toISOString()).toBe(
      "2026-10-10T00:00:00.000Z",
    );
  });
});

describe("fake video provider", () => {
  const request = (key: string): VideoSubmitRequest => ({
    ...SPEC,
    prompt: "A product shot",
    model: "fake-video-draft-1",
    idempotencyKey: key,
  });

  it("finishes after the configured polls with a valid clip of the requested shape", async () => {
    const provider = new FakeVideoProvider({ pollsBeforeDone: 2 });
    const { providerJobId } = await provider.submit(request("k1"));
    expect(await provider.status(providerJobId)).toEqual({ state: "RUNNING" });
    expect(await provider.status(providerJobId)).toEqual({ state: "RUNNING" });
    expect(await provider.status(providerJobId)).toEqual({ state: "SUCCEEDED", billedSeconds: 8 });
    expect(validateClip(await provider.download(providerJobId), SPEC)).toBeNull();
    expect(await provider.findByClientRef("k1")).toBe(providerJobId);
    expect(await provider.findByClientRef("other")).toBeNull();
  });

  it("supports only its own durations", () => {
    const provider = new FakeVideoProvider();
    expect(provider.unsupported(SPEC)).toBeNull();
    expect(provider.unsupported({ ...SPEC, durationSeconds: 5 })).toBe("duration");
    expect(provider.modelFor("DRAFT")).not.toBe(provider.modelFor("STANDARD"));
  });

  it("reproduces submission failures, distinguishing 'not accepted' from 'unknown'", async () => {
    const provider = new FakeVideoProvider({
      scenarios: [
        "submit_rejected",
        "submit_unavailable",
        "submit_timeout_accepted",
        "submit_timeout_lost",
      ],
    });
    const failure = async (key: string) =>
      provider.submit(request(key)).then(
        () => null,
        (error: unknown) => error,
      );
    expect(await failure("a")).toMatchObject({ kind: "rejected", accepted: "no" });
    expect(await failure("b")).toMatchObject({ kind: "unavailable", accepted: "no" });
    const accepted = await failure("c");
    expect(accepted).toBeInstanceOf(VideoProviderError);
    expect(accepted).toMatchObject({ kind: "timeout", accepted: "unknown" });
    expect(await provider.findByClientRef("c")).not.toBeNull();
    expect(await failure("d")).toMatchObject({ kind: "timeout", accepted: "unknown" });
    expect(await provider.findByClientRef("d")).toBeNull();
  });

  it("reproduces provider-side failures and bad output", async () => {
    const provider = new FakeVideoProvider({
      pollsBeforeDone: 0,
      scenarios: [
        "provider_failed",
        "refused",
        "invalid_output",
        "corrupt_output",
        "download_fails_once",
      ],
    });
    const ids = [];
    for (const key of ["a", "b", "c", "d", "e"])
      ids.push((await provider.submit(request(key))).providerJobId);
    const [failed = "", refused = "", invalid = "", corrupt = "", flaky = ""] = ids;
    expect(await provider.status(failed)).toMatchObject({
      state: "FAILED",
      failure: "unavailable",
    });
    expect(await provider.status(refused)).toMatchObject({ state: "FAILED", failure: "refused" });
    expect(validateClip(await provider.download(invalid), SPEC)).toBe("duration_mismatch");
    expect(validateClip(await provider.download(corrupt), SPEC)).toBe("corrupt");
    await expect(provider.download(flaky)).rejects.toMatchObject({ kind: "unavailable" });
    expect(validateClip(await provider.download(flaky), SPEC)).toBeNull();
  });
});

describe("VIDEO_PROVIDER", () => {
  it("defaults to disabled and refuses the fake provider in production", () => {
    expect(parseVideoEnv({}).VIDEO_PROVIDER).toBe("disabled");
    expect(parseVideoEnv({ VIDEO_PROVIDER: "fake", NODE_ENV: "test" }).VIDEO_PROVIDER).toBe("fake");
    expect(() => parseVideoEnv({ VIDEO_PROVIDER: "fake", NODE_ENV: "production" })).toThrow();
    expect(() => parseVideoEnv({ VIDEO_PROVIDER: "veo" })).toThrow();
  });
});
