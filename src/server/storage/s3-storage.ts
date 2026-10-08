import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageEnv } from "../env-schema";
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

/** S3-compatible implementation (AWS S3, MinIO, Cloudflare R2). Bucket is private by default. */
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

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
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
