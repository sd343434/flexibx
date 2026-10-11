import { describe, expect, it } from "vitest";

import {
  BRIEF_LIMITS,
  composeVideoPrompt,
  PLATFORM_ASPECT,
  VIDEO_LANGUAGES,
  VIDEO_PLATFORMS,
  VIDEO_STYLES,
  videoBriefSchema,
} from "@/server/videos/generation/video-brief";

// The Video Studio brief: what is accepted, and how it becomes the provider prompt.

const BRIEF = {
  objective: "Launch the spring menu",
  audience: "",
  description: "A slow pan over a coffee cup",
  platform: "instagram_reels",
  style: "minimal",
  language: "ar",
};

describe("video brief", () => {
  it("accepts a complete brief and drops an empty audience", () => {
    const parsed = videoBriefSchema.parse(BRIEF);
    expect(parsed.audience).toBeUndefined();
    expect(composeVideoPrompt(parsed)).toBe(
      [
        "Scene: A slow pan over a coffee cup",
        "Marketing objective: Launch the spring menu",
        "Platform: Instagram Reels",
        "Visual style: minimal and clean",
        "Language for any on-screen text or speech: Arabic",
      ].join("\n"),
    );
  });

  it("refuses unknown choices and over-long text", () => {
    for (const bad of [
      { platform: "myspace" },
      { style: "vaporwave" },
      { language: "fr" },
      { objective: " " },
      { description: "" },
      { objective: "x".repeat(BRIEF_LIMITS.objective + 1) },
      { audience: "x".repeat(BRIEF_LIMITS.audience + 1) },
      { description: "x".repeat(BRIEF_LIMITS.description + 1) },
    ]) {
      expect(videoBriefSchema.safeParse({ ...BRIEF, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("keeps the longest possible brief within the job's 2,000-character prompt", () => {
    for (const platform of VIDEO_PLATFORMS) {
      for (const style of VIDEO_STYLES) {
        for (const language of VIDEO_LANGUAGES) {
          const prompt = composeVideoPrompt(
            videoBriefSchema.parse({
              objective: "o".repeat(BRIEF_LIMITS.objective),
              audience: "a".repeat(BRIEF_LIMITS.audience),
              description: "d".repeat(BRIEF_LIMITS.description),
              platform,
              style,
              language,
            }),
          );
          expect(prompt.length).toBeLessThanOrEqual(2000);
        }
      }
    }
  });

  it("suggests a supported format for every platform", () => {
    for (const platform of VIDEO_PLATFORMS) {
      expect(["16:9", "9:16"]).toContain(PLATFORM_ASPECT[platform]);
    }
    expect(PLATFORM_ASPECT.tiktok).toBe("9:16");
    expect(PLATFORM_ASPECT.youtube).toBe("16:9");
  });
});
