import type { PrismaClient } from "@/generated/prisma/client";
import type { CreatorAspectRatio } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import { releaseHold } from "../billing/credits";
import { FEATURE_PRICES } from "../billing/pricing";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import {
  assertUploadAllowed,
  buildWorkspaceKey,
  CREATOR_SINGLE_UPLOAD_MAX_BYTES,
  CREATOR_SOURCE_MAX_BYTES,
  STORAGE_CATEGORIES,
  type AllowedContentType,
  type StorageService,
} from "../storage/storage";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import {
  billedMinutes,
  JOB_DEADLINE_MS,
  MAX_CLIP_MS,
  MIN_CLIP_MS,
  PART_URL_TTL_SECONDS,
  partSizeFor,
  UPLOAD_CLEANUP_GRACE_MS,
  UPLOAD_TTL_SECONDS,
  type CreatorDeps,
} from "./config";
import { queueStorageDeletions } from "./deletions";
import { creatorError } from "./errors";
import { enqueueJob, recordEvent } from "./jobs";
import { toSrt, toVtt } from "./media/media";
import { isSourceContentType } from "./media/sniff";
import { LANGUAGE_PATTERN } from "./providers/types";

// What a person does in the Creator Studio: projects, uploads, starting work, editing
// the transcript and clips, reviewing and exporting. Every function takes the caller's
// TenantContext (resolved from the session's membership), re-checks the role, and scopes
// every query to the workspace; an id from another workspace reads as not found. Pure
// (no `server-only`) for integration tests.

const notFound = (resource: string) => new AppError("NOT_FOUND", { metadata: { resource } });

async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  return rows[0]?.now ?? new Date();
}

/**
 * The caller's project. A project being deleted can still be looked at (its deletion
 * status) but nothing new starts in it: `active` refuses it.
 */
async function projectOf(
  db: Db,
  ctx: TenantContext,
  projectId: string,
  mode: "active" | "any" = "active",
) {
  if (!isUuid(projectId)) throw notFound("creator_project");
  const project = await db.creatorProject.findFirst({
    where: { id: projectId, workspaceId: ctx.workspaceId },
    select: { id: true, name: true, status: true, version: true },
  });
  if (project === null) throw notFound("creator_project");
  if (mode === "active" && project.status === "DELETING") {
    throw creatorError("CONFLICT", "creator_project_deleting");
  }
  return project;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

// ── Projects ──────────────────────────────────────────────────────────────────

export async function createProject(
  db: Db,
  ctx: TenantContext,
  input: { readonly name: string; readonly description: string | null },
): Promise<{ id: string }> {
  assertCan(ctx, "content.create");
  return db.$transaction(async (tx) => {
    const project = await tx.creatorProject.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: input.name,
        description: input.description,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordEvent(tx, ctx.workspaceId, project.id, "project_created", ctx.userId);
    await recordAudit(tx, ctx, {
      action: "creator.project_created",
      entityType: "creator_project",
      entityId: project.id,
    });
    return project;
  });
}

export async function listProjects(db: Db, ctx: TenantContext) {
  assertCan(ctx, "content.view");
  return db.creatorProject.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      status: true,
      updatedAt: true,
      _count: { select: { clips: true, exports: true } },
    },
  });
}

/** Everything the project page shows, plus what processing would cost. */
export async function getProject(deps: CreatorDeps, ctx: TenantContext, projectId: string) {
  assertCan(ctx, "content.view");
  const { db } = deps;
  await projectOf(db, ctx, projectId, "any");
  const where = { workspaceId: ctx.workspaceId, projectId };
  const [project, sources, jobs, transcripts, clips, exports, events] = await Promise.all([
    db.creatorProject.findFirst({
      where: { id: projectId, workspaceId: ctx.workspaceId },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        version: true,
        createdAt: true,
        deletedAt: true,
      },
    }),
    db.creatorSource.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        originalName: true,
        declaredBytes: true,
        uploadExpiresAt: true,
        container: true,
        durationMs: true,
        width: true,
        height: true,
        hasAudio: true,
        hasVideo: true,
        rejectionCode: true,
        uploadMode: true,
        partSizeBytes: true,
        partCount: true,
        createdAt: true,
      },
    }),
    db.creatorJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        kind: true,
        state: true,
        stage: true,
        attempts: true,
        maxAttempts: true,
        failureCode: true,
        runAfter: true,
        createdAt: true,
        finishedAt: true,
        steps: {
          orderBy: { position: "asc" },
          select: { stage: true, state: true, attempts: true, errorCode: true, simulated: true },
        },
      },
    }),
    db.creatorTranscript.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        kind: true,
        language: true,
        provider: true,
        simulated: true,
        segmentCount: true,
        translatedFromId: true,
        editedAt: true,
        segments: {
          orderBy: { position: "asc" },
          take: 2000,
          select: {
            id: true,
            position: true,
            startMs: true,
            endMs: true,
            text: true,
            edited: true,
          },
        },
      },
    }),
    db.creatorClip.findMany({
      where,
      orderBy: { startMs: "asc" },
      take: 100,
      select: {
        id: true,
        title: true,
        startMs: true,
        endMs: true,
        suggestedStartMs: true,
        suggestedEndMs: true,
        text: true,
        reasons: true,
        score: true,
        status: true,
        origin: true,
        simulated: true,
        cropX: true,
        version: true,
      },
    }),
    db.creatorExport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        clipId: true,
        status: true,
        aspectRatio: true,
        burnSubtitles: true,
        startMs: true,
        endMs: true,
        byteSize: true,
        durationMs: true,
        width: true,
        height: true,
        failureCode: true,
        createdAt: true,
        readyAt: true,
      },
    }),
    db.creatorProjectEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, type: true, metadata: true, createdAt: true },
    }),
  ]);
  if (project === null) throw notFound("creator_project");
  const deletion =
    project.status === "DELETING"
      ? {
          pending: await db.creatorStorageDeletion.count({
            where: { ...where, completedAt: null },
          }),
          failing: await db.creatorStorageDeletion.count({
            where: { ...where, completedAt: null, lastErrorCode: { not: null } },
          }),
        }
      : null;
  const source = sources.find((row) => row.status === "VERIFIED") ?? null;
  const durationMs = source?.durationMs ?? null;
  const minutes = durationMs === null ? null : billedMinutes(durationMs);
  return {
    project,
    sources,
    source,
    jobs,
    transcripts,
    clips,
    exports,
    events,
    deletion,
    provider:
      deps.transcription === null
        ? null
        : {
            id: deps.transcription.id,
            model: deps.transcription.model,
            simulated: deps.transcription.simulated,
            external: deps.transcription.external,
            region: deps.transcription.region,
            translation: deps.translation === null ? null : deps.translation.model,
          },
    estimate: {
      minutes,
      // Simulated text is never charged.
      transcriptionCredits:
        minutes === null || deps.transcription?.simulated !== false
          ? 0
          : minutes * FEATURE_PRICES.creator_transcription,
      translationCreditsPerLanguage:
        minutes === null || deps.translation?.simulated !== false
          ? 0
          : minutes * FEATURE_PRICES.creator_translation,
      exportCreditsPerMinute: FEATURE_PRICES.creator_export,
    },
    limits: {
      maxUploadBytes: Math.min(deps.limits.maxUploadBytes, CREATOR_SOURCE_MAX_BYTES),
      maxDurationMs: deps.limits.maxDurationMs,
      singleUploadMaxBytes: CREATOR_SINGLE_UPLOAD_MAX_BYTES,
    },
  };
}

