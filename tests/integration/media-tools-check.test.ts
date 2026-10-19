// scripts/creator/check-media-tools.sh (Pass 11): the check the worker image runs at
// build time and CI runs against it. With the real FFmpeg it passes; with a wrapper that
// hides one capability (an old version, a missing encoder, no libass, no ffprobe, no
// font, an encode that fails) it fails and names the reason. Needs FFmpeg on PATH (CI's
// integration job installs it).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../scripts/creator/check-media-tools.sh");
const dir = mkdtempSync(join(tmpdir(), "media-tools-check-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An ffmpeg wrapper: rewrites one answer, passes everything else to the real ffmpeg. */
function fakeFfmpeg(name: string, rewrite: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
real="$(command -v ffmpeg)"
${rewrite}
exec "$real" "$@"
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function check(env: Record<string, string> = {}) {
  const result = spawnSync("sh", [SCRIPT], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("check-media-tools.sh", () => {
  it("passes with this host's FFmpeg, after a real smoke encode", () => {
    const result = check();
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^media tools OK: FFmpeg \d+ \(libx264, aac, libopus, subtitles\)/);
  });

  it.each([
    [
      "an FFmpeg older than 6",
      'case "$*" in *-version*) echo "ffmpeg version 5.1.6-0+deb12u1 Copyright"; exit 0;; esac',
      "FFmpeg 5 is older than 6",
    ],
    [
      "an unrecognised version line",
      'case "$*" in *-version*) echo "something else"; exit 0;; esac',
      "unrecognised ffmpeg version line",
    ],
    [
      "a missing encoder",
      'case "$*" in *-encoders*) "$real" "$@" | grep -v libopus; exit 0;; esac',
      "encoder libopus missing",
    ],
    [
      "FFmpeg without libass",
      'case "$*" in *-filters*) "$real" "$@" | grep -v subtitles; exit 0;; esac',
      "subtitles filter missing",
    ],
    [
      "an encode that fails",
      'case "$*" in *testsrc*) echo "Unknown encoder" >&2; exit 1;; esac',
      "smoke encode failed",
    ],
    ["an ffmpeg that does not run", "exit 127", "ffmpeg is not runnable"],
  ])("fails with %s", (name, rewrite, reason) => {
    const result = check({ CREATOR_FFMPEG_PATH: fakeFfmpeg(name.replaceAll(" ", "-"), rewrite) });
    expect(result.status).toBe(1);
    expect(result.err).toContain(reason);
    expect(result.out).not.toContain("media tools OK");
  });

  it("fails without ffprobe or without the subtitle font", () => {
    const noProbe = check({ CREATOR_FFPROBE_PATH: join(dir, "no-such-ffprobe") });
    expect(noProbe.status).toBe(1);
    expect(noProbe.err).toContain("ffprobe is not runnable");
    const noFont = check({ CREATOR_SUBTITLE_FONT: join(dir, "missing-font.ttf") });
    expect(noFont.status).toBe(1);
    expect(noFont.err).toContain("subtitle font missing");
  });
});
