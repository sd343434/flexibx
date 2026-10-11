import { z } from "zod";

// The creative brief of a video request (pure, unit tested). The brief is validated on
// the server and compiled into the provider prompt that is stored with the job — there
// are no separate brief columns yet, so the stored prompt is the record of the brief.
// Labels in the compiled prompt are English (provider-facing); the person's own text is
// kept as written. Platform, style and language are fixed choices, never free text.

export const VIDEO_PLATFORMS = [
  "instagram_reels",
  "tiktok",
  "youtube_shorts",
  "youtube",
  "snapchat",
  "x",
  "linkedin",
] as const;
export type VideoPlatform = (typeof VIDEO_PLATFORMS)[number];

/** The usual frame of each platform (a suggestion; the person chooses the format). */
export const PLATFORM_ASPECT: Readonly<Record<VideoPlatform, "16:9" | "9:16">> = {
  instagram_reels: "9:16",
  tiktok: "9:16",
  youtube_shorts: "9:16",
  snapchat: "9:16",
  youtube: "16:9",
  x: "16:9",
  linkedin: "16:9",
};

export const VIDEO_STYLES = [
  "cinematic",
  "product_showcase",
  "lifestyle",
  "minimal",
  "energetic",
] as const;
export type VideoStyle = (typeof VIDEO_STYLES)[number];

export const VIDEO_LANGUAGES = ["ar", "en"] as const;
export type VideoLanguage = (typeof VIDEO_LANGUAGES)[number];

/** Field limits; together they keep the compiled prompt under the job's 2,000 characters. */
export const BRIEF_LIMITS = { objective: 400, audience: 250, description: 1000 } as const;

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

export const videoBriefSchema = z.object({
  objective: z.string().trim().min(1).max(BRIEF_LIMITS.objective),
  audience: optionalText(BRIEF_LIMITS.audience),
  description: z.string().trim().min(1).max(BRIEF_LIMITS.description),
  platform: z.enum(VIDEO_PLATFORMS),
  style: z.enum(VIDEO_STYLES),
  language: z.enum(VIDEO_LANGUAGES),
});

export type VideoBrief = z.output<typeof videoBriefSchema>;

const PLATFORM_NAMES: Readonly<Record<VideoPlatform, string>> = {
  instagram_reels: "Instagram Reels",
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  youtube: "YouTube",
  snapchat: "Snapchat",
  x: "X",
  linkedin: "LinkedIn",
};

const STYLE_NAMES: Readonly<Record<VideoStyle, string>> = {
  cinematic: "cinematic",
  product_showcase: "product showcase",
  lifestyle: "lifestyle",
  minimal: "minimal and clean",
  energetic: "energetic and fast-paced",
};

const LANGUAGE_NAMES: Readonly<Record<VideoLanguage, string>> = { ar: "Arabic", en: "English" };

/** The provider prompt for a brief (deterministic; at most 2,000 characters). */
export function composeVideoPrompt(brief: VideoBrief): string {
  const lines = [
    `Scene: ${brief.description}`,
    `Marketing objective: ${brief.objective}`,
    ...(brief.audience === undefined ? [] : [`Audience: ${brief.audience}`]),
    `Platform: ${PLATFORM_NAMES[brief.platform]}`,
    `Visual style: ${STYLE_NAMES[brief.style]}`,
    `Language for any on-screen text or speech: ${LANGUAGE_NAMES[brief.language]}`,
  ];
  return lines.join("\n");
}
