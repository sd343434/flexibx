import type { VideoSpec } from "@/server/ai/providers/video/gateway";

// Technical validation of generated clips (§4.2.6) without external tools: a small ISO
// BMFF (MP4) box reader. It reads only structure — container brand, tracks, codecs,
// dimensions, durations and sample counts — never decodes media. Pure (unit tested).
// `buildMp4` writes the same structure for the fake provider, so the full storage and
// validation path runs without any paid or external call.

const VIDEO_CODECS = { avc1: "h264", avc3: "h264", hvc1: "h265", hev1: "h265" } as const;
type VideoCodec = (typeof VIDEO_CODECS)[keyof typeof VIDEO_CODECS];
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1"]);

/** Allowed difference between the requested and the actual duration, in seconds. */
export const DURATION_TOLERANCE_SECONDS = 0.5;

const DIMENSIONS = {
  "720p": { "16:9": [1280, 720], "9:16": [720, 1280] },
  "1080p": { "16:9": [1920, 1080], "9:16": [1080, 1920] },
} as const;

export function expectedDimensions(spec: Pick<VideoSpec, "aspectRatio" | "resolution">): {
  width: number;
  height: number;
} {
  const [width, height] = DIMENSIONS[spec.resolution][spec.aspectRatio];
  return { width, height };
}

export interface Mp4Info {
  readonly durationSeconds: number;
  readonly video: {
    readonly codec: VideoCodec | null;
    readonly width: number;
    readonly height: number;
    readonly samples: number;
  } | null;
  readonly audioTracks: number;
  readonly emptyTracks: number;
  readonly mediaBytes: number;
}

export type Mp4Problem =
  | "not_mp4"
  | "corrupt"
  | "no_video"
  | "unsupported_codec"
  | "empty_stream"
  | "duration_mismatch"
  | "resolution_mismatch"
  | "audio_mismatch";

interface Box {
  readonly type: string;
  readonly start: number; // payload start
  readonly end: number; // payload end (exclusive)
}

class CorruptMp4 extends Error {}

function boxes(view: DataView, start: number, end: number): Box[] {
  const result: Box[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) throw new CorruptMp4("truncated box header");
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    let header = 8;
    if (size === 1) {
      if (end - offset < 16) throw new CorruptMp4("truncated large size");
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new CorruptMp4("box too large");
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - offset; // extends to the end of its parent
    }
    if (size < header || offset + size > end) throw new CorruptMp4(`bad size for ${type}`);
    result.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

const child = (view: DataView, box: Box, type: string) =>
  boxes(view, box.start, box.end).find((candidate) => candidate.type === type);

function need(box: Box | undefined, what: string): Box {
  if (box === undefined) throw new CorruptMp4(`missing ${what}`);
  return box;
}

function fullBoxDuration(view: DataView, box: Box): { timescale: number; duration: number } {
  const version = view.getUint8(box.start);
  if (version === 1) {
    return {
      timescale: view.getUint32(box.start + 20),
      duration: Number(view.getBigUint64(box.start + 24)),
    };
  }
  return { timescale: view.getUint32(box.start + 12), duration: view.getUint32(box.start + 16) };
}

/** Structure of an MP4 file, or why it cannot be read as one. */
export function inspectMp4(
  bytes: Uint8Array,
): Mp4Info | { readonly problem: "not_mp4" | "corrupt" } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const top = boxes(view, 0, bytes.byteLength);
    const ftyp = top[0];
    if (ftyp?.type !== "ftyp" || ftyp.end - ftyp.start < 8) return { problem: "not_mp4" };
    const brands: string[] = [];
    for (let at = ftyp.start; at + 4 <= ftyp.end; at += 4) {
      if (at === ftyp.start + 4) continue; // minor version
      brands.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
    }
    if (!brands.some((brand) => MP4_BRANDS.has(brand))) return { problem: "not_mp4" };

    const moov = need(
      top.find((box) => box.type === "moov"),
      "moov",
    );
    const mvhd = fullBoxDuration(view, need(child(view, moov, "mvhd"), "mvhd"));
    if (mvhd.timescale === 0) throw new CorruptMp4("zero timescale");
    const mediaBytes = top
      .filter((box) => box.type === "mdat")
      .reduce((sum, box) => sum + (box.end - box.start), 0);

    let video: Mp4Info["video"] = null;
    let audioTracks = 0;
    let emptyTracks = 0;
    for (const trak of boxes(view, moov.start, moov.end).filter((box) => box.type === "trak")) {
      const tkhd = need(child(view, trak, "tkhd"), "tkhd");
      const mdia = need(child(view, trak, "mdia"), "mdia");
      const hdlr = need(child(view, mdia, "hdlr"), "hdlr");
      const handler = String.fromCharCode(...bytes.subarray(hdlr.start + 8, hdlr.start + 12));
      const stbl = need(child(view, need(child(view, mdia, "minf"), "minf"), "stbl"), "stbl");
      const stsz = need(child(view, stbl, "stsz"), "stsz");
      const samples = view.getUint32(stsz.start + 8);
      const media = fullBoxDuration(view, need(child(view, mdia, "mdhd"), "mdhd"));
      if (samples === 0 || media.duration === 0) emptyTracks += 1;
      if (handler === "soun") audioTracks += 1;
      if (handler !== "vide" || video !== null) continue;
      const stsd = need(child(view, stbl, "stsd"), "stsd");
      const entry = boxes(view, stsd.start + 8, stsd.end)[0];
      const fourcc = entry?.type ?? "";
      const widthOffset = tkhd.end - 8;
      video = {
        codec: Object.hasOwn(VIDEO_CODECS, fourcc)
          ? VIDEO_CODECS[fourcc as keyof typeof VIDEO_CODECS]
          : null,
        width: view.getUint32(widthOffset) >>> 16,
        height: view.getUint32(widthOffset + 4) >>> 16,
        samples,
      };
    }
    return {
      durationSeconds: mvhd.duration / mvhd.timescale,
      video,
      audioTracks,
      emptyTracks,
      mediaBytes,
    };
  } catch (error) {
    if (error instanceof CorruptMp4 || error instanceof RangeError) return { problem: "corrupt" };
    throw error;
  }
}

