import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageEnv } from "../env-schema";
import {
  assertUploadAllowed,
  assertValidKey,
  ObjectTooLargeError,
  resolveTtl,
  STORAGE_CATEGORIES,
  StorageAccessError,
  StorageTimeoutError,
  type AllowedContentType,
  type DownloadToFileOptions,
  type GetObjectOptions,
  type MultipartStorage,
  type SignedUpload,
  type SignedUploadOptions,
  type StorageAccessFailure,
  type StorageDeleteOptions,
  type StorageService,
  type StoredObjectData,
  type UploadedPart,
} from "./storage";

export interface BucketRules {
  readonly cors:
    | readonly {
        readonly allowedOrigins: readonly string[];
        readonly allowedMethods: readonly string[];
        readonly allowedHeaders: readonly string[];
      }[]
    | null;
  readonly lifecycle:
    | readonly {
        readonly enabled: boolean;
        readonly abortIncompleteMultipartDays: number | null;
      }[]
    | null;
}

/**
 * Maps an SDK error to a failure code. Only the error's name and HTTP status are read:
 * provider messages can contain hosts or request details and are never surfaced.
 */
export function classifyAccessError(error: unknown): StorageAccessFailure {
  if (error instanceof StorageTimeoutError) return "timeout";
  const name = error instanceof Error ? error.name : "";
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (status === 403 || name === "AccessDenied" || name === "Forbidden") return "access_denied";
  if (status === 404 || name === "NotFound" || name === "NoSuchBucket") return "bucket_not_found";
  if (status === 301 || name === "PermanentRedirect" || name === "AuthorizationHeaderMalformed") {
    return "wrong_region";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)
  ) {
    return "unreachable";
  }
  return "failed";
}

/**
 * Time limits for S3 requests (the SDK sets none by default, so a stalled endpoint would
 * hold a request forever). Connection and idle limits apply to every request attempt.
 * Every operation also has a total deadline across the SDK's retries (3 attempts):
 * `put` and `getObject` one sized for the bytes moved, so a slow but progressing transfer
 * of a large video is not cut off while a stalled one is; `delete` and `checkAccess` a
 * fixed one, longer than the callers' own limits (retention 30 s, admin check 10 s) so a
 * caller's signal still decides first where one is passed.
 */
export interface S3Timeouts {
  /** Establishing the TCP/TLS connection. */
  readonly connectionMs: number;
  /** No bytes in either direction on an open request. */
  readonly idleMs: number;
  /** Fixed part of a transfer deadline (latency, server processing). */
  readonly transferBaseMs: number;
  /** Slowest throughput still accepted, in bytes per second. */
  readonly minBytesPerSecond: number;
  /** Total for one delete, retries included. */
  readonly deleteMs: number;
  /** Total for one bucket check, retries included. */
  readonly accessCheckMs: number;
}

export const S3_TIMEOUTS: S3Timeouts = {
  connectionMs: 10_000,
  idleMs: 60_000,
  transferBaseMs: 30_000,
  minBytesPerSecond: 1024 * 1024,
  deleteMs: 45_000,
  accessCheckMs: 20_000,
};

/** The longest delay a Node.js timer accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/** The largest object any category allows: the bound for a download of unknown size. */
const MAX_OBJECT_BYTES = Math.max(
  ...Object.values(STORAGE_CATEGORIES).map((category) => category.maxBytes),
);

/** Whole-transfer deadline for `bytes` at the slowest accepted throughput. */
export function transferDeadlineMs(bytes: number, timeouts: S3Timeouts = S3_TIMEOUTS): number {
  return timeouts.transferBaseMs + Math.ceil((bytes / timeouts.minBytesPerSecond) * 1000);
}

/**
 * The deadline for a download: sized by the size recorded at write time when the caller
 * knows it (never above the largest object a category allows), else by that largest size.
 */
export function downloadDeadlineMs(
  expectedBytes: number | undefined,
  timeouts: S3Timeouts = S3_TIMEOUTS,
): number {
  const bytes =
    expectedBytes !== undefined && Number.isSafeInteger(expectedBytes) && expectedBytes >= 0
      ? Math.min(expectedBytes, MAX_OBJECT_BYTES)
      : MAX_OBJECT_BYTES;
  return transferDeadlineMs(bytes, timeouts);
}

/**
 * Runs `work` with one signal that fires on the caller's signal or on `deadlineMs`. A
 * caller's cancellation surfaces as an AbortError; the deadline (not the caller) ending
 * it, as a StorageTimeoutError; anything else as it came.
 */
