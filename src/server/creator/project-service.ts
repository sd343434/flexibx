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
  STORAGE_CATEGORIES,
  type AllowedContentType,
} from "../storage/storage";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import {
  billedMinutes,
  JOB_DEADLINE_MS,
  MAX_CLIP_MS,
  MIN_CLIP_MS,
  UPLOAD_CLEANUP_GRACE_MS,
  UPLOAD_TTL_SECONDS,
  type CreatorDeps,
} from "./config";
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

async function projectOf(db: Db, ctx: TenantContext, projectId: string) {
  if (!isUuid(projectId)) throw notFound("creator_project");
  const project = await db.creatorProject.findFirst({
    where: { id: projectId, workspaceId: ctx.workspaceId },
    select: { id: true, status: true, version: true },
  });
  if (project === null) throw notFound("creator_project");
  return project;
}

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
  await projectOf(db, ctx, projectId);
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
    provider:
      deps.transcription === null
        ? null
        : { id: deps.transcription.id, simulated: deps.transcription.simulated },
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
      maxUploadBytes: deps.limits.maxUploadBytes,
      maxDurationMs: deps.limits.maxDurationMs,
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

/**
 * Starts an upload: checks the declared type and size against the configured limits,
 * reserves a server-generated private key in the project's workspace and returns a
 * short-lived signed PUT for exactly that type and size. Nothing is trusted yet: the
 * analysis job checks the bytes themselves once the upload is completed.
 */
export async function startUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  projectId: string,
  input: { readonly fileName: string; readonly contentType: string; readonly size: number },
): Promise<{ sourceId: string; upload: UploadTransport }> {
  assertCan(ctx, "content.create");
  const project = await projectOf(deps.db, ctx, projectId);
  if (!isSourceContentType(input.contentType)) {
    throw creatorError("UNSUPPORTED_MEDIA_TYPE", "creator_type_unsupported");
  }
  const maxBytes = Math.min(
    deps.limits.maxUploadBytes,
    STORAGE_CATEGORIES["creator-sources"].maxBytes,
  );
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > maxBytes) {
    throw creatorError("PAYLOAD_TOO_LARGE", "creator_upload_too_large", {
      maximum: Math.floor(maxBytes / (1024 * 1024)),
    });
  }
  const contentType = input.contentType as AllowedContentType;
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
    });
    return source.id;
  });
  // The in-memory test store cannot receive a browser PUT: the app's route stands in.
  const upload: UploadTransport = signed.url.startsWith("memory://")
    ? { kind: "app", expiresAt: signed.expiresAt }
    : {
        kind: "direct",
        url: signed.url,
        method: "PUT",
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      };
  return { sourceId, upload };
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
  if (body.byteLength !== source.declaredBytes) {
    throw creatorError("VALIDATION_FAILED", "creator_upload_size_mismatch");
  }
  const storage = await deps.storage.forProvider(source.storageProvider);
  await storage.put(source.storageKey, body, {
    contentType: source.declaredContentType as AllowedContentType,
  });
}

/** The browser finished uploading: queue the analysis (verify the bytes, ffprobe). */
export async function completeUpload(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
): Promise<{ jobId: string }> {
  assertCan(ctx, "content.create");
  const source = await pendingSource(deps.db, ctx, sourceId);
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

/**
 * Uploads started and never completed: expired (the signed URL is dead by then) and
 * whatever bytes reached storage removed. Worker loop; `system` finds them across
 * workspaces, every write uses the row's own workspace.
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
    },
  });
  let cleaned = 0;
  for (const source of expired) {
    const moved = await deps.db.$transaction(async (tx) => {
      const result = await tx.creatorSource.updateMany({
        where: { id: source.id, workspaceId: source.workspaceId, status: "PENDING_UPLOAD" },
        data: { status: "EXPIRED" },
      });
      if (result.count === 1) {
        await tx.creatorProject.updateMany({
          where: { id: source.projectId, workspaceId: source.workspaceId, status: "UPLOADING" },
          data: { status: "DRAFT", version: { increment: 1 } },
        });
        await recordEvent(tx, source.workspaceId, source.projectId, "upload_expired", null);
      }
      return result.count === 1;
    });
    if (!moved) continue;
    cleaned += 1;
    try {
      const storage = await deps.storage.forProvider(source.storageProvider);
      await storage.delete(source.storageKey, { signal: AbortSignal.timeout(15_000) });
    } catch {
      deps.logger?.warn({ sourceId: source.id }, "Could not remove an expired upload");
    }
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
  input: { readonly language: string | null; readonly requestKey: string },
): Promise<{ jobId: string }> {
  assertCan(ctx, "content.create");
  await projectOf(deps.db, ctx, projectId);
  const provider = deps.transcription;
  if (provider === null) throw creatorError("SERVICE_UNAVAILABLE", "creator_provider_disabled");
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
      options: input.language === null ? {} : { language: input.language },
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
        metadata: { kind: "TRANSCRIBE", simulated: provider.simulated },
      });
    }
    return { jobId: job.id };
  });
}

export async function requestTranslation(
  deps: CreatorDeps,
  ctx: TenantContext,
  transcriptId: string,
  input: { readonly targetLanguage: string; readonly requestKey: string },
): Promise<{ jobId: string }> {
  assertCan(ctx, "content.create");
  if (!isUuid(transcriptId)) throw notFound("creator_transcript");
  const provider = deps.translation;
  if (provider === null) throw creatorError("SERVICE_UNAVAILABLE", "creator_provider_disabled");
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
      options: { transcriptId: transcript.id, targetLanguage: target },
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
