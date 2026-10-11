import { randomUUID } from "node:crypto";

import { AppError } from "../errors/app-error";
import { isUuid } from "../tenancy/context";

import type { StorageProvider } from "@/generated/prisma/enums";

/**
 * Object storage abstraction. PostgreSQL stores only object keys + metadata; bytes live
 * in S3-compatible storage. Implementations: S3 (any S3-compatible service; Wasabi is
 * configured through it, see wasabi-storage.ts) and in-memory (tests). Application code
 * never imports a provider SDK: it gets services from the router in ./providers.ts.
 */
export interface StorageService {
  put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: AllowedContentType },
  ): Promise<void>;
  /**
   * Deletes the object; deleting a missing object succeeds. `signal` aborts the request
   * where the adapter supports it. An aborted delete may still have reached storage, so
   * callers treat it as unconfirmed, never as "not deleted".
   */
  delete(key: string, options?: StorageDeleteOptions): Promise<void>;
  /** Presigned PUT. The signed Content-Type and Content-Length must match the upload. */
  getSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<SignedUpload>;
  getSignedDownloadUrl(
    key: string,
    options?: { readonly expiresInSeconds?: number },
  ): Promise<string>;
  /** Public URL if a public base URL (CDN) is configured, otherwise null (private bucket). */
  publicUrl(key: string): string | null;
  /** The object's bytes, or null when it does not exist (served through access-checked routes). */
  getObject(key: string): Promise<StoredObjectData | null>;
  /**
   * Checks that the configured bucket is reachable with the configured credentials,
   * without reading or writing objects. Rejects with a StorageAccessError. Optional: a
   * provider without it cannot pass the platform admin's connection test.
   */
  checkAccess?(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

/**
 * Where an object is stored (Prisma enum `StorageProvider`). Every object row records it,
 * and reads and deletes always go to that provider — never to whichever provider is
 * currently configured for new writes.
 */
export type StorageProviderId = StorageProvider;

/** Resolves the storage service holding objects of a provider. */
export interface StorageRouter {
  /** Throws SERVICE_UNAVAILABLE when that provider is not (fully) configured. */
  forProvider(provider: StorageProviderId): Promise<StorageService>;
}

/** Raw SQL inside the database transaction that records a new object row. */
export interface StorageTransaction {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Where new objects are written: the provider recorded on the row, and its service. */
export interface StorageWriteTarget {
  readonly provider: StorageProviderId;
  readonly storage: StorageService;
  /**
   * Call inside the transaction that inserts the object's row, before the insert. It
   * share-locks the platform storage settings and throws CONFLICT if the provider's
   * location changed since this target was resolved (the object was written to a
   * location the row would no longer point at). The lock is held until that transaction
   * ends, so a location change cannot slip in between this check and the insert. On
   * CONFLICT the writer removes the object it wrote and the user retries.
   */
  confirm(tx: StorageTransaction): Promise<void>;
}

/** Why a connection check failed (codes only: no endpoints, keys or provider messages). */
export type StorageAccessFailure =
  "access_denied" | "bucket_not_found" | "wrong_region" | "timeout" | "unreachable" | "failed";

export class StorageAccessError extends Error {
  constructor(readonly failure: StorageAccessFailure) {
    super(`Storage access check failed: ${failure}`);
    this.name = "StorageAccessError";
  }
}

export interface StorageDeleteOptions {
  readonly signal?: AbortSignal;
}

export interface StoredObjectData {
  readonly body: Uint8Array;
  readonly contentType: string | null;
}

export interface SignedUploadOptions {
  readonly contentType: AllowedContentType;
  readonly contentLength: number;
  readonly category: StorageCategory;
  readonly expiresInSeconds?: number;
}

export interface SignedUpload {
  readonly url: string;
  readonly method: "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

/** Allowed content types → file extension. Anything else is rejected. */
export const CONTENT_TYPE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
} as const;

export type AllowedContentType = keyof typeof CONTENT_TYPE_EXTENSIONS;

const MiB = 1024 * 1024;

/** Storage categories, their size limits and permitted content types. */
export const STORAGE_CATEGORIES = {
  logos: {
    maxBytes: 5 * MiB,
    contentTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  },
  "brand-assets": {
    maxBytes: 20 * MiB,
    contentTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  },
  "product-images": { maxBytes: 20 * MiB, contentTypes: ["image/png", "image/jpeg", "image/webp"] },
  "generated-images": {
    maxBytes: 20 * MiB,
    contentTypes: ["image/png", "image/jpeg", "image/webp"],
  },
  "generated-videos": { maxBytes: 500 * MiB, contentTypes: ["video/mp4", "video/webm"] },
  // Marketing Core media library (Phase 3): raster images only (no SVG: it can carry script).
  "content-media": { maxBytes: 10 * MiB, contentTypes: ["image/png", "image/jpeg", "image/webp"] },
} as const satisfies Record<
  string,
  { maxBytes: number; contentTypes: readonly AllowedContentType[] }
>;

export type StorageCategory = keyof typeof STORAGE_CATEGORIES;

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;

const KEY_PATTERN =
  /^workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z-]+)\/[0-9a-f-]{36}\.[a-z0-9]+$/;