// ── Uploads ───────────────────────────────────────────────────────────────────

/** A file name without control characters (it is shown on pages and in logs). */
// eslint-disable-next-line no-control-regex -- intentionally removes control characters
const printable = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "");

export type UploadTransport =
  | {
      readonly kind: "direct";
      readonly url: string;
      readonly method: "PUT";
      readonly headers: Readonly<Record<string, string>>;
      readonly expiresAt: Date;
    }
  /** In-memory test storage only: the app's own upload route receives the bytes. */
  | { readonly kind: "app"; readonly expiresAt: Date };

/** The in-memory test store cannot receive a browser PUT: the app's route stands in. */
function transport(signed: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}): UploadTransport {
  return signed.url.startsWith("memory://")
    ? { kind: "app", expiresAt: signed.expiresAt }
    : {
        kind: "direct",
        url: signed.url,
        method: "PUT",
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      };
}

/**
 * Checks shared by both kinds of upload: the declared type, the size limit, one open
 * upload per project, at most `maxActiveUploads` open in the workspace.
 */
async function checkNewUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  projectId: string,
  input: { readonly contentType: string; readonly size: number },
  maxBytes: number,
) {
  const project = await projectOf(deps.db, ctx, projectId);
  if (!isSourceContentType(input.contentType)) {
    throw creatorError("UNSUPPORTED_MEDIA_TYPE", "creator_type_unsupported");
  }
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > maxBytes) {
    throw creatorError("PAYLOAD_TOO_LARGE", "creator_upload_too_large", {
      maximum: Math.floor(maxBytes / (1024 * 1024)),
    });
  }
  const now = await dbNow(deps.db);
  const open = { status: "PENDING_UPLOAD" as const, uploadExpiresAt: { gt: now } };
  if (
    (await deps.db.creatorSource.count({
      where: { workspaceId: ctx.workspaceId, projectId, ...open },
    })) > 0
  ) {
    throw creatorError("CONFLICT", "creator_upload_in_progress");
  }
  if (
    (await deps.db.creatorSource.count({ where: { workspaceId: ctx.workspaceId, ...open } })) >=
    deps.limits.maxActiveUploads
  ) {
    throw creatorError("RATE_LIMITED", "creator_upload_limit", {
      maximum: deps.limits.maxActiveUploads,
    });
  }
  return { project, contentType: input.contentType as AllowedContentType, now };
}

/**
 * Starts a single-PUT upload (files up to CREATOR_SINGLE_UPLOAD_MAX_BYTES): checks the
 * declared type and size, reserves a server-generated private key in the project's
 * workspace and returns a short-lived signed PUT for exactly that type and size. The
 * browser also declares the file's SHA-256; nothing is trusted yet — the analysis job
 * checks the bytes, their hash and their format.
 */