/** The first reason `bytes` is not the clip `spec` asked for, or null if it is. */
export function validateClip(bytes: Uint8Array, spec: VideoSpec): Mp4Problem | null {
  const info = inspectMp4(bytes);
  if ("problem" in info) return info.problem;
  if (info.video === null) return "no_video";
  if (info.video.codec === null) return "unsupported_codec";
  if (info.emptyTracks > 0 || info.video.samples === 0 || info.mediaBytes === 0) {
    return "empty_stream";
  }
  if (Math.abs(info.durationSeconds - spec.durationSeconds) > DURATION_TOLERANCE_SECONDS) {
    return "duration_mismatch";
  }
  const { width, height } = expectedDimensions(spec);
  if (info.video.width !== width || info.video.height !== height) return "resolution_mismatch";
  if (info.audioTracks > 0 !== spec.audio) return "audio_mismatch";
  return null;
}

// ── Writer (fake provider and tests) ──

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => {
    view.setUint32(index * 4, value >>> 0);
  });
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.byteLength + 8), ascii(type), body]);
}

const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);
const TIMESCALE = 1000;

export interface Mp4Shape {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly audio: boolean;
  readonly codec?: "avc1" | "hvc1" | "mp4v";
  /** Video frames (sample count); 0 makes an empty stream. */
  readonly frames?: number;
  /** Deterministic filler bytes for the media payload. */
  readonly seed?: number;
}

function track(
  id: number,
  handler: "vide" | "soun",
  durationMs: number,
  samples: number,
  entry: Uint8Array,
  size: { width: number; height: number },
): Uint8Array {
  const tkhd = box(
    "tkhd",
    u32(0x00000003, 0, 0, id, 0, durationMs, 0, 0, 0, handler === "soun" ? 0x01000000 : 0),
    MATRIX,
    u32(size.width << 16, size.height << 16),
  );
  const mdhd = box("mdhd", u32(0, 0, 0, TIMESCALE, durationMs, 0x55c40000));
  const hdlr = box("hdlr", u32(0, 0), ascii(handler), u32(0, 0, 0), new Uint8Array(1));
  const stsd = box("stsd", u32(0, 1), entry);
  const stsz = box("stsz", u32(0, 1024, samples));
  const stbl = box("stbl", stsd, stsz);
  return box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", stbl)));
}

/** A structurally valid MP4 with the given shape (no decodable media). */
export function buildMp4(shape: Mp4Shape): Uint8Array {
  const durationMs = Math.round(shape.durationSeconds * TIMESCALE);
  const frames = shape.frames ?? Math.max(1, Math.round(shape.durationSeconds * 24));
  const visualEntry = box(
    shape.codec ?? "avc1",
    new Uint8Array(6),
    new Uint8Array([0, 1]),
    new Uint8Array(16),
    new Uint8Array([shape.width >> 8, shape.width & 0xff, shape.height >> 8, shape.height & 0xff]),
    new Uint8Array(50),
  );
  const audioEntry = box("mp4a", new Uint8Array(6), new Uint8Array([0, 1]), new Uint8Array(20));
  const traks = [
    track(1, "vide", durationMs, frames, visualEntry, shape),
    ...(shape.audio
      ? [track(2, "soun", durationMs, frames, audioEntry, { width: 0, height: 0 })]
      : []),
  ];
  const mvhd = box(
    "mvhd",
    u32(0, 0, 0, TIMESCALE, durationMs, 0x00010000),
    new Uint8Array([1, 0]),
    new Uint8Array(10),
    MATRIX,
    new Uint8Array(24),
    u32(traks.length + 1),
  );
  const media = new Uint8Array(2048);
  let state = (shape.seed ?? 1) >>> 0 || 1;
  for (let index = 0; index < media.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    media[index] = state & 0xff;
  }
  return concat([
    box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2avc1mp41")),
    box("moov", mvhd, ...traks),
    box("mdat", media),
  ]);
}
