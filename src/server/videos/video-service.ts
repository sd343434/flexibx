import "server-only";

import { recordAudit } from "../audit/audit-log";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import {
  assertKeyBelongsToWorkspace,
  type StorageProviderId,
  type StorageRouter,
} from "../storage/storage";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import type { GeneratedVideoFileKind } from "@/generated/prisma/enums";

// Generated videos of a workspace: recording a successful generation, listing with the
// retention schedule, and serving files until they expire. Expiry is enforced here as
// well as by the retention job, so a file is never served after expires_at even if the
// job has not run yet. Timestamps come from the database, never from the caller.

const notFound = () => new AppError("NOT_FOUND", { metadata: { resource: "generated_video" } });

/**
 * The database clock. Expiry is computed by the database, so availability checks use the
 * same clock: an application server running fast or slow cannot serve an expired file.
 */
export async function databaseNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  const now = rows[0]?.now;
  if (now === undefined) throw new Error("Could not read the database clock");
  return now;
}

export interface GeneratedVideoFileInput {
  readonly kind: GeneratedVideoFileKind;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface GeneratedVideoInput {
  readonly title: string;
  readonly provider: string;
  readonly model?: string | null;
  readonly providerJobId?: string | null;
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly costMicros?: bigint | null;
  /**
   * The provider the files were written to (the write target used by the pipeline).
   * Required: never defaulted, so a row cannot claim the wrong provider.
   */
  readonly storageProvider: StorageProviderId;
  readonly files: readonly GeneratedVideoFileInput[];
}

/**
 * Records a successfully generated video and its stored files (called by the video
 * pipeline after the output is validated and stored). succeeded_at is the database's
 * now(); expires_at = succeeded_at + 168 h is set by the database. Pass a transaction
 * client so the record and its audit entry are atomic, and call the write target's
 * `confirm(tx)` in that same transaction first (the storage location must still be the
 * one the files were written to; see StorageWriteTarget).
 */
export async function recordGeneratedVideo(db: Db, ctx: TenantContext, input: GeneratedVideoInput) {
  assertCan(ctx, "content.create");
  if (input.files.filter((file) => file.kind === "VIDEO").length !== 1) {
    throw new AppError("VALIDATION_FAILED", {
      message: "A generated video needs exactly one VIDEO file",
    });
  }
  for (const file of input.files) assertKeyBelongsToWorkspace(file.storageKey, ctx.workspaceId);

  const video = await db.generatedVideo.create({
    data: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      title: input.title.trim().slice(0, 200),
      provider: input.provider,
      model: input.model ?? null,
      providerJobId: input.providerJobId ?? null,
      durationSeconds: input.durationSeconds,
      width: input.width,
      height: input.height,
      costMicros: input.costMicros ?? null,
    },
    select: { id: true, succeededAt: true, expiresAt: true },
  });
  await db.generatedVideoFile.createMany({
    data: input.files.map((file) => ({
      workspaceId: ctx.workspaceId,
      videoId: video.id,
      kind: file.kind,
      storageKey: file.storageKey,
      storageProvider: input.storageProvider,
      contentType: file.contentType,
      byteSize: file.byteSize,
    })),
  });
  await recordAudit(db, ctx, {
    action: "video.generated",
    entityType: "generated_video",
    entityId: video.id,
    metadata: {
      provider: input.provider,
      model: input.model ?? null,
      durationSeconds: input.durationSeconds,
      costMicros:
        input.costMicros === undefined || input.costMicros === null
          ? null
          : input.costMicros.toString(),
      fileCount: input.files.length,
      expiresAt: video.expiresAt.toISOString(),
    },
  });
  return video;
}

const LIST_SELECT = (workspaceId: string) =>
  ({
    id: true,
    title: true,
    durationSeconds: true,
    width: true,
    height: true,
    status: true,
    succeededAt: true,
    expiresAt: true,
    filesDeletedAt: true,
    files: { where: { workspaceId, deletedAt: null }, select: { kind: true } },
  }) as const;

