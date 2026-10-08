import type { Prisma } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import type { Logger } from "../logger";
import {
  assertKeyBelongsToWorkspace,
  assertUploadAllowed,
  buildWorkspaceKey,
  STORAGE_CATEGORIES,
  type StorageService,
} from "../storage/storage";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import { changedFields, limitReached, notFound } from "./common";
import { sanitizeFilename, sniffImage } from "./image";

// Workspace media library (images). List/view: content.view; upload: content.create;
// alt text and delete: content.edit. Bytes live in object storage under a server-built
// key `workspaces/{workspaceId}/content-media/{uuid}.{ext}`; the database row is the only
// way to reach them, through an access-checked route (no public URLs).

export const MAX_MEDIA_ASSETS = 500;
export const MEDIA_MAX_BYTES = STORAGE_CATEGORIES["content-media"].maxBytes;

const assetSelect = {
  id: true,
  filename: true,
  contentType: true,
  sizeBytes: true,
  width: true,
  height: true,
  altText: true,
  createdAt: true,
  uploadedBy: { select: { name: true } },
  _count: { select: { contentLinks: true } },
} as const;

export type MediaAssetRow = Prisma.MediaAssetGetPayload<{ select: typeof assetSelect }>;

export async function listMedia(db: Db, ctx: TenantContext): Promise<MediaAssetRow[]> {
  assertCan(ctx, "content.view");
  return db.mediaAsset.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_MEDIA_ASSETS,
    select: assetSelect,
  });
}

export interface UploadedFile {
  readonly name: string;
  readonly size: number;
  readonly bytes: () => Promise<Uint8Array>;
}

/**
 * Stores an uploaded image. The size is checked before the bytes are read; the type and
 * dimensions come from the file's own header (`sniffImage`), never from the browser. The
 * object is written first and removed again if the database insert fails, so a row never
 * points at a missing object.
 */
export async function uploadMedia(
  db: GuardedPrismaClient,
  storage: StorageService,
  ctx: TenantContext,
  file: UploadedFile,
  altText: string | null = null,
  logger?: Logger,
): Promise<{ readonly assetId: string }> {
  assertCan(ctx, "content.create");
  if (file.size <= 0) {
    throw new AppError("VALIDATION_FAILED", { fields: [{ path: "file", code: "file_required" }] });
  }
  if (file.size > MEDIA_MAX_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      fields: [{ path: "file", code: "too_big", params: { maximum: MEDIA_MAX_BYTES } }],
      metadata: { size: file.size },
    });
  }
  const bytes = await file.bytes();
  const image = sniffImage(bytes);
  if (image === null) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", {
      fields: [{ path: "file", code: "image_invalid" }],
    });
  }
  assertUploadAllowed("content-media", image.contentType, bytes.byteLength);

  const count = await db.mediaAsset.count({ where: { workspaceId: ctx.workspaceId } });
  if (count >= MAX_MEDIA_ASSETS) throw limitReached("asset", MAX_MEDIA_ASSETS);

  const storageKey = buildWorkspaceKey(ctx.workspaceId, "content-media", image.contentType);
  await storage.put(storageKey, bytes, { contentType: image.contentType });
  try {
    return await db.$transaction(async (tx) => {
      const created = await tx.mediaAsset.create({
        data: {
          workspaceId: ctx.workspaceId,
          filename: sanitizeFilename(file.name),
          contentType: image.contentType,
          sizeBytes: bytes.byteLength,
          storageKey,
          width: image.width,
          height: image.height,
          altText,
          uploadedByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await recordAudit(tx, ctx, {
        action: "asset.created",
        entityType: "asset",
        entityId: created.id,
        metadata: { contentType: image.contentType, sizeBytes: bytes.byteLength },
      });
      return { assetId: created.id };
    });
  } catch (error) {
    await storage.delete(storageKey).catch((cleanupError: unknown) => {
      logger?.error({ err: cleanupError }, "Could not remove an orphaned media object");
    });
    throw error;
  }
}

export async function updateMediaAltText(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  assetId: string,
  altText: string | null,
): Promise<{ readonly assetId: string }> {
  assertCan(ctx, "content.edit");
  return db.$transaction(async (tx) => {
    const existing = await tx.mediaAsset.findFirst({
      where: { workspaceId: ctx.workspaceId, id: assetId },
      select: { altText: true },
    });
    if (existing === null) throw notFound("asset");
    if (changedFields(existing, { altText }).length === 0) return { assetId };
    await tx.mediaAsset.updateMany({
      where: { workspaceId: ctx.workspaceId, id: assetId },
      data: { altText },
    });
    await recordAudit(tx, ctx, {
      action: "asset.updated",
      entityType: "asset",
      entityId: assetId,
      metadata: { fields: ["altText"] },
    });
    return { assetId };
  });
}

/**
 * Deletes an asset: the row (and its content links) in one transaction, then the stored
 * object. If removing the object fails it is logged — an unreachable orphan, never a
 * row pointing at nothing.
 */
export async function deleteMedia(
  db: GuardedPrismaClient,
  storage: StorageService,
  ctx: TenantContext,
  assetId: string,
  logger?: Logger,
): Promise<{ readonly assetId: string }> {
  assertCan(ctx, "content.edit");
  const storageKey = await db.$transaction(async (tx) => {
    const existing = await tx.mediaAsset.findFirst({
      where: { workspaceId: ctx.workspaceId, id: assetId },
      select: { storageKey: true, _count: { select: { contentLinks: true } } },
    });
    if (existing === null) throw notFound("asset");
    await tx.mediaAsset.deleteMany({ where: { workspaceId: ctx.workspaceId, id: assetId } });
    await recordAudit(tx, ctx, {
      action: "asset.deleted",
      entityType: "asset",
      entityId: assetId,
      metadata: { contentLinks: existing._count.contentLinks },
    });
    return existing.storageKey;
  });
  assertKeyBelongsToWorkspace(storageKey, ctx.workspaceId);
  await storage.delete(storageKey).catch((error: unknown) => {
    logger?.error({ err: error, assetId }, "Could not remove a deleted asset's stored object");
  });
  return { assetId };
}

/**
 * The bytes of one asset for the access-checked media route. The key comes from this
 * workspace's row and is re-checked against the workspace before storage is read.
 */
export async function readMedia(
  db: Db,
  storage: StorageService,
  ctx: TenantContext,
  assetId: string,
): Promise<{ readonly body: Uint8Array; readonly contentType: string; readonly filename: string }> {
  assertCan(ctx, "content.view");
  const asset = await db.mediaAsset.findFirst({
    where: { workspaceId: ctx.workspaceId, id: assetId },
    select: { storageKey: true, contentType: true, filename: true },
  });
  if (asset === null) throw notFound("asset");
  assertKeyBelongsToWorkspace(asset.storageKey, ctx.workspaceId);
  const object = await storage.getObject(asset.storageKey);
  if (object === null) throw notFound("asset");
  return { body: object.body, contentType: asset.contentType, filename: asset.filename };
}
