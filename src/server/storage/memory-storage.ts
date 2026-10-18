import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  assertUploadAllowed,
  assertValidKey,
  ObjectTooLargeError,
  resolveTtl,
  type AllowedContentType,
  type DownloadToFileOptions,
  type GetObjectOptions,
  type MultipartStorage,
  type SignedUpload,
  type SignedUploadOptions,
  type StorageDeleteOptions,
  type StorageService,
  type StoredObjectData,
  type UploadedPart,
} from "./storage";

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: AllowedContentType;
}

/** Runs `fn` so that thrown errors become rejections, matching the async S3 adapter. */
function settle<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(fn());
  });
}

/**
 * In-memory implementation for tests and automated end-to-end runs
 * (STORAGE_DRIVER=test-memory — never a real deployment). Applies the same key and upload
 * rules as S3.
 */
interface OpenUpload {
  readonly key: string;
  readonly contentType: AllowedContentType;
  readonly parts: Map<number, Uint8Array>;
}

export class MemoryStorageService implements StorageService {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, OpenUpload>();

  /**
   * The test transport of a part (what S3 does on a PUT to a signed part URL): the body
   * must have the signed length. Returns the part's ETag.
   */
  putPart(uploadId: string, partNumber: number, body: Uint8Array, signedLength: number): string {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw new Error("NoSuchUpload");
    if (body.byteLength !== signedLength) throw new Error("SignatureDoesNotMatch");
    upload.parts.set(partNumber, body.slice());
    return `"${createHash("md5").update(body).digest("hex")}"`;
  }

  readonly multipart: MultipartStorage = {
    create: (key, options) =>
      settle(() => {
        assertValidKey(key);
        const id = randomUUID();
        this.uploads.set(id, { key, contentType: options.contentType, parts: new Map() });
        return id;
      }),
    signPart: (key, uploadId, partNumber, options) =>
      settle(() => {
        assertValidKey(key);
        const expiresIn = resolveTtl(options.expiresInSeconds);
        return {
          url: `memory://part/${uploadId}/${String(partNumber)}/${String(options.contentLength)}`,
          method: "PUT" as const,
          headers: { "content-length": String(options.contentLength) },
          expiresAt: new Date(Date.now() + expiresIn * 1000),
        };
      }),
    listParts: (key, uploadId, options = {}) =>
      settle(() => {
        assertValidKey(key);
        options.signal?.throwIfAborted();
        const upload = this.uploads.get(uploadId);
        if (upload?.key !== key) return null;
        return [...upload.parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([partNumber, body]): UploadedPart => ({
            partNumber,
            size: body.byteLength,
            etag: `"${createHash("md5").update(body).digest("hex")}"`,
          }));
      }),
    complete: (key, uploadId, parts) =>
      settle(() => {
        assertValidKey(key);
        const upload = this.uploads.get(uploadId);
        if (upload?.key !== key) throw new Error("NoSuchUpload");
        const bodies = parts.map((part) => {
          const body = upload.parts.get(part.partNumber);
          const etag =
            body === undefined ? null : `"${createHash("md5").update(body).digest("hex")}"`;
          if (body === undefined || etag !== part.etag) throw new Error("InvalidPart");
          return body;
        });
        const total = bodies.reduce((sum, body) => sum + body.byteLength, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const body of bodies) {
          joined.set(body, offset);
          offset += body.byteLength;
        }
        this.objects.set(key, { body: joined, contentType: upload.contentType });
        this.uploads.delete(uploadId);
      }),
    abort: (key, uploadId, options = {}) =>
      settle(() => {
        assertValidKey(key);
        options.signal?.throwIfAborted();
        this.uploads.delete(uploadId);
      }),
  };

  async downloadToFile(
    key: string,
    path: string,
    options: DownloadToFileOptions,
  ): Promise<number | null> {
    assertValidKey(key);
    options.signal?.throwIfAborted();
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    if (stored.body.byteLength > options.maxBytes) throw new ObjectTooLargeError();
    await writeFile(path, stored.body, { flag: "wx" });
    return stored.body.byteLength;
  }

  put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: AllowedContentType },
  ): Promise<void> {
    return settle(() => {
      assertValidKey(key);
      this.objects.set(key, { body: body.slice(), contentType: options.contentType });
    });
  }

  delete(key: string, options: StorageDeleteOptions = {}): Promise<void> {
    return settle(() => {
      assertValidKey(key);
      options.signal?.throwIfAborted();
      this.objects.delete(key);
    });
  }

  /** Always reachable (in process); honours an already-aborted signal like S3 would. */
  checkAccess(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    return settle(() => {
      options.signal?.throwIfAborted();
    });
  }

  getSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<SignedUpload> {
    return settle(() => {
      assertValidKey(key);
      assertUploadAllowed(options.category, options.contentType, options.contentLength);
      const expiresIn = resolveTtl(options.expiresInSeconds);
      return {
        url: `memory://upload/${key}`,
        method: "PUT" as const,
        headers: {
          "content-type": options.contentType,
          "content-length": String(options.contentLength),
        },
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    });
  }

  getSignedDownloadUrl(key: string): Promise<string> {
    return settle(() => {
      assertValidKey(key);
      return `memory://download/${key}`;
    });
  }

  publicUrl(key: string): string | null {
    assertValidKey(key);
    return null;
  }

  getObject(key: string, options: GetObjectOptions = {}): Promise<StoredObjectData | null> {
    return settle(() => {
      assertValidKey(key);
      options.signal?.throwIfAborted();
      const stored = this.objects.get(key);
      return stored === undefined
        ? null
        : { body: stored.body.slice(), contentType: stored.contentType };
    });
  }
}