/** At most this many still-stored videos are listed (7 days of output for one workspace). */
export const MAX_ACTIVE_VIDEOS_LISTED = 500;

/**
 * The workspace's generated videos with their retention schedule: every video whose files
 * still exist (so each one's deletion time is visible), soonest deletion first, then the
 * most recently deleted ones.
 */
export async function listGeneratedVideos(
  db: Db,
  ctx: TenantContext,
  options: { readonly deletedLimit?: number } = {},
) {
  assertCan(ctx, "content.view");
  const deletedTake = Math.min(Math.max(options.deletedLimit ?? 20, 0), 100);
  const [active, deleted] = await Promise.all([
    db.generatedVideo.findMany({
      where: { workspaceId: ctx.workspaceId, status: { in: ["AVAILABLE", "DELETING"] } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: MAX_ACTIVE_VIDEOS_LISTED,
      select: LIST_SELECT(ctx.workspaceId),
    }),
    deletedTake === 0
      ? Promise.resolve([])
      : db.generatedVideo.findMany({
          where: { workspaceId: ctx.workspaceId, status: "DELETED" },
          orderBy: [{ filesDeletedAt: "desc" }, { id: "desc" }],
          take: deletedTake,
          select: LIST_SELECT(ctx.workspaceId),
        }),
  ]);
  return [...active, ...deleted].map(({ files, ...video }) => ({
    ...video,
    hasThumbnail: files.some((file) => file.kind === "THUMBNAIL"),
  }));
}

/** How many still-available videos are deleted within `hours` (in-app warning banner). */
export async function countVideosExpiringWithin(
  db: Db,
  ctx: TenantContext,
  hours: number,
  now: Date,
): Promise<number> {
  assertCan(ctx, "content.view");
  return db.generatedVideo.count({
    where: {
      workspaceId: ctx.workspaceId,
      status: "AVAILABLE",
      expiresAt: { gt: now, lte: new Date(now.getTime() + hours * 60 * 60 * 1000) },
    },
  });
}

const DOWNLOADABLE_KINDS = ["VIDEO", "THUMBNAIL"] as const;
export type DownloadableKind = (typeof DOWNLOADABLE_KINDS)[number];

export function isDownloadableKind(value: string): value is DownloadableKind {
  return (DOWNLOADABLE_KINDS as readonly string[]).includes(value);
}

function downloadName(title: string, contentType: string): string {
  const base =
    title
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .slice(0, 80) || "video";
  return `${base}.${contentType === "image/jpeg" ? "jpg" : (contentType.split("/")[1] ?? "bin")}`;
}

/**
 * The bytes of a video (or its thumbnail) while it is still available. Anything
 * expired — even before the retention job has deleted it — deleting, deleted, from
 * another workspace or unknown is the same NOT_FOUND.
 */
export async function readGeneratedVideoFile(
  db: Db,
  storage: StorageRouter,
  ctx: TenantContext,
  videoId: string,
  kind: DownloadableKind,
  at?: Date,
) {
  assertCan(ctx, "content.view");
  if (!isUuid(videoId)) throw notFound();
  const now = at ?? (await databaseNow(db));
  const video = await db.generatedVideo.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      id: videoId,
      status: "AVAILABLE",
      expiresAt: { gt: now },
    },
    select: { title: true },
  });
  if (video === null) throw notFound();
  const file = await db.generatedVideoFile.findFirst({
    where: { workspaceId: ctx.workspaceId, videoId, kind, deletedAt: null },
    select: { storageKey: true, storageProvider: true, contentType: true },
  });
  if (file === null) throw notFound();
  assertKeyBelongsToWorkspace(file.storageKey, ctx.workspaceId);
  // The provider the file was written to, whatever is configured for new objects.
  const object = await (await storage.forProvider(file.storageProvider)).getObject(file.storageKey);
  if (object === null) throw notFound();
  return {
    body: object.body,
    contentType: file.contentType,
    filename: downloadName(video.title, file.contentType),
  };
}
