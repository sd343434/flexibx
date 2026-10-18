// Recognises an uploaded file's container from its first bytes. The browser's declared
// type and the file name are never trusted: a file is accepted only when its header is
// one of the containers below AND matches the family that was declared when the upload
// started. Pure (no `server-only`) for unit tests.

export const SOURCE_CONTENT_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
] as const;

export type SourceContentType = (typeof SOURCE_CONTENT_TYPES)[number];

export type Container = "mp4" | "mov" | "m4a" | "webm" | "mp3" | "wav";

/** Bytes needed to recognise every container below. */
export const SNIFF_BYTES = 64;

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** The container of a file from its header, or null when it is none we accept. */
export function sniffContainer(head: Uint8Array): Container | null {
  if (head.length >= 12 && ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4);
    if (brand === "qt  ") return "mov";
    if (brand === "M4A " || brand === "M4B ") return "m4a";
    return "mp4"; // isom, mp41, mp42, avc1, dash, iso2… (ISO base media)
  }
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return "webm"; // EBML (WebM / Matroska); ffprobe confirms the streams later
  }
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE")
    return "wav";
  if (head.length >= 3 && ascii(head, 0, 3) === "ID3") return "mp3";
  // An MPEG audio frame header: 11 sync bits, layer III.
  if (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe6) === 0xe2) return "mp3";
  return null;
}

/** Which recognised containers a declared content type may turn out to be. */
const FAMILIES: Readonly<Record<SourceContentType, readonly Container[]>> = {
  // Phones label MOV and MP4 interchangeably; both are ISO base media.
  "video/mp4": ["mp4", "mov"],
  "video/quicktime": ["mov", "mp4"],
  "video/webm": ["webm"],
  "audio/mpeg": ["mp3"],
  "audio/mp4": ["m4a", "mp4"],
  "audio/wav": ["wav"],
};

export function isSourceContentType(value: string): value is SourceContentType {
  return (SOURCE_CONTENT_TYPES as readonly string[]).includes(value);
}

/** True when the file's header matches the family declared at upload start. */
export function containerMatches(declared: SourceContentType, container: Container): boolean {
  return FAMILIES[declared].includes(container);
}