export async function startUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  projectId: string,
  input: {
    readonly fileName: string;
    readonly contentType: string;
    readonly size: number;
    readonly sha256?: string | null;
  },
): Promise<{ sourceId: string; upload: UploadTransport }> {
  assertCan(ctx, "content.create");
  const maxBytes = Math.min(
    deps.limits.maxUploadBytes,
    CREATOR_SINGLE_UPLOAD_MAX_BYTES,
    STORAGE_CATEGORIES["creator-sources"].maxBytes,
  );
  const sha256 = input.sha256 ?? null;
  if (sha256 !== null && !SHA256_HEX.test(sha256)) {
    throw creatorError("VALIDATION_FAILED", "creator_checksum_invalid");
  }
  const { project, contentType } = await checkNewUpload(deps, ctx, projectId, input, maxBytes);
  assertUploadAllowed("creator-sources", contentType, input.size);
  const target = await deps.storage.writeTarget();
  const key = buildWorkspaceKey(ctx.workspaceId, "creator-sources", contentType);
  const signed = await target.storage.getSignedUploadUrl(key, {
    contentType,
    contentLength: input.size,
    category: "creator-sources",
    expiresInSeconds: UPLOAD_TTL_SECONDS,
  });
  const sourceId = await deps.db.$transaction(async (tx) => {
    await target.confirm(tx);
    const source = await tx.creatorSource.create({
      data: {
        workspaceId: ctx.workspaceId,
        projectId: project.id,
        storageProvider: target.provider,
        storageKey: key,
        originalName: printable(input.fileName).slice(0, 200) || "upload",
        declaredContentType: contentType,
        declaredBytes: input.size,
        declaredSha256: sha256,
        uploadExpiresAt: signed.expiresAt,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await tx.creatorProject.updateMany({
      where: { id: project.id, workspaceId: ctx.workspaceId },
      data: { status: "UPLOADING", version: { increment: 1 } },
    });
    await recordEvent(tx, ctx.workspaceId, project.id, "upload_started", ctx.userId, {
      bytes: input.size,
      mode: "single",
    });
    return source.id;
  });
  return { sourceId, upload: transport(signed) };
}

/**
 * Starts a resumable upload in parts (S3 multipart) for large files, up to the
 * deployment's CREATOR_MAX_UPLOAD_MB. The session belongs to this project, workspace and
 * user, stays open for CREATOR_UPLOAD_SESSION_HOURS and is aborted (parts removed) when
 * it expires.
 */
export async function startMultipartUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  projectId: string,
  input: { readonly fileName: string; readonly contentType: string; readonly size: number },
): Promise<{ sourceId: string; partSize: number; partCount: number; expiresAt: Date }> {
  assertCan(ctx, "content.create");
  const maxBytes = Math.min(deps.limits.maxUploadBytes, CREATOR_SOURCE_MAX_BYTES);
  const { project, contentType, now } = await checkNewUpload(deps, ctx, projectId, input, maxBytes);
  const target = await deps.storage.writeTarget();
  const multipart = target.storage.multipart;
  if (multipart === undefined) {
    throw creatorError("SERVICE_UNAVAILABLE", "creator_multipart_unsupported");
  }
  const key = buildWorkspaceKey(ctx.workspaceId, "creator-sources", contentType);
  const partSize = deps.timing?.partSizeBytes ?? partSizeFor(input.size);
  const partCount = Math.ceil(input.size / partSize);
  const uploadId = await multipart.create(key, { contentType });
  const expiresAt = new Date(now.getTime() + deps.limits.uploadSessionMs);
  try {
    const sourceId = await deps.db.$transaction(async (tx) => {
      await target.confirm(tx);
      const source = await tx.creatorSource.create({
        data: {
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          storageProvider: target.provider,
          storageKey: key,
          originalName: printable(input.fileName).slice(0, 200) || "upload",
          declaredContentType: contentType,
          declaredBytes: input.size,
          uploadMode: "multipart",
          multipartUploadId: uploadId,
          partSizeBytes: partSize,
          partCount,
          uploadExpiresAt: expiresAt,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await tx.creatorProject.updateMany({
        where: { id: project.id, workspaceId: ctx.workspaceId },
        data: { status: "UPLOADING", version: { increment: 1 } },
      });
      await recordEvent(tx, ctx.workspaceId, project.id, "upload_started", ctx.userId, {
        bytes: input.size,
        mode: "multipart",
        parts: partCount,
      });
      return source.id;
    });
    return { sourceId, partSize, partCount, expiresAt };
  } catch (error) {
    // Not recorded: the empty multipart upload is not left behind.
    await multipart.abort(key, uploadId, { signal: AbortSignal.timeout(15_000) }).catch(() => {
      deps.logger?.warn({ projectId }, "Could not abort an unrecorded multipart upload");
    });
    throw error;
  }
}

async function pendingSource(db: Db, ctx: TenantContext, sourceId: string) {
  if (!isUuid(sourceId)) throw notFound("creator_source");
  const source = await db.creatorSource.findFirst({
    where: { id: sourceId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      projectId: true,
      status: true,
      storageProvider: true,
      storageKey: true,
      declaredContentType: true,
      declaredBytes: true,
      uploadExpiresAt: true,
      uploadMode: true,
      multipartUploadId: true,
      partSizeBytes: true,
      partCount: true,
    },
  });
  if (source === null) throw notFound("creator_source");
  if (source.status !== "PENDING_UPLOAD") {
    throw creatorError("CONFLICT", "creator_upload_not_pending");
  }
  if (source.uploadExpiresAt <= (await dbNow(db))) {
    throw creatorError("CONFLICT", "creator_upload_expired");
  }
  return source;
}

type PendingSource = Awaited<ReturnType<typeof pendingSource>>;

function multipartOf(source: PendingSource) {
  if (
    source.uploadMode !== "multipart" ||
    source.multipartUploadId === null ||
    source.partSizeBytes === null ||
    source.partCount === null
  ) {
    throw creatorError("CONFLICT", "creator_upload_not_pending");
  }
  return {
    uploadId: source.multipartUploadId,
    partSize: source.partSizeBytes,
    partCount: source.partCount,
  };
}

/** The exact size of part `partNumber` (every part is `partSize`, the last one the rest). */
function expectedPartSize(source: PendingSource, partNumber: number): number {
  const { partSize, partCount } = multipartOf(source);
  return partNumber < partCount ? partSize : source.declaredBytes - partSize * (partCount - 1);
}

async function storageOf(deps: CreatorDeps, source: PendingSource): Promise<StorageService> {
  return deps.storage.forProvider(source.storageProvider);
}

/**
 * A short-lived signed PUT for one part, bound to that part's exact size. The browser
 * declares the part's SHA-256 first; the worker checks every part against it.
 */
export async function signUploadPart(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
  input: { readonly partNumber: number; readonly size: number; readonly sha256: string },
): Promise<{ upload: UploadTransport }> {
  assertCan(ctx, "content.create");
  const source = await pendingSource(deps.db, ctx, sourceId);
  await projectOf(deps.db, ctx, source.projectId);
  const { uploadId, partCount } = multipartOf(source);
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > partCount) {
    throw creatorError("VALIDATION_FAILED", "creator_part_invalid");
  }
  if (input.size !== expectedPartSize(source, input.partNumber)) {
    throw creatorError("VALIDATION_FAILED", "creator_part_invalid");
  }
  if (!SHA256_HEX.test(input.sha256)) {
    throw creatorError("VALIDATION_FAILED", "creator_checksum_invalid");
  }
  const storage = await storageOf(deps, source);
  if (storage.multipart === undefined) {
    throw creatorError("SERVICE_UNAVAILABLE", "creator_multipart_unsupported");
  }
  // Declared (or re-declared, when the browser sends the part again) before it is signed.
  const declared = await deps.db.creatorSourcePart.updateMany({
    where: { workspaceId: ctx.workspaceId, sourceId: source.id, partNumber: input.partNumber },
    data: { sha256: input.sha256, sizeBytes: input.size, etag: null, uploadedAt: null },
  });
  if (declared.count === 0) {
    await deps.db.creatorSourcePart.create({
      data: {
        workspaceId: ctx.workspaceId,
        sourceId: source.id,
        partNumber: input.partNumber,
        sizeBytes: input.size,
        sha256: input.sha256,
      },
    });
  }
  const signed = await storage.multipart.signPart(source.storageKey, uploadId, input.partNumber, {
    contentLength: input.size,
    expiresInSeconds: PART_URL_TTL_SECONDS,
  });
  return { upload: transport(signed) };
}

/**
 * Where a resumable upload stands, read from storage itself: the parts that arrived
 * with their declared size (a browser resumes with the others).
 */
export async function uploadStatus(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
): Promise<{
  readonly partSize: number;
  readonly partCount: number;
  readonly size: number;
  readonly expiresAt: Date;
  readonly uploadedParts: readonly number[];
}> {
  assertCan(ctx, "content.create");
  const source = await pendingSource(deps.db, ctx, sourceId);
  const { uploadId, partSize, partCount } = multipartOf(source);
  const storage = await storageOf(deps, source);
  const stored = (await storage.multipart?.listParts(source.storageKey, uploadId)) ?? null;
  if (stored === null) throw creatorError("CONFLICT", "creator_upload_expired");
  const declared = await deps.db.creatorSourcePart.findMany({
    where: { workspaceId: ctx.workspaceId, sourceId: source.id },
    select: { partNumber: true, sizeBytes: true },
  });
  const declaredSizes = new Map(declared.map((part) => [part.partNumber, part.sizeBytes]));
  const uploadedParts = stored
    .filter(
      (part) =>
        declaredSizes.get(part.partNumber) === part.size &&
        part.size === expectedPartSize(source, part.partNumber),
    )
    .map((part) => part.partNumber);
  return {
    partSize,
    partCount,
    size: source.declaredBytes,
    expiresAt: source.uploadExpiresAt,
    uploadedParts,
  };
}

/**
 * The in-app upload transport (STORAGE_DRIVER=test-memory only — the route refuses it
 * otherwise): the body must be exactly the announced size.
 */
export async function receiveAppUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
  body: Uint8Array,
): Promise<void> {
  assertCan(ctx, "content.create");
  const source = await pendingSource(deps.db, ctx, sourceId);
  if (source.uploadMode !== "single") throw creatorError("CONFLICT", "creator_upload_not_pending");
  if (body.byteLength !== source.declaredBytes) {
    throw creatorError("VALIDATION_FAILED", "creator_upload_size_mismatch");
  }
  const storage = await storageOf(deps, source);
  await storage.put(source.storageKey, body, {
    contentType: source.declaredContentType as AllowedContentType,
  });
}

/**
 * The in-app transport of one part (test-memory only, like receiveAppUpload): the
 * body must have the part's exact size. `put` hands it to the in-memory store.
 */
export async function receiveAppPart(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
  partNumber: number,
  body: Uint8Array,
  put: (storage: StorageService, uploadId: string, expected: number) => void,
): Promise<void> {
  assertCan(ctx, "content.create");
  const source = await pendingSource(deps.db, ctx, sourceId);
  const { uploadId, partCount } = multipartOf(source);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    throw creatorError("VALIDATION_FAILED", "creator_part_invalid");
  }
  const expected = expectedPartSize(source, partNumber);
  if (body.byteLength !== expected) {
    throw creatorError("VALIDATION_FAILED", "creator_upload_size_mismatch");
  }
  put(await storageOf(deps, source), uploadId, expected);
}

/**
 * The browser finished uploading. For a multipart upload, storage must hold every part
 * with its declared size; the object is then assembled. Either way the analysis is
 * queued (it verifies the bytes and their hashes, and runs ffprobe).
 */
export async function completeUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
): Promise<{ jobId: string }> {
  assertCan(ctx, "content.create");
  const source = await pendingSource(deps.db, ctx, sourceId);
  await projectOf(deps.db, ctx, source.projectId);
  if (source.uploadMode === "multipart") {
    const { uploadId, partCount } = multipartOf(source);
    const storage = await storageOf(deps, source);
    const multipart = storage.multipart;
    if (multipart === undefined) {
      throw creatorError("SERVICE_UNAVAILABLE", "creator_multipart_unsupported");
    }
    const stored = await multipart.listParts(source.storageKey, uploadId);
    if (stored === null) throw creatorError("CONFLICT", "creator_upload_expired");
    const declared = await deps.db.creatorSourcePart.findMany({
      where: { workspaceId: ctx.workspaceId, sourceId: source.id },
      select: { partNumber: true, sizeBytes: true },
    });
    const byNumber = new Map(stored.map((part) => [part.partNumber, part]));
    const declaredSizes = new Map(declared.map((part) => [part.partNumber, part.sizeBytes]));
    const parts: { partNumber: number; etag: string }[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const part = byNumber.get(partNumber);
      const expected = expectedPartSize(source, partNumber);
      if (part?.size !== expected || declaredSizes.get(partNumber) !== expected) {
        throw creatorError("CONFLICT", "creator_upload_incomplete", { part: partNumber });
      }
      parts.push({ partNumber, etag: part.etag });
    }
    await multipart.complete(source.storageKey, uploadId, parts);
    await deps.db.$transaction(async (tx) => {
      const now = await dbNow(tx);
      for (const part of parts) {
        await tx.creatorSourcePart.updateMany({
          where: { workspaceId: ctx.workspaceId, sourceId: source.id, partNumber: part.partNumber },
          data: { etag: part.etag.slice(0, 200), uploadedAt: now },
        });
      }
      await tx.creatorSource.updateMany({
        where: { id: source.id, workspaceId: ctx.workspaceId },
        data: { multipartUploadId: null },
      });
    });
  }
  return deps.db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const moved = await tx.creatorSource.updateMany({
      where: { id: source.id, workspaceId: ctx.workspaceId, status: "PENDING_UPLOAD" },
      data: { status: "UPLOADED", uploadedAt: now },
    });
    if (moved.count !== 1) throw creatorError("CONFLICT", "creator_upload_not_pending");
    const job = await enqueueJob(tx, {
      workspaceId: ctx.workspaceId,
      projectId: source.projectId,
      sourceId: source.id,
      kind: "ANALYZE",
      idempotencyKey: `analyze:${source.id}`,
      requestedByUserId: ctx.userId,
      now,
    });
    await tx.creatorProject.updateMany({
      where: { id: source.projectId, workspaceId: ctx.workspaceId },
      data: { status: "PROCESSING", version: { increment: 1 } },
    });
    await recordEvent(tx, ctx.workspaceId, source.projectId, "upload_completed", ctx.userId);
    return { jobId: job.id };
  });
}