async function withinDeadline<T>(
  operation: StorageTimeoutError["operation"],
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // Clamped to what a timer accepts (~24.8 days), so a mis-set throughput cannot throw.
  const deadline = AbortSignal.timeout(Math.min(Math.max(0, deadlineMs), MAX_TIMER_MS));
  const signal = callerSignal === undefined ? deadline : AbortSignal.any([callerSignal, deadline]);
  try {
    return await work(signal);
  } catch (error) {
    if (callerSignal?.aborted === true) {
      // The SDK reports a cancellation during the body read as a plain Error: always an
      // AbortError for the caller, whichever stage was cut.
      if (error instanceof Error && error.name === "AbortError") throw error;
      const cancelled = new Error(`Storage ${operation} cancelled`, { cause: error });
      cancelled.name = "AbortError";
      throw cancelled;
    }
    if (deadline.aborted) throw new StorageTimeoutError(operation, { cause: error });
    throw error;
  }
}

/**
 * Implementation over the S3 API, intended for S3-compatible services. Its automated tests
 * use SDK test doubles; compatibility with any specific service is not verified here.
 * Wasabi (configured through this class by wasabi-storage.ts) is NOT yet verified against
 * a real account — see docs/STORAGE_PROVIDERS.md §8. Bucket is private by default.
 * Provider-specific settings arrive through the constructor only.
 */
