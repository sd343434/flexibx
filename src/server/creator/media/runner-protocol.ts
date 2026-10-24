import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

// The media runner's request and the policy it enforces on every call (Pass 42). The
// runner executes FFmpeg/ffprobe in its own container — no credentials, no network, its
// own process namespace — for the Creator Studio worker, which reaches it through a Unix
// socket on the shared work volume (scripts/creator/media-runner.ts,
// docs/runbooks/MEDIA_ISOLATION.md). The policy is checked by the runner itself, never
// trusted from the caller.

export const MEDIA_TOOLS = ["ffmpeg", "ffprobe"] as const;
export type MediaToolName = (typeof MEDIA_TOOLS)[number];

/** Longest single run the runner accepts (a render's own timeout is shorter). */
export const MAX_RUN_MS = 6 * 60 * 60 * 1000;
/** Largest stdout returned (ffprobe JSON, `-encoders` / `-filters` listings). */
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export const mediaRunRequestSchema = z.strictObject({
  tool: z.enum(MEDIA_TOOLS),
  args: z
    .array(
      z
        .string()
        .max(8192)
        .refine((value) => !value.includes("\0"), "NUL"),
    )
    .min(1)
    .max(128),
  timeoutMs: z.number().int().min(1).max(MAX_RUN_MS),
  maxStdoutBytes: z.number().int().min(1).max(MAX_STDOUT_BYTES).optional(),
  cwd: z.string().min(1).max(4096).optional(),
});
export type MediaRunRequest = z.infer<typeof mediaRunRequestSchema>;

export type MediaRunResponse =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      /** "refused" = the policy below; the rest mirror MediaToolError codes. */
      readonly code: "refused" | "timeout" | "aborted" | "failed" | "not_found";
      readonly exitCode: number | null;
      readonly detail: string;
    };

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const number = /^\d{1,12}(\.\d{1,6})?$/;
const integer = /^\d{1,12}$/;
const exactly =
  (...values: string[]) =>
  (value: string) =>
    values.includes(value);
const matches = (pattern: RegExp) => (value: string) => pattern.test(value);

/**
 * The one video filter chain the worker builds (media.ts renderClip): crop, scale, setsar
 * and optionally libass reading `subtitles.srt` from the job's own directory. Anything
 * else — `movie=`, `amovie=`, another file name, a second chain — is refused.
 */
const VIDEO_FILTERS =
  /^crop=\d{1,5}:\d{1,5}:\d{1,5}:\d{1,5},scale=\d{1,5}:\d{1,5},setsar=1(,subtitles=filename=subtitles\.srt:charenc=UTF-8:force_style='FontName=DejaVu Sans,FontSize=16,Outline=1,Shadow=0,MarginV=40')?$/;

/** Options without a value. */
const FLAGS = new Set([
  "-show_format",
  "-show_streams",
  "-nostdin",
  "-hide_banner",
  "-vn",
  "-an",
  "-y",
]);

/** Options with a value, and which values: every option the worker uses, nothing else. */
const OPTIONS: Readonly<Record<string, (value: string) => boolean>> = {
  "-v": exactly("error"),
  "-protocol_whitelist": exactly("file"),
  "-print_format": exactly("json"),
  // Demuxers pinned by media.ts (DEMUXERS) and the muxers it writes. Never `lavfi`,
  // `concat`, `hls`, `image2` or another format that opens files of its own.
  "-f": exactly("mov", "matroska", "mp3", "wav", "ogg"),
  "-ss": matches(number),
  "-t": matches(number),
  "-ac": matches(integer),
  "-ar": matches(integer),
  "-threads": matches(integer),
  "-crf": matches(integer),
  "-fs": matches(integer),
  "-c:a": exactly("aac", "libopus", "pcm_s16le"),
  "-c:v": exactly("libx264"),
  "-b:a": matches(/^\d{1,4}k$/),
  "-application": exactly("voip"),
  "-preset": exactly("veryfast"),
  "-pix_fmt": exactly("yuv420p"),
  "-movflags": exactly("+faststart"),
  "-vf": matches(VIDEO_FILTERS),
};

/** Build information only, no input (the staging preflight). */
const INFO = new Set(["-version", "-encoders", "-filters"]);

/**
 * Why a request is refused, or null. An allowlist, argument by argument:
 * - an information request is exactly `-hide_banner -version|-encoders|-filters`;
 * - otherwise every option must be one the worker uses, with a value of the expected
 *   shape (`-f` among the pinned formats, `-vf` the worker's own filter chain);
 * - `-protocol_whitelist file` must appear exactly once;
 * - every other argument (input after `-i`, output, ffprobe's input) must be a `file:`
 *   path that resolves inside `workRoot` — no `..` escape, no /proc, no device;
 * - `cwd`, when given, must be inside `workRoot`.
 */
export function mediaPolicyViolation(request: MediaRunRequest, workRoot: string): string | null {
  const { args } = request;
  if (args.length === 2 && args[0] === "-hide_banner" && INFO.has(args[1] ?? "")) {
    return request.cwd === undefined ? null : "cwd_outside_work";
  }
  const root = resolve(workRoot);
  const localFile = (arg: string) => {
    if (!arg.startsWith("file:")) return false;
    const path = arg.slice("file:".length);
    return isAbsolute(path) && inside(root, resolve(path));
  };
  let whitelists = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (FLAGS.has(arg)) continue;
    if (arg === "-i") {
      index += 1;
      if (!localFile(args[index] ?? "")) return "input_outside_work";
      continue;
    }
    const check = Object.hasOwn(OPTIONS, arg) ? OPTIONS[arg] : undefined;
    if (check !== undefined) {
      index += 1;
      const value = args[index];
      if (value === undefined || !check(value)) return `value:${arg}`;
      if (arg === "-protocol_whitelist") whitelists += 1;
      continue;
    }
    if (arg.startsWith("-")) return `option:${arg.slice(0, 40)}`;
    if (!localFile(arg)) return "path_outside_work";
  }
  if (whitelists !== 1) return "protocol_whitelist";
  if (request.cwd !== undefined && !inside(root, resolve(request.cwd))) return "cwd_outside_work";
  return null;
}