/** The person gives up an upload: it is closed and whatever arrived is removed. */
export async function abortUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
): Promise<void> {
  assertCan(ctx, "content.create");
  const source = await pendingSource(deps.db, ctx, sourceId);
  await deps.db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const moved = await tx.creatorSource.updateMany({
      where: { id: source.id, workspaceId: ctx.workspaceId, status: "PENDING_UPLOAD" },
      data: { status: "EXPIRED", multipartUploadId: null },
    });
    if (moved.count !== 1) throw creatorError("CONFLICT", "creator_upload_not_pending");
    await queueStorageDeletions(
      tx,
      [
        {
          workspaceId: ctx.workspaceId,
          projectId: source.projectId,
          reason: "upload_expired",
          storageProvider: source.storageProvider,
          storageKey: source.storageKey,
          multipartUploadId: source.multipartUploadId,
        },
      ],
      now,
    );
    await tx.creatorProject.updateMany({
      where: { id: source.projectId, workspaceId: ctx.workspaceId, status: "UPLOADING" },
      data: { status: "DRAFT", version: { increment: 1 } },
    });
    await recordEvent(tx, ctx.workspaceId, source.projectId, "upload_cancelled", ctx.userId);
  });
}

/**
 * Uploads started and never completed: expired (the signed URLs are dead by then) and
 * queued for deletion — an open multipart upload is aborted, so its parts stop costing
 * storage. Worker loop; `system` finds them across workspaces, every write uses the
 * row's own workspace.
 */
export async function cleanupExpiredUploads(
  deps: CreatorDeps,
  system: PrismaClient,
  limit = 50,
): Promise<number> {
  const now = await dbNow(deps.db);
  const expired = await system.creatorSource.findMany({
    where: {
      status: "PENDING_UPLOAD",
      uploadExpiresAt: { lt: new Date(now.getTime() - UPLOAD_CLEANUP_GRACE_MS) },
    },
    take: limit,
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      storageProvider: true,
      storageKey: true,
      multipartUploadId: true,
    },
  });
  let cleaned = 0;
  for (const source of expired) {
    const moved = await deps.db.$transaction(async (tx) => {
      const result = await tx.creatorSource.updateMany({
        where: { id: source.id, workspaceId: source.workspaceId, status: "PENDING_UPLOAD" },
        data: { status: "EXPIRED", multipartUploadId: null },
      });
      if (result.count !== 1) return false;
      await queueStorageDeletions(
        tx,
        [
          {
            workspaceId: source.workspaceId,
            projectId: source.projectId,
            reason: "upload_expired",
            storageProvider: source.storageProvider,
            storageKey: source.storageKey,
            multipartUploadId: source.multipartUploadId,
          },
        ],
        now,
      );
      await tx.creatorProject.updateMany({
        where: { id: source.projectId, workspaceId: source.workspaceId, status: "UPLOADING" },
        data: { status: "DRAFT", version: { increment: 1 } },
      });
      await recordEvent(tx, source.workspaceId, source.projectId, "upload_expired", null);
      return true;
    });
    if (moved) cleaned += 1;
  }
  return cleaned;
}

// ── Starting work ─────────────────────────────────────────────────────────────

async function readySource(db: Db, ctx: TenantContext, projectId: string) {
  const source = await db.creatorSource.findFirst({
    where: { workspaceId: ctx.workspaceId, projectId, status: "VERIFIED" },
    orderBy: { verifiedAt: "desc" },
    select: { id: true, durationMs: true, hasAudio: true, hasVideo: true },
  });
  if (source === null) throw creatorError("CONFLICT", "creator_source_not_ready");
  return source;
}

async function activeJob(db: Db, ctx: TenantContext, where: Record<string, unknown>) {
  return db.creatorJob.findFirst({
    where: { workspaceId: ctx.workspaceId, state: { in: ["QUEUED", "RUNNING"] }, ...where },
    select: { id: true },
  });
}