export class S3StorageService implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string | undefined;

  private readonly timeouts: S3Timeouts;

  constructor(env: StorageEnv, client?: S3Client, timeouts: S3Timeouts = S3_TIMEOUTS) {
    this.timeouts = timeouts;
    this.bucket = env.S3_BUCKET;
    this.publicBaseUrl = env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, "");
    this.client =
      client ??
      new S3Client({
        region: env.S3_REGION,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
        ...(env.S3_ENDPOINT === undefined ? {} : { endpoint: env.S3_ENDPOINT }),
        // Checksums only where S3 requires them. The SDK's default (since 3.729) adds a
        // CRC32 of the (empty) body to every presigned PUT, which then rejects the
        // browser's real upload with a checksum mismatch; S3-compatible services also
        // differ in what they accept. Integrity is checked end to end instead (sizes are
        // signed; Creator Studio parts carry SHA-256 the worker verifies).
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        requestHandler: {
          connectionTimeout: timeouts.connectionMs,
          socketTimeout: timeouts.idleMs,
        },
      });
  }

  async put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: AllowedContentType },
  ): Promise<void> {
    assertValidKey(key);
    await withinDeadline(
      "put",
      transferDeadlineMs(body.byteLength, this.timeouts),
      undefined,
      (abortSignal) =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: options.contentType,
          }),
          { abortSignal },
        ),
    );
  }

  async delete(key: string, options: StorageDeleteOptions = {}): Promise<void> {
    assertValidKey(key);
    // The SDK aborts the HTTP request on `signal` or the deadline; S3 may still have
    // applied the delete. Deleting a missing object succeeds, so a retry is safe.
    await withinDeadline("delete", this.timeouts.deleteMs, options.signal, (abortSignal) =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal,
      }),
    );
  }

  async getSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<SignedUpload> {
    assertValidKey(key);
    assertUploadAllowed(options.category, options.contentType, options.contentLength);
    const expiresIn = resolveTtl(options.expiresInSeconds);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    });
    // Signing Content-Type and Content-Length means the upload must match the declared
    // (already size-checked) values, so clients cannot exceed the category limit.
    const url = await getSignedUrl(this.client, command, {
      expiresIn,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
    return {
      url,
      method: "PUT",
      headers: {
        "content-type": options.contentType,
        "content-length": String(options.contentLength),
      },
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async getSignedDownloadUrl(
    key: string,
    options: { readonly expiresInSeconds?: number } = {},
  ): Promise<string> {
    assertValidKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: resolveTtl(options.expiresInSeconds),
    });
  }

  publicUrl(key: string): string | null {
    assertValidKey(key);
    return this.publicBaseUrl === undefined ? null : `${this.publicBaseUrl}/${key}`;
  }

  /** HEAD on the bucket: proves endpoint, region, bucket and credentials; touches no object. */
  async checkAccess(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    try {
      await withinDeadline("check", this.timeouts.accessCheckMs, options.signal, (abortSignal) =>
        this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal }),
      );
    } catch (error) {
      throw new StorageAccessError(classifyAccessError(error));
    }
  }

  /**
   * The bucket's CORS and lifecycle rules, for the staging preflight (read only; null when
   * the bucket has none). Only the fields the preflight checks are returned.
   */
  async readBucketRules(options: { readonly signal?: AbortSignal } = {}): Promise<BucketRules> {
    const read = async <T>(work: (abortSignal: AbortSignal) => Promise<T>, missing: string) => {
      try {
        return await withinDeadline("check", this.timeouts.accessCheckMs, options.signal, work);
      } catch (error) {
        if (error instanceof Error && error.name === missing) return null;
        throw new StorageAccessError(classifyAccessError(error));
      }
    };
    const cors = await read(
      (abortSignal) =>
        this.client.send(new GetBucketCorsCommand({ Bucket: this.bucket }), { abortSignal }),
      "NoSuchCORSConfiguration",
    );
    const lifecycle = await read(
      (abortSignal) =>
        this.client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }), {
          abortSignal,
        }),
      "NoSuchLifecycleConfiguration",
    );
    return {
      cors:
        cors?.CORSRules?.map((rule) => ({
          allowedOrigins: rule.AllowedOrigins ?? [],
          allowedMethods: rule.AllowedMethods ?? [],
          allowedHeaders: rule.AllowedHeaders ?? [],
        })) ?? null,
      lifecycle:
        lifecycle?.Rules?.map((rule) => ({
          enabled: rule.Status === "Enabled",
          abortIncompleteMultipartDays:
            rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
        })) ?? null,
    };
  }

  async getObject(key: string, options: GetObjectOptions = {}): Promise<StoredObjectData | null> {
    assertValidKey(key);
    try {
      // One signal for the response and reading the body: aborting it destroys the
      // response stream and its socket.
      return await withinDeadline(
        "get",
        downloadDeadlineMs(options.expectedBytes, this.timeouts),
        options.signal,
        async (abortSignal) => {
          const result = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            { abortSignal },
          );
          if (result.Body === undefined) return null;
          return {
            body: await result.Body.transformToByteArray(),
            contentType: result.ContentType ?? null,
          };
        },
      );
    } catch (error) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
        return null;
      }
      throw error;
    }
  }

  async downloadToFile(
    key: string,
    path: string,
    options: DownloadToFileOptions,
  ): Promise<number | null> {
    assertValidKey(key);
    try {
      return await withinDeadline(
        "get",
        transferDeadlineMs(options.expectedBytes, this.timeouts),
        options.signal,
        async (abortSignal) => {
          const result = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            { abortSignal },
          );
          if (result.Body === undefined) return null;
          const body =
            result.Body instanceof Readable
              ? result.Body
              : Readable.fromWeb(
                  (
                    result.Body as { transformToWebStream(): ReadableStream }
                  ).transformToWebStream() as never,
                );
          return writeCapped(body, path, options.maxBytes, abortSignal);
        },
      );
    } catch (error) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
        return null;
      }
      throw error;
    }
  }

  readonly multipart: MultipartStorage = {
    create: async (key, options) => {
      assertValidKey(key);
      const result = await withinDeadline("put", this.timeouts.deleteMs, undefined, (abortSignal) =>
        this.client.send(
          new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: options.contentType,
          }),
          { abortSignal },
        ),
      );
      if (result.UploadId === undefined || result.UploadId === "") {
        throw new Error("Storage returned no multipart upload id");
      }
      return result.UploadId;
    },
    signPart: async (key, uploadId, partNumber, options) => {
      assertValidKey(key);
      const expiresIn = resolveTtl(options.expiresInSeconds);
      // The signed Content-Length binds the URL to that part's exact size.
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentLength: options.contentLength,
        }),
        { expiresIn, signableHeaders: new Set(["content-length"]) },
      );
      return {
        url,
        method: "PUT",
        headers: { "content-length": String(options.contentLength) },
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    },
    listParts: async (key, uploadId, options = {}) => {
      assertValidKey(key);
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      try {
        for (let page = 0; page < 20; page += 1) {
          const result = await withinDeadline(
            "get",
            this.timeouts.deleteMs,
            options.signal,
            (abortSignal) =>
              this.client.send(
                new ListPartsCommand({
                  Bucket: this.bucket,
                  Key: key,
                  UploadId: uploadId,
                  MaxParts: 1000,
                  ...(marker === undefined ? {} : { PartNumberMarker: marker }),
                }),
                { abortSignal },
              ),
          );
          for (const part of result.Parts ?? []) {
            if (part.PartNumber === undefined || part.Size === undefined || part.ETag === undefined)
              continue;
            parts.push({ partNumber: part.PartNumber, size: part.Size, etag: part.ETag });
          }
          if (result.IsTruncated !== true || result.NextPartNumberMarker === undefined) break;
          marker = result.NextPartNumberMarker;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "NoSuchUpload") return null;
        throw error;
      }
      return parts;
    },
    complete: async (key, uploadId, parts) => {
      assertValidKey(key);
      await withinDeadline("put", this.timeouts.deleteMs * 2, undefined, (abortSignal) =>
        this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
            },
          }),
          { abortSignal },
        ),
      );
    },
    abort: async (key, uploadId, options = {}) => {
      assertValidKey(key);
      try {
        await withinDeadline("delete", this.timeouts.deleteMs, options.signal, (abortSignal) =>
          this.client.send(
            new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
            { abortSignal },
          ),
        );
      } catch (error) {
        if (error instanceof Error && error.name === "NoSuchUpload") return;
        throw error;
      }
    },
  };
}

/**
 * Pipes `body` into a new file at `path`, failing once more than `maxBytes` arrive; a
 * failed or cut-off transfer leaves no file behind. Resolves with the bytes written.
 */
export async function writeCapped(
  body: Readable,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<number> {
  let written = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.byteLength;
      if (written > maxBytes) {
        callback(new ObjectTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(body, cap, createWriteStream(path, { flags: "wx" }), { signal });
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return written;
}