export function isAllowedContentType(value: string): value is AllowedContentType {
  return Object.hasOwn(CONTENT_TYPE_EXTENSIONS, value);
}

export function isStorageCategory(value: string): value is StorageCategory {
  return Object.hasOwn(STORAGE_CATEGORIES, value);
}

/**
 * Builds a server-generated, tenant-prefixed object key:
 * `workspaces/{workspaceId}/{category}/{uuid}.{ext}`. Client-chosen file names are never
 * used in keys, which rules out path traversal and cross-tenant overwrites.
 */
export function buildWorkspaceKey(
  workspaceId: string,
  category: StorageCategory,
  contentType: AllowedContentType,
): string {
  if (!isUuid(workspaceId)) {
    throw new AppError("VALIDATION_FAILED", { message: "Invalid workspace id for storage key" });
  }
  assertUploadAllowed(category, contentType);
  return `workspaces/${workspaceId.toLowerCase()}/${category}/${randomUUID()}.${CONTENT_TYPE_EXTENSIONS[contentType]}`;
}

/** Parses a key produced by `buildWorkspaceKey`; returns null for anything else. */
export function parseWorkspaceKey(
  key: string,
): { workspaceId: string; category: StorageCategory } | null {
  const match = KEY_PATTERN.exec(key);
  if (match === null) return null;
  const [, workspaceId, category] = match;
  if (workspaceId === undefined || category === undefined || !isStorageCategory(category))
    return null;
  return { workspaceId, category };
}

/** Throws NOT_FOUND unless the key is a well-formed key owned by the given workspace. */
export function assertKeyBelongsToWorkspace(key: string, workspaceId: string): void {
  const parsed = parseWorkspaceKey(key);
  if (parsed?.workspaceId !== workspaceId.toLowerCase()) {
    throw new AppError("NOT_FOUND", {
      message: "Storage key does not belong to workspace",
      metadata: { workspaceId },
    });
  }
}

export function assertUploadAllowed(
  category: StorageCategory,
  contentType: AllowedContentType,
  contentLength?: number,
): void {
  const rule = STORAGE_CATEGORIES[category];
  if (!(rule.contentTypes as readonly string[]).includes(contentType)) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", { metadata: { category, contentType } });
  }
  if (
    contentLength !== undefined &&
    (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > rule.maxBytes)
  ) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      metadata: { category, contentLength, maxBytes: rule.maxBytes },
    });
  }
}

export function resolveTtl(expiresInSeconds?: number): number {
  const ttl = expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.min(Math.max(Math.floor(ttl), 1), MAX_SIGNED_URL_TTL_SECONDS);
}

export function assertValidKey(key: string): void {
  if (parseWorkspaceKey(key) === null) {
    throw new AppError("VALIDATION_FAILED", { message: "Invalid storage key", metadata: { key } });
  }
}