/** Queues transcription + clip suggestions (the cost was shown before confirming). */
export async function requestTranscription(
  deps: CreatorDeps,
  ctx: TenantContext,
  projectId: string,
  input: {
    readonly language: string | null;
    readonly requestKey: string;
    /** The person confirmed that the audio is sent to the external provider shown. */
    readonly externalProcessing?: boolean;
  },
): Promise<{ jobId: string }> {
  assertCan(ctx, "content.create");
  await projectOf(deps.db, ctx, projectId);
  const provider = deps.transcription;
  if (provider === null) throw creatorError("SERVICE_UNAVAILABLE", "creator_provider_disabled");
  if (provider.external && input.externalProcessing !== true) {
    throw creatorError("VALIDATION_FAILED", "creator_external_consent_required");
  }
  if (
    input.language !== null &&
    (!LANGUAGE_PATTERN.test(input.language) || !provider.supportsLanguage(input.language))
  ) {
    throw creatorError("VALIDATION_FAILED", "creator_language_unsupported");
  }
  // The same request again (a double click, a retried submit) is the same job.
  const repeated = await deps.db.creatorJob.findFirst({
    where: { workspaceId: ctx.workspaceId, idempotencyKey: `transcribe:${input.requestKey}` },
    select: { id: true },
  });
  if (repeated !== null) return { jobId: repeated.id };
  const source = await readySource(deps.db, ctx, projectId);
  if (source.hasAudio !== true) throw creatorError("CONFLICT", "creator_no_audio");
  const done = await deps.db.creatorTranscript.findFirst({
    where: { workspaceId: ctx.workspaceId, sourceId: source.id, kind: "ORIGINAL" },
    select: { id: true },
  });
  if (done !== null) throw creatorError("CONFLICT", "creator_already_transcribed");
  if ((await activeJob(deps.db, ctx, { sourceId: source.id, kind: "TRANSCRIBE" })) !== null) {
    throw creatorError("CONFLICT", "creator_job_active");
  }
  return deps.db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const job = await enqueueJob(tx, {
      workspaceId: ctx.workspaceId,
      projectId,
      sourceId: source.id,
      kind: "TRANSCRIBE",
      options: {
        ...(input.language === null ? {} : { language: input.language }),
        ...(provider.external ? { externalProcessing: "confirmed" } : {}),
      },
      idempotencyKey: `transcribe:${input.requestKey}`,
      requestedByUserId: ctx.userId,
      now,
    });
    if (job.created) {
      await tx.creatorProject.updateMany({
        where: { id: projectId, workspaceId: ctx.workspaceId },
        data: { status: "PROCESSING", version: { increment: 1 } },
      });
      await recordAudit(tx, ctx, {
        action: "creator.processing_requested",
        entityType: "creator_project",
        entityId: projectId,
        metadata: {
          kind: "TRANSCRIBE",
          simulated: provider.simulated,
          provider: provider.id,
          external: provider.external,
        },
      });
    }
    return { jobId: job.id };
  });
}

export async function requestTranslation(
  deps: CreatorDeps,
  ctx: TenantContext,
  transcriptId: string,
  input: {
    readonly targetLanguage: string;
    readonly requestKey: string;
    readonly externalProcessing?: boolean;
  },
): Promise<{ jobId: string }> {
  assertCan(ctx, "content.create");
  if (!isUuid(transcriptId)) throw notFound("creator_transcript");
  const provider = deps.translation;
  if (provider === null) throw creatorError("SERVICE_UNAVAILABLE", "creator_provider_disabled");
  if (provider.external && input.externalProcessing !== true) {
    throw creatorError("VALIDATION_FAILED", "creator_external_consent_required");
  }
  const transcript = await deps.db.creatorTranscript.findFirst({
    where: { id: transcriptId, workspaceId: ctx.workspaceId, kind: "ORIGINAL" },
    select: { id: true, projectId: true, sourceId: true, language: true },
  });
  if (transcript === null) throw notFound("creator_transcript");
  const target = input.targetLanguage;
  if (
    !LANGUAGE_PATTERN.test(target) ||
    !provider.supportsLanguage(target) ||
    target === transcript.language
  ) {
    throw creatorError("VALIDATION_FAILED", "creator_language_unsupported");
  }
  const existing = await deps.db.creatorTranscript.findFirst({
    where: { workspaceId: ctx.workspaceId, translatedFromId: transcript.id, language: target },
    select: { id: true },
  });
  if (existing !== null) throw creatorError("CONFLICT", "creator_translation_exists");
  if (
    (await activeJob(deps.db, ctx, {
      sourceId: transcript.sourceId,
      kind: "TRANSLATE",
      options: { path: ["targetLanguage"], equals: target },
    })) !== null
  ) {
    throw creatorError("CONFLICT", "creator_job_active");
  }
  return deps.db.$transaction(async (tx) => {
    const job = await enqueueJob(tx, {
      workspaceId: ctx.workspaceId,
      projectId: transcript.projectId,
      sourceId: transcript.sourceId,
      kind: "TRANSLATE",
      options: {
        transcriptId: transcript.id,
        targetLanguage: target,
        ...(provider.external ? { externalProcessing: "confirmed" } : {}),
      },
      idempotencyKey: `translate:${input.requestKey}`,
      requestedByUserId: ctx.userId,
      now: await dbNow(tx),
    });
    return { jobId: job.id };
  });
}

// ── Editing ───────────────────────────────────────────────────────────────────

/** Edits one subtitle line's text and timing (stays inside the media). */
export async function updateSegment(
  deps: CreatorDeps,
  ctx: TenantContext,
  segmentId: string,
  input: { readonly text: string; readonly startMs: number; readonly endMs: number },
): Promise<void> {
  assertCan(ctx, "content.edit");
  if (!isUuid(segmentId)) throw notFound("creator_segment");
  const segment = await deps.db.creatorTranscriptSegment.findFirst({
    where: { id: segmentId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      transcriptId: true,
      transcript: { select: { projectId: true, source: { select: { durationMs: true } } } },
    },
  });
  if (segment === null) throw notFound("creator_segment");
  const duration = segment.transcript.source.durationMs ?? 0;
  if (
    !Number.isInteger(input.startMs) ||
    !Number.isInteger(input.endMs) ||
    input.startMs < 0 ||
    input.endMs <= input.startMs ||
    input.endMs > duration
  ) {
    throw creatorError("VALIDATION_FAILED", "creator_segment_out_of_bounds");
  }
  await deps.db.$transaction(async (tx) => {
    await tx.creatorTranscriptSegment.updateMany({
      where: { id: segment.id, workspaceId: ctx.workspaceId },
      data: { text: input.text, startMs: input.startMs, endMs: input.endMs, edited: true },
    });
    await tx.creatorTranscript.updateMany({
      where: { id: segment.transcriptId, workspaceId: ctx.workspaceId },
      data: { editedAt: await dbNow(tx) },
    });
  });
}

async function clipOf(db: Db, ctx: TenantContext, clipId: string) {
  if (!isUuid(clipId)) throw notFound("creator_clip");
  const clip = await db.creatorClip.findFirst({
    where: { id: clipId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      projectId: true,
      sourceId: true,
      status: true,
      version: true,
      startMs: true,
      endMs: true,
      cropX: true,
      source: { select: { durationMs: true, hasVideo: true } },
    },
  });
  if (clip === null) throw notFound("creator_clip");
  return clip;
}

function assertClipBounds(startMs: number, endMs: number, durationMs: number | null) {
  if (
    !Number.isInteger(startMs) ||
    !Number.isInteger(endMs) ||
    startMs < 0 ||
    endMs - startMs < MIN_CLIP_MS ||
    endMs - startMs > MAX_CLIP_MS ||
    durationMs === null ||
    endMs > durationMs
  ) {
    throw creatorError("VALIDATION_FAILED", "creator_clip_out_of_bounds");
  }
}

