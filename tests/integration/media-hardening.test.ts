// FFmpeg on untrusted files, with the real FFmpeg/ffprobe (Pass 39): the sniffed container
// pins the demuxer, a playlist cannot pull another file in, no network protocol is allowed,
// a damaged file fails fast, and the hard timeout kills the process.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMUXERS, extractAudio, probeMedia, type MediaTools } from "@/server/creator/media/media";
import { sniffContainer } from "@/server/creator/media/sniff";
import { MediaToolError, runMediaTool } from "@/server/creator/media/tools";

const tools: MediaTools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", threads: 1 };
const dir = mkdtempSync(join(tmpdir(), "media-hardening-"));
const at = (name: string) => join(dir, name);
const MP4 = at("ok.mp4");
const WAV = at("ok.wav");

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

beforeAll(() => {
  const make = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args]);
    if (result.status !== 0) throw new Error(String(result.stderr));
  };
  make([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    MP4,
  ]);
  make(["-f", "lavfi", "-i", "sine", "-t", "1", WAV]);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FFmpeg on untrusted files (Pass 39)", () => {
  it("reads a file with the demuxer of its sniffed container, and only that one", async () => {
    const container = sniffContainer(readFileSync(MP4).subarray(0, 64));
    expect(container).toBe("mp4");
    const info = await probeMedia(tools, MP4, { timeoutMs: 30_000, container: "mp4" });
    expect(info.hasVideo && info.hasAudio).toBe(true);
    // The same bytes forced through another demuxer are refused, not auto-detected.
    const wrong = await failure(probeMedia(tools, MP4, { timeoutMs: 30_000, container: "wav" }));
    expect(wrong).toBeInstanceOf(MediaToolError);
    expect(DEMUXERS.webm).toBe("matroska");
  });

  it("does not let a playlist read another local file, whatever the file is named", async () => {
    // An HLS playlist pointing at another local file. Auto-detected (FFmpeg picks HLS from a
    // .m3u8 name), it is followed even with only the `file` protocol allowed — the control
    // below. The worker names its copy source.bin today, but pinning makes the name irrelevant.
    const playlist = at("playlist.m3u8");
    writeFileSync(
      playlist,
      `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:${WAV}\n#EXT-X-ENDLIST\n`,
    );
    const followed = await probeMedia(tools, playlist, { timeoutMs: 30_000 });
    expect(followed.hasAudio).toBe(true); // control: unpinned, FFmpeg read ok.wav
    const pinned = await failure(
      probeMedia(tools, playlist, { timeoutMs: 30_000, container: "mp4" }),
    );
    expect(pinned).toBeInstanceOf(MediaToolError);
    // The same playlist behind an MP4-looking header passes the sniffer — and is still refused.
    const disguised = at("disguised.m3u8");
    writeFileSync(disguised, `\0\0\0\x18ftypisom\n${readFileSync(playlist, "utf8")}`);
    expect(sniffContainer(readFileSync(disguised).subarray(0, 64))).toBe("mp4");
    expect(
      await failure(probeMedia(tools, disguised, { timeoutMs: 30_000, container: "mp4" })),
    ).toBeInstanceOf(MediaToolError);
    // An undisguised playlist never reaches FFmpeg: the upload check rejects it.
    expect(sniffContainer(Buffer.from("#EXTM3U\nfile:/etc/passwd\n"))).toBeNull();
  });

  it("refuses any network protocol, even when a demuxer asks for one", async () => {
    const playlist = at("remote.m3u8");
    writeFileSync(playlist, "#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:9/never\n#EXT-X-ENDLIST\n");
    // Not even pinned: the protocol whitelist alone refuses http.
    const error = await failure(probeMedia(tools, playlist, { timeoutMs: 30_000 }));
    expect(error).toBeInstanceOf(MediaToolError);
  });

  it("fails fast on a damaged file instead of hanging", async () => {
    const truncated = at("truncated.mp4");
    writeFileSync(truncated, readFileSync(MP4).subarray(0, 600));
    const started = Date.now();
    const error = await failure(
      extractAudio(tools, truncated, at("audio.wav"), { timeoutMs: 30_000, container: "mp4" }),
    );
    expect(error).toBeInstanceOf(MediaToolError);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("kills FFmpeg at the hard timeout", async () => {
    const started = Date.now();
    const error = await failure(
      runMediaTool(
        tools.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=1920x1080:rate=60",
          "-c:v",
          "libx264",
          "-preset",
          "veryslow",
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 1_000 },
      ),
    );
    expect(error).toBeInstanceOf(MediaToolError);
    expect((error as MediaToolError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("still processes a valid WAV through its pinned demuxer", async () => {
    expect(sniffContainer(readFileSync(WAV).subarray(0, 64))).toBe("wav");
    await extractAudio(tools, WAV, at("out.wav"), { timeoutMs: 30_000, container: "wav" });
    const info = await probeMedia(tools, at("out.wav"), { timeoutMs: 30_000, container: "wav" });
    expect(info.hasAudio).toBe(true);
  });
});
