// Image sniffing for media uploads. Pure (no `server-only`). The browser-declared
// content type and the file name are never trusted: the type is read from the file's own
// signature, and the dimensions from its header. Only PNG, JPEG and WebP are accepted —
// no SVG (scriptable) and no formats the app cannot display safely.

export type ImageContentType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  readonly contentType: ImageContentType;
  readonly width: number;
  readonly height: number;
}

/** Larger values are rejected as corrupt (or as decompression bombs for later processing). */
export const MAX_IMAGE_DIMENSION = 20_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number) =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number) =>
  (((b[o] ?? 0) << 24) >>> 0) +
  (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));

function png(bytes: Uint8Array): ImageInfo | null {
  // Signature, then the IHDR chunk: length (4) "IHDR" (4) width (4) height (4).
  if (!startsWith(bytes, PNG_SIGNATURE) || ascii(bytes, 12, 4) !== "IHDR") return null;
  return sized("image/png", u32be(bytes, 16), u32be(bytes, 20));
}

// JPEG start-of-frame markers that carry the image size (not DHT/JPG/DAC: C4, C8, CC).
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpeg(bytes: Uint8Array): ImageInfo | null {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end / scan before any frame
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return null;
      return sized("image/jpeg", u16be(bytes, offset + 7), u16be(bytes, offset + 5));
    }
    offset += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): ImageInfo | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    // Key frame start code 9D 01 2A, then 14-bit width and height.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    return sized("image/webp", u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f || bytes.length < 25) return null;
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return sized("image/webp", width, height);
  }
  if (chunk === "VP8X") {
    if (bytes.length < 30) return null;
    return sized("image/webp", 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  }
  return null;
}

function sized(contentType: ImageContentType, width: number, height: number): ImageInfo | null {
  if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return null;
  }
  return { contentType, width, height };
}

/** The image type and size read from `bytes`, or null when it is not a supported image. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

/**
 * A display name for an uploaded file: no path, no control or bidi-override characters,
 * at most 255 characters. Display only — storage keys never contain it.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩‎‏]/g, "")
    .trim()
    .slice(0, 255);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "image" : cleaned;
}