/**
 * Changes a clip's title, bounds or crop. A clip that was approved goes back to
 * "suggested": what is exported is always what a person approved last.
 */
export async function updateClip(
  deps: CreatorDeps,
  ctx: TenantContext,
  clipId: string,
  input: {
    readonly title: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly cropX: number;
    readonly version: number;
  },
): Promise<void> {
  assertCan(ctx, "content.edit");
  const clip = await clipOf(deps.db, ctx, clipId);
  assertClipBounds(input.startMs, input.endMs, clip.source.durationMs);
  if (!Number.isInteger(input.cropX) || input.cropX < 0 || input.cropX > 100) {
    throw new AppError("VALIDATION_FAILED", { fields: [{ path: "cropX", code: "too_big" }] });
  }
  const changed =
    input.startMs !== clip.startMs || input.endMs !== clip.endMs || input.cropX !== clip.cropX;
  const updated = await deps.db.creatorClip.updateMany({
    where: { id: clip.id, workspaceId: ctx.workspaceId, version: input.version },
    data: {
      title: input.title,
      startMs: input.startMs,
      endMs: input.endMs,
      cropX: input.cropX,
      version: { increment: 1 },
      ...(changed && clip.status === "APPROVED"
        ? { status: "SUGGESTED", reviewedAt: null, reviewedByUserId: null }
        : {}),
    },
  });
  if (updated.count !== 1) throw creatorError("CONFLICT", "creator_stale");
}

/** A clip a person marks by hand (from the transcript or the player). */
export async function createClip(
  deps: CreatorDeps,
  ctx: TenantContext,
  projectId: string,
  input: { readonly title: string; readonly startMs: number; readonly endMs: number },
): Promise<{ id: string }> {
  assertCan(ctx, "content.edit");
  await projectOf(deps.db, ctx, projectId);
  const source = await readySource(deps.db, ctx, projectId);
  assertClipBounds(input.startMs, input.endMs, source.durationMs);
  return deps.db.creatorClip.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId,
      sourceId: source.id,
      title: input.title,
      startMs: input.startMs,
      endMs: input.endMs,
      text: "",
      origin: "MANUAL",
    },
    select: { id: true },
  });
}

