import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageEnv } from "../env-schema";
import {
  assertUploadAllowed,
  assertValidKey,
  resolveTtl,
  StorageAccessError,
  type AllowedContentType,
  type SignedUpload,
  type SignedUploadOptions,
  type StorageAccessFailure,
  type StorageDeleteOptions,
  type StorageService,
  type StoredObjectData,
} from "./storage";

/**
 * Maps an SDK error to a failure code. Only the error's name and HTTP status are read:
 * provider messages can contain hosts or request details and are never surfaced.
 */
export function classifyAccessError(error: unknown): StorageAccessFailure {
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

  constructor(env: StorageEnv, client?: S3Client) {
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
      });
  }

  async put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: AllowedContentType },
  ): Promise<void> {
    assertValidKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
      }),
    );
  }

  async delete(key: string, options: StorageDeleteOptions = {}): Promise<void> {
    assertValidKey(key);
    // The SDK aborts the HTTP request on `signal`; S3 may still have applied the delete.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      options.signal === undefined ? {} : { abortSignal: options.signal },
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
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        options.signal === undefined ? {} : { abortSignal: options.signal },
      );
    } catch (error) {
      throw new StorageAccessError(classifyAccessError(error));
    }
  }

  async getObject(key: string): Promise<StoredObjectData | null> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (result.Body === undefined) return null;
      return {
        body: await result.Body.transformToByteArray(),
        contentType: result.ContentType ?? null,
      };
    } catch (error) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
        return null;
      }
      throw error;
    }
  }
}
