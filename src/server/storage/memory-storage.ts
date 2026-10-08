import {
  assertUploadAllowed,
  assertValidKey,
  resolveTtl,
  type AllowedContentType,
  type SignedUpload,
  type SignedUploadOptions,
  type StorageService,
  type StoredObjectData,
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
export class MemoryStorageService implements StorageService {
  readonly objects = new Map<string, StoredObject>();

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

  delete(key: string): Promise<void> {
    return settle(() => {
      assertValidKey(key);
      this.objects.delete(key);
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

  getObject(key: string): Promise<StoredObjectData | null> {
    return settle(() => {
      assertValidKey(key);
      const stored = this.objects.get(key);
      return stored === undefined
        ? null
        : { body: stored.body.slice(), contentType: stored.contentType };
    });
  }
}