/** Approves or rejects a clip. Only an approved clip can be exported. */
export async function reviewClip(
  deps: CreatorDeps,
  ctx: TenantContext,
  clipId: string,
  input: { readonly decision: "APPROVED" | "REJECTED"; readonly version: number },
): Promise<void> {
  assertCan(ctx, "content.approve");
  const clip = await clipOf(deps.db, ctx, clipId);
  await deps.db.$transaction(async (tx) => {
    const updated = await tx.creatorClip.updateMany({
      where: { id: clip.id, workspaceId: ctx.workspaceId, version: input.version },
      data: {
        status: input.decision,
        reviewedAt: await dbNow(tx),
        reviewedByUserId: ctx.userId,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw creatorError("CONFLICT", "creator_stale");
    await recordEvent(tx, ctx.workspaceId, clip.projectId, "clip_reviewed", ctx.userId, {
      clipId: clip.id,
      decision: input.decision,
    });
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

const ASPECTS: readonly CreatorAspectRatio[] = ["PORTRAIT_9_16", "LANDSCAPE_16_9", "SQUARE_1_1"];

/**
 * Queues the render of an approved clip. Its bounds and crop are copied: editing the
 * clip later never changes a file that was asked for.
 */
export async function requestExport(
  deps: CreatorDeps,
  ctx: TenantContext,
  clipId: string,
  input: {
    readonly aspectRatio: CreatorAspectRatio;
    readonly subtitleTranscriptId: string | null;
    readonly requestKey: string;
  },
): Promise<{ exportId: string; jobId: string }> {
  assertCan(ctx, "content.create");
  if (!ASPECTS.includes(input.aspectRatio)) {
    throw new AppError("VALIDATION_FAILED", {
      fields: [{ path: "aspectRatio", code: "invalid_value" }],
    });
  }
  const clip = await clipOf(deps.db, ctx, clipId);
  if (clip.status !== "APPROVED") throw creatorError("CONFLICT", "creator_clip_not_approved");
  if (clip.source.hasVideo !== true) throw creatorError("CONFLICT", "creator_no_video");
  if (input.subtitleTranscriptId !== null) {
    const transcript = isUuid(input.subtitleTranscriptId)
      ? await deps.db.creatorTranscript.findFirst({
          where: {
            id: input.subtitleTranscriptId,
            workspaceId: ctx.workspaceId,
            projectId: clip.projectId,
          },
          select: { id: true },
        })
      : null;
    if (transcript === null) throw notFound("creator_transcript");
  }
  return deps.db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const existing = await tx.creatorJob.findFirst({
      where: { workspaceId: ctx.workspaceId, idempotencyKey: `export:${input.requestKey}` },
      select: { id: true, exportId: true },
    });
    if (existing !== null && existing.exportId !== null)
      return { exportId: existing.exportId, jobId: existing.id };
    const created = await tx.creatorExport.create({
      data: {
        workspaceId: ctx.workspaceId,
        projectId: clip.projectId,
        clipId: clip.id,
        aspectRatio: input.aspectRatio,
        burnSubtitles: input.subtitleTranscriptId !== null,
        subtitleTranscriptId: input.subtitleTranscriptId,
        startMs: clip.startMs,
        endMs: clip.endMs,
        cropX: clip.cropX,
        requestedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    const job = await enqueueJob(tx, {
      workspaceId: ctx.workspaceId,
      projectId: clip.projectId,
      sourceId: clip.sourceId,
      exportId: created.id,
      kind: "EXPORT",
      idempotencyKey: `export:${input.requestKey}`,
      requestedByUserId: ctx.userId,
      now,
    });
    await recordAudit(tx, ctx, {
      action: "creator.export_requested",
      entityType: "creator_export",
      entityId: created.id,
      metadata: { aspectRatio: input.aspectRatio, subtitles: input.subtitleTranscriptId !== null },
    });
    return { exportId: created.id, jobId: job.id };
  });
}

/** The stored file of a READY export, for the access-checked download route. */
export async function exportFile(deps: CreatorDeps, ctx: TenantContext, exportId: string) {
  assertCan(ctx, "content.view");
  if (!isUuid(exportId)) throw notFound("creator_export");
  const row = await deps.db.creatorExport.findFirst({
    where: { id: exportId, workspaceId: ctx.workspaceId, status: "READY" },
    select: { id: true, storageProvider: true, storageKey: true, byteSize: true },
  });
  if (!row?.storageProvider || row.storageKey === null) throw notFound("creator_export");
  return { id: row.id, provider: row.storageProvider, key: row.storageKey, byteSize: row.byteSize };
}

/** A transcript as SubRip or WebVTT text (simulated ones say so in their file name). */
export async function subtitleFile(
  deps: CreatorDeps,
  ctx: TenantContext,
  transcriptId: string,
  format: "srt" | "vtt",
): Promise<{ readonly body: string; readonly fileName: string }> {
  assertCan(ctx, "content.view");
  if (!isUuid(transcriptId)) throw notFound("creator_transcript");
  const transcript = await deps.db.creatorTranscript.findFirst({
    where: { id: transcriptId, workspaceId: ctx.workspaceId },
    select: { language: true, simulated: true },
  });
  if (transcript === null) throw notFound("creator_transcript");
  const cues = await deps.db.creatorTranscriptSegment.findMany({
    where: { workspaceId: ctx.workspaceId, transcriptId },
    orderBy: { position: "asc" },
    select: { startMs: true, endMs: true, text: true },
  });
  const body =
    format === "srt"
      ? toSrt(cues)
      : transcript.simulated
        ? toVtt(cues).replace(
            "WEBVTT\n",
            "WEBVTT\n\nNOTE Simulated text: not a transcript of the media.\n",
          )
        : toVtt(cues);
  const suffix = transcript.simulated ? "-simulated" : "";
  return { body, fileName: `subtitles-${transcript.language}${suffix}.${format}` };
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

/**
 * Cancels a queued or running job. The job row changes at once, so the worker's next
 * fenced write fails and its lease renewal stops it (FFmpeg and provider calls are
 * aborted). Open holds of its steps are released here.
 */
export async function cancelJob(
  deps: CreatorDeps,
  ctx: TenantContext,
  jobId: string,
): Promise<void> {
  assertCan(ctx, "content.create");
  if (!isUuid(jobId)) throw notFound("creator_job");
  await deps.db.$transaction(async (tx) => {
    const job = await tx.creatorJob.findFirst({
      where: { id: jobId, workspaceId: ctx.workspaceId },
      select: { id: true, projectId: true, kind: true, exportId: true, state: true },
    });
    if (job === null) throw notFound("creator_job");
    const now = await dbNow(tx);
    const cancelled = await tx.creatorJob.updateMany({
      where: { id: job.id, workspaceId: ctx.workspaceId, state: { in: ["QUEUED", "RUNNING"] } },
      data: {
        state: "CANCELLED",
        failureCode: "cancelled",
        finishedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (cancelled.count !== 1) throw creatorError("CONFLICT", "creator_job_not_active");
    const steps = await tx.creatorJobStep.findMany({
      where: { workspaceId: ctx.workspaceId, jobId: job.id, holdId: { not: null } },
      select: { holdId: true },
    });
    for (const step of steps) {
      if (step.holdId !== null) {
        await releaseHold(tx, ctx.workspaceId, step.holdId, "creator_cancelled", now, deps.credits);
      }
    }
    await tx.creatorJobStep.updateMany({
      where: { workspaceId: ctx.workspaceId, jobId: job.id, state: "RUNNING" },
      data: { state: "FAILED", errorCode: "cancelled", finishedAt: now },
    });
    if (job.exportId !== null) {
      await tx.creatorExport.updateMany({
        where: {
          id: job.exportId,
          workspaceId: ctx.workspaceId,
          status: { in: ["QUEUED", "RENDERING"] },
        },
        data: { status: "CANCELLED" },
      });
    }
    await recordEvent(tx, ctx.workspaceId, job.projectId, "job_cancelled", ctx.userId, {
      kind: job.kind,
      jobId: job.id,
    });
    await recordAudit(tx, ctx, {
      action: "creator.job_cancelled",
      entityType: "creator_job",
      entityId: job.id,
      metadata: { kind: job.kind },
    });
  });
}

/**
 * Resumes a failed or cancelled job: the same job goes back to the queue with a fresh
 * attempt budget and deadline; its succeeded steps are kept and never run again (a
 * transcript already stored is not paid for twice). A file rejected by the analysis is
 * not retried — the person uploads another one.
 */
export async function retryJob(
  deps: CreatorDeps,
  ctx: TenantContext,
  jobId: string,
): Promise<{ jobId: string }> {
  assertCan(ctx, "content.create");
  if (!isUuid(jobId)) throw notFound("creator_job");
  const job = await deps.db.creatorJob.findFirst({
    where: { id: jobId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      projectId: true,
      sourceId: true,
      kind: true,
      state: true,
      options: true,
      exportId: true,
      source: { select: { status: true } },
      export: { select: { status: true } },
    },
  });
  if (job === null) throw notFound("creator_job");
  if (
    (job.state !== "FAILED" && job.state !== "CANCELLED") ||
    job.source.status === "REJECTED" ||
    job.source.status === "EXPIRED" ||
    job.export?.status === "READY"
  ) {
    throw creatorError("CONFLICT", "creator_job_not_retryable");
  }
  const target = (job.options as { targetLanguage?: unknown } | null)?.targetLanguage;
  const other = await deps.db.creatorJob.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      sourceId: job.sourceId,
      kind: job.kind,
      state: { in: ["QUEUED", "RUNNING"] },
      id: { not: job.id },
      ...(job.kind === "EXPORT" ? { exportId: job.exportId } : {}),
      ...(typeof target === "string"
        ? { options: { path: ["targetLanguage"], equals: target } }
        : {}),
    },
    select: { id: true },
  });
  if (other !== null) throw creatorError("CONFLICT", "creator_job_active");
  await deps.db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const resumed = await tx.creatorJob.updateMany({
      where: { id: job.id, workspaceId: ctx.workspaceId, state: { in: ["FAILED", "CANCELLED"] } },
      data: {
        state: "QUEUED",
        attempts: 0,
        failureCode: null,
        finishedAt: null,
        stage: null,
        runAfter: now,
        deadlineAt: new Date(now.getTime() + JOB_DEADLINE_MS),
      },
    });
    if (resumed.count !== 1) throw creatorError("CONFLICT", "creator_job_not_retryable");
    // Succeeded steps stay; the others run again (their attempt counters keep growing,
    // so each new attempt holds credits under a new key).
    await tx.creatorJobStep.updateMany({
      where: { workspaceId: ctx.workspaceId, jobId: job.id, state: { not: "SUCCEEDED" } },
      data: { state: "PENDING", errorCode: null },
    });
    if (job.exportId !== null) {
      await tx.creatorExport.updateMany({
        where: {
          id: job.exportId,
          workspaceId: ctx.workspaceId,
          status: { in: ["FAILED", "CANCELLED"] },
        },
        data: { status: "QUEUED", failureCode: null },
      });
    }
    if (job.kind === "ANALYZE" || job.kind === "TRANSCRIBE") {
      await tx.creatorProject.updateMany({
        where: { id: job.projectId, workspaceId: ctx.workspaceId },
        data: { status: "PROCESSING", version: { increment: 1 } },
      });
    }
    await recordEvent(tx, ctx.workspaceId, job.projectId, "job_resumed", ctx.userId, {
      kind: job.kind,
      jobId: job.id,
    });
  });
  return { jobId: job.id };
}

// ── Project lifecycle: deletion and data export ─────────────────────────────

/**
 * Deletes a project. In one transaction (the project row locked): its open holds are
 * released, every stored object (sources, exports, open multipart uploads) is queued for
 * deletion from private storage, and the content rows — jobs, sources, transcripts,
 * clips, exports — are removed; the project stays as DELETING (nothing new can start in
 * it, enforced by the database too) until the worker's storage sweep has confirmed every
 * object gone, then it is purged. A worker still running one of its jobs finds the job
 * gone on its next fenced write and stops; a file it was about to store is discarded.
 * Kept: the audit trail (who deleted what, when) and the credit ledger (what was charged).
 * Repeating the request is harmless.
 */
export async function deleteProject(
  deps: CreatorDeps,
  ctx: TenantContext,
  projectId: string,
  input: { readonly confirmName: string },
): Promise<{ readonly queuedObjects: number }> {
  assertCan(ctx, "content.edit");
  const project = await projectOf(deps.db, ctx, projectId, "any");
  if (project.status === "DELETING") return { queuedObjects: 0 };
  if (input.confirmName.trim() !== project.name.trim()) {
    throw new AppError("VALIDATION_FAILED", {
      fields: [{ path: "confirmName", code: "creator_delete_name_mismatch" }],
    });
  }
  return deps.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS "status" FROM "creator_projects"
      WHERE "id" = ${project.id}::uuid AND "workspace_id" = ${ctx.workspaceId}::uuid
      FOR UPDATE`;
    if (locked[0] === undefined) throw notFound("creator_project");
    if (locked[0].status === "DELETING") return { queuedObjects: 0 };
    const now = await dbNow(tx);
    const where = { workspaceId: ctx.workspaceId, projectId: project.id };
    // Credits held by unfinished work are released (nothing was delivered).
    const steps = await tx.creatorJobStep.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        job: { projectId: project.id },
        holdId: { not: null },
      },
      select: { holdId: true },
    });
    for (const step of steps) {
      if (step.holdId === null) continue;
      const hold = await tx.creditHold.findFirst({
        where: { workspaceId: ctx.workspaceId, id: step.holdId },
        select: { status: true },
      });
      if (hold?.status === "HELD") {
        await releaseHold(
          tx,
          ctx.workspaceId,
          step.holdId,
          "creator_project_deleted",
          now,
          deps.credits,
        );
      }
    }
    const [sources, exports] = await Promise.all([
      tx.creatorSource.findMany({
        where,
        select: { storageProvider: true, storageKey: true, multipartUploadId: true },
      }),
      tx.creatorExport.findMany({
        where: { ...where, storageKey: { not: null } },
        select: { storageProvider: true, storageKey: true },
      }),
    ]);
    const objects = [
      ...sources.map((source) => ({
        workspaceId: ctx.workspaceId,
        projectId: project.id,
        reason: "project_deleted" as const,
        storageProvider: source.storageProvider,
        storageKey: source.storageKey,
        multipartUploadId: source.multipartUploadId,
      })),
      ...exports.flatMap((row) =>
        row.storageKey === null || row.storageProvider === null
          ? []
          : [
              {
                workspaceId: ctx.workspaceId,
                projectId: project.id,
                reason: "project_deleted" as const,
                storageProvider: row.storageProvider,
                storageKey: row.storageKey,
              },
            ],
      ),
    ];
    await queueStorageDeletions(tx, objects, now);
    await tx.creatorProject.updateMany({
      where: { id: project.id, workspaceId: ctx.workspaceId },
      data: { status: "DELETING", deletedAt: now, version: { increment: 1 } },
    });
    // Content goes now; jobs first (a running worker's next fenced write fails).
    await tx.creatorJob.deleteMany({ where });
    await tx.creatorExport.deleteMany({ where });
    await tx.creatorClip.deleteMany({ where });
    await tx.creatorTranscript.deleteMany({ where: { ...where, translatedFromId: { not: null } } });
    await tx.creatorTranscript.deleteMany({ where });
    await tx.creatorSource.deleteMany({ where });
    await recordEvent(tx, ctx.workspaceId, project.id, "project_deletion_requested", ctx.userId, {
      objects: objects.length,
    });
    await recordAudit(tx, ctx, {
      action: "creator.project_deletion_requested",
      entityType: "creator_project",
      entityId: project.id,
      metadata: { objects: objects.length },
    });
    return { queuedObjects: objects.length };
  });
}

/**
 * Everything the workspace stored for a project, as one JSON document the person can
 * keep: the project, its source's properties (not the media itself, which stays
 * downloadable only as exports), transcripts and translations with every cue, clips
 * with their review status, exports, the processing history (codes and counts, with the
 * credits each step was charged) and the event log. No other workspace's data, no
 * storage keys, no provider secrets.
 */
export async function exportProjectData(deps: CreatorDeps, ctx: TenantContext, projectId: string) {
  assertCan(ctx, "content.edit");
  const project = await projectOf(deps.db, ctx, projectId);
  const where = { workspaceId: ctx.workspaceId, projectId: project.id };
  const [details, sources, transcripts, clips, exports, jobs, events] = await Promise.all([
    deps.db.creatorProject.findFirst({
      where: { id: project.id, workspaceId: ctx.workspaceId },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    deps.db.creatorSource.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        originalName: true,
        declaredContentType: true,
        byteSize: true,
        sha256: true,
        container: true,
        durationMs: true,
        width: true,
        height: true,
        hasAudio: true,
        hasVideo: true,
        rejectionCode: true,
        createdAt: true,
        verifiedAt: true,
      },
    }),
    deps.db.creatorTranscript.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        kind: true,
        language: true,
        translatedFromId: true,
        provider: true,
        model: true,
        simulated: true,
        createdAt: true,
        editedAt: true,
        segments: {
          orderBy: { position: "asc" },
          select: { startMs: true, endMs: true, text: true, edited: true },
        },
      },
    }),
    deps.db.creatorClip.findMany({
      where,
      orderBy: { startMs: "asc" },
      select: {
        id: true,
        title: true,
        startMs: true,
        endMs: true,
        text: true,
        reasons: true,
        score: true,
        status: true,
        origin: true,
        simulated: true,
        cropX: true,
        reviewedAt: true,
      },
    }),
    deps.db.creatorExport.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        clipId: true,
        status: true,
        aspectRatio: true,
        burnSubtitles: true,
        startMs: true,
        endMs: true,
        byteSize: true,
        sha256: true,
        durationMs: true,
        width: true,
        height: true,
        failureCode: true,
        createdAt: true,
        readyAt: true,
      },
    }),
    deps.db.creatorJob.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        kind: true,
        state: true,
        attempts: true,
        failureCode: true,
        createdAt: true,
        finishedAt: true,
        steps: {
          orderBy: { position: "asc" },
          select: {
            stage: true,
            state: true,
            provider: true,
            model: true,
            simulated: true,
            holdId: true,
            localProcessingMs: true,
            providerAudioSeconds: true,
          },
        },
      },
    }),
    deps.db.creatorProjectEvent.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 5000,
      select: { type: true, metadata: true, createdAt: true },
    }),
  ]);
  if (details === null) throw notFound("creator_project");
  const holdIds = jobs.flatMap((job) =>
    job.steps.flatMap((step) => (step.holdId === null ? [] : [step.holdId])),
  );
  const holds =
    holdIds.length === 0
      ? []
      : await deps.db.creditHold.findMany({
          where: { workspaceId: ctx.workspaceId, id: { in: holdIds } },
          select: { id: true, status: true, capturedAmount: true },
        });
  const charged = new Map(
    holds.map((hold) => [hold.id, hold.status === "CAPTURED" ? (hold.capturedAmount ?? 0) : 0]),
  );
  await recordAudit(deps.db, ctx, {
    action: "creator.project_data_exported",
    entityType: "creator_project",
    entityId: project.id,
  });
  return {
    format: "flexibx.creator-project.v1",
    exportedAt: new Date().toISOString(),
    project: details,
    sources,
    transcripts,
    clips,
    exports,
    jobs: jobs.map((job) => ({
      ...job,
      steps: job.steps.map(({ holdId, ...step }) => ({
        ...step,
        creditsCharged: holdId === null ? 0 : (charged.get(holdId) ?? 0),
      })),
    })),
    events,
  };
}
