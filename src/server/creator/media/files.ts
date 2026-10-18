import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, statfs } from "node:fs/promises";

// Local file checks of the worker. Pure (no `server-only`).

/** The file's first `bytes` bytes (for format sniffing), without reading the rest. */
export async function readHead(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * SHA-256 (hex) of the whole file and, when `partSize` is given, of each consecutive
 * `partSize` slice — one streaming pass, constant memory, for files of any size.
 */
export async function hashFile(
  path: string,
  partSize: number | null,
  signal?: AbortSignal,
): Promise<{ readonly sha256: string; readonly parts: readonly string[]; readonly bytes: number }> {
  const whole = createHash("sha256");
  const parts: string[] = [];
  let part = partSize === null ? null : createHash("sha256");
  let inPart = 0;
  let bytes = 0;
  const stream = createReadStream(path, {
    highWaterMark: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    whole.update(chunk);
    bytes += chunk.byteLength;
    if (part === null || partSize === null) continue;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(partSize - inPart, chunk.byteLength - offset);
      part.update(chunk.subarray(offset, offset + take));
      inPart += take;
      offset += take;
      if (inPart === partSize) {
        parts.push(part.digest("hex"));
        part = createHash("sha256");
        inPart = 0;
      }
    }
  }
  if (part !== null && inPart > 0) parts.push(part.digest("hex"));
  return { sha256: whole.digest("hex"), parts, bytes };
}

/** Free bytes on the filesystem holding `path` (null when the platform cannot say). */
export async function freeBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
