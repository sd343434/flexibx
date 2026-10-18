import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { CreatorJobKind } from "@/generated/prisma/enums";

import { captureHold, holdCredits, releaseHold } from "../billing/credits";
import type { CreditFeature } from "../billing/pricing";
import type { Db } from "../db/types";
import { buildWorkspaceKey, putOrCleanUp } from "../storage/storage";

import {
  billedMinutes,
  EXPORT_MAX_BYTES,
  HEARTBEAT_MS,
  JOB_DEADLINE_MS,
  JOB_STAGES,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_BASE_MS,
  STEP_TIMEOUT_MS,
  type CreatorDeps,
} from "./config";
import { classifyFailure, LeaseLostError, StepFailure, type JobFailure } from "./errors";
import {
  cuesForClip,
  extractAudio,
  probeMedia,
  renderClip,
  verifyRender,
  type AspectRatio,
} from "./media/media";
import { containerMatches, isSourceContentType, SNIFF_BYTES, sniffContainer } from "./media/sniff";
import { MediaToolError } from "./media/tools";
import { createWorkDir, removeWorkDir } from "./media/workdir";
import { LANGUAGE_PATTERN, validateTimedText } from "./providers/types";

// The Creator Studio's background work: queueing, claiming with a lease, the steps of
// each kind of job, and how a job ends. Pure (no `server-only`): the worker
// (`pnpm creator:worker`) and the integration tests drive it directly.
//
// Guarantees (tested):
// - One worker owns a job at a time: a claim is a compare-and-set that takes a queued
//   job, or a running one whose lease expired (its worker died). The lease is renewed
//   while the worker works; a worker that cannot renew aborts its step (FFmpeg and
//   provider calls are cancelled).
// - Every write a worker makes runs in a transaction that first locks the job row and
//   checks the worker's lease token and that the job is still RUNNING. A worker that
//   lost its lease (or whose job was cancelled) writes nothing, ever.
// - A succeeded step is never run again. A step that holds credits records the hold on
//   its row; a new attempt releases the previous attempt's hold before holding again, and
//   the hold is captured in the same transaction that stores the step's result — so the
//   work is charged once, and never for a result that was not stored.
// - Simulated provider output is never charged.

async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  const now = rows[0]?.now;
  if (now === undefined) throw new Error("Could not read the database clock");
  return now;
}

/** Appends to the project's event log (codes, counts and ids only). */
export async function recordEvent(
  tx: Db,
  workspaceId: string,
  projectId: string,
  type: string,
  actorUserId: string | null,
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  await tx.creatorProjectEvent.create({
    data: { workspaceId, projectId, type, actorUserId, metadata },
  });
}

// ── Queueing ──────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly exportId?: string;
  readonly kind: CreatorJobKind;
  readonly options?: Record<string, string>;
  readonly idempotencyKey: string;
  readonly requestedByUserId: string | null;
  readonly now: Date;
}

/**
 * Queues a job with its steps (inside the caller's transaction). The same idempotency
 * key returns the existing job; the database refuses a second active job of the same
 * kind for the same source (`creator_jobs_one_active`).
 */
export async function enqueueJob(
  tx: Db,
  input: EnqueueInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await tx.creatorJob.findFirst({
    where: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (existing !== null) return { id: existing.id, created: false };
  const job = await tx.creatorJob.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sourceId: input.sourceId,
      exportId: input.exportId ?? null,
      kind: input.kind,
      maxAttempts: MAX_ATTEMPTS,
      deadlineAt: new Date(input.now.getTime() + JOB_DEADLINE_MS),
      options: input.options ?? {},
      idempotencyKey: input.idempotencyKey,
      requestedByUserId: input.requestedByUserId,
    },
    select: { id: true },
  });
  await tx.creatorJobStep.createMany({
    data: JOB_STAGES[input.kind].map((stage, position) => ({
      workspaceId: input.workspaceId,
      jobId: job.id,
      stage,
      position,
    })),
  });
  await recordEvent(tx, input.workspaceId, input.projectId, "job_queued", input.requestedByUserId, {
    kind: input.kind,
    jobId: job.id,
  });
  return { id: job.id, created: true };
}

// ── Leases ────────────────────────────────────────────────────────────────────

export interface ClaimedJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly exportId: string | null;
  readonly kind: CreatorJobKind;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly deadlineAt: Date;
  readonly options: Prisma.JsonValue;
  readonly requestedByUserId: string | null;
  readonly token: string;
}

class JobLease {
  constructor(
    private readonly deps: CreatorDeps,
    readonly job: ClaimedJob,
  ) {}

  private get leaseMs() {
    return this.deps.timing?.leaseMs ?? LEASE_MS;
  }

  /** Pushes the lease forward; false when this worker no longer owns a running job. */
  async renew(): Promise<boolean> {
    const now = await dbNow(this.deps.db);
    const renewed = await this.deps.db.creatorJob.updateMany({
      where: {
        id: this.job.id,
        workspaceId: this.job.workspaceId,
        leaseToken: this.job.token,
        state: "RUNNING",
      },
      data: { leaseExpiresAt: new Date(now.getTime() + this.leaseMs) },
    });
    return renewed.count === 1;
  }

  /** Runs `work` in a transaction that holds the job row and proves this worker owns it. */
  async write<T>(work: (tx: Db, now: Date) => Promise<T>): Promise<T> {
    return this.deps.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "creator_jobs"
        WHERE "id" = ${this.job.id}::uuid AND "workspace_id" = ${this.job.workspaceId}::uuid
          AND "lease_token" = ${this.job.token}::uuid AND "state" = 'RUNNING'
        FOR UPDATE`;
      if (rows.length !== 1) throw new LeaseLostError();
      return work(tx, await dbNow(tx));
    });
  }
}

/**
 * Claims the next due job: a queued one whose time has come, or a running one whose
 * lease expired (its worker stopped). Compare-and-set: of several workers, one wins.
 * A job past its attempts or its deadline is failed instead of run.
 */
export async function claimNextJob(
  deps: CreatorDeps,
  system: PrismaClient,
): Promise<ClaimedJob | null> {
  const now = await dbNow(deps.db);
  const due = {
    OR: [
      { state: "QUEUED" as const, runAfter: { lte: now } },
      { state: "RUNNING" as const, leaseExpiresAt: { lt: now } },
    ],
  };
  // SYSTEM PATH (reviewed): ids of due jobs across workspaces; every write below goes
  // through the guarded client with the job's own workspace id.
  const candidates = await system.creatorJob.findMany({
    where: due,
    orderBy: { runAfter: "asc" },
    take: 10,
    select: { id: true, workspaceId: true },
  });
  for (const candidate of candidates) {
    const token = randomUUID();
    const claimed = await deps.db.creatorJob.updateMany({
      where: { id: candidate.id, workspaceId: candidate.workspaceId, ...due },
      data: {
        state: "RUNNING",
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + (deps.timing?.leaseMs ?? LEASE_MS)),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) continue;
    const row = await deps.db.creatorJob.findFirst({
      where: { id: candidate.id, workspaceId: candidate.workspaceId },
    });
    if (row === null) continue;
    const job: ClaimedJob = { ...row, token };
    const lease = new JobLease(deps, job);
    try {
      if (row.startedAt === null) {
        await lease.write((tx, at) =>
          tx.creatorJob.updateMany({
            where: { id: job.id, workspaceId: job.workspaceId },
            data: { startedAt: at },
          }),
        );
      }
      if (row.attempts > row.maxAttempts) {
        await finishFailed(deps, lease, null, new StepFailure("max_attempts", false));
        continue;
      }
      if (now >= row.deadlineAt) {
        await finishFailed(deps, lease, null, new StepFailure("deadline_reached", false));
        continue;
      }
    } catch (error) {
      if (error instanceof LeaseLostError) continue;
      throw error;
    }
    return job;
  }
  return null;
}

// ── Running a job ─────────────────────────────────────────────────────────────

export type JobOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "retrying" | "failed"; readonly failure: JobFailure }
  | { readonly status: "lease_lost" };

interface StepRow {
  readonly id: string;
  readonly stage: string;
  readonly attempts: number;
  readonly holdId: string | null;
}

interface StepContext {
  readonly deps: CreatorDeps;
  readonly job: ClaimedJob;
  readonly step: StepRow;
  readonly lease: JobLease;
  readonly signal: AbortSignal;
  readonly workDir: string;
}

/** Runs the claimed job's remaining steps; ends it as succeeded, retrying or failed. */
export async function runClaimedJob(deps: CreatorDeps, job: ClaimedJob): Promise<JobOutcome> {
  const lease = new JobLease(deps, job);
  const lost = new AbortController();
  const heartbeat = setInterval(() => {
    lease.renew().then(
      (owned) => {
        if (!owned) lost.abort();
      },
      () => {
        // A database hiccup: the next beat tries again; the lease outlives a few misses.
      },
    );
  }, deps.timing?.heartbeatMs ?? HEARTBEAT_MS);
  const workDir = await createWorkDir(deps.workDir);
  try {
    const steps = await deps.db.creatorJobStep.findMany({
      where: { workspaceId: job.workspaceId, jobId: job.id },
      orderBy: { position: "asc" },
      select: { id: true, stage: true, attempts: true, holdId: true, state: true },
    });
    for (const row of steps) {
      if (row.state === "SUCCEEDED") continue;
      const step: StepRow = { ...row, attempts: row.attempts + 1 };
      await lease.write(async (tx, at) => {
        await tx.creatorJobStep.updateMany({
          where: { id: row.id, workspaceId: job.workspaceId },
          data: { state: "RUNNING", attempts: step.attempts, startedAt: at, errorCode: null },
        });
        await tx.creatorJob.updateMany({
          where: { id: job.id, workspaceId: job.workspaceId },
          data: { stage: row.stage },
        });
      });
      const timeout = AbortSignal.timeout(
        deps.timing?.stepTimeoutMs ?? STEP_TIMEOUT_MS[row.stage] ?? 60_000,
      );
      const signal = AbortSignal.any([lost.signal, timeout]);
      const handler = HANDLERS[row.stage];
      try {
        if (handler === undefined) throw new StepFailure("internal_error", false);
        await handler({ deps, job, step, lease, signal, workDir });
      } catch (error) {
        if (error instanceof LeaseLostError || lost.signal.aborted) return { status: "lease_lost" };
        const failure = classifyFailure(error, timeout.aborted);
        deps.logger?.warn(
          {
            jobId: job.id,
            stage: row.stage,
            failure: failure.failure,
            error: error instanceof Error ? error.name : "unknown",
          },
          "Creator job step failed",
        );
        return await finishFailed(deps, lease, step, failure);
      }
    }
    await finishSucceeded(deps, lease);
    return { status: "succeeded" };
  } catch (error) {
    if (error instanceof LeaseLostError) return { status: "lease_lost" };
    throw error;
  } finally {
    clearInterval(heartbeat);
    await removeWorkDir(workDir).catch(() => undefined);
  }
}

/** Claims and runs one due job (the worker loop and tests). */
export async function workOnce(
  deps: CreatorDeps,
  system: PrismaClient,
): Promise<{ readonly jobId: string; readonly outcome: JobOutcome } | null> {
  const job = await claimNextJob(deps, system);
  if (job === null) return null;
  return { jobId: job.id, outcome: await runClaimedJob(deps, job) };
}

const FILE_PROBLEMS: ReadonlySet<JobFailure> = new Set([
  "upload_missing",
  "size_mismatch",
  "too_large",
  "unsupported_format",
  "type_mismatch",
  "unreadable_media",
  "too_long",
]);

async function releaseStepHold(
  deps: CreatorDeps,
  tx: Db,
  job: ClaimedJob,
  holdId: string | null,
  now: Date,
) {
  if (holdId === null) return;
  await releaseHold(tx, job.workspaceId, holdId, "creator_step_failed", now, deps.credits);
}

/**
 * Ends a step that failed: back to the queue with a backoff when the failure is worth
 * another attempt (and attempts remain), otherwise the job fails. Either way the step's
 * hold is released (a later attempt holds again; failed work is never charged).
 */
async function finishFailed(
  deps: CreatorDeps,
  lease: JobLease,
  step: StepRow | null,
  failure: StepFailure,
): Promise<JobOutcome> {
  const { job } = lease;
  let rejectedKey: { provider: string; key: string } | null = null;
  const outcome = await lease.write(async (tx, now): Promise<JobOutcome> => {
    if (step !== null) {
      const current = await tx.creatorJobStep.findFirst({
        where: { id: step.id, workspaceId: job.workspaceId },
        select: { holdId: true },
      });
      await releaseStepHold(deps, tx, job, current?.holdId ?? null, now);
      await tx.creatorJobStep.updateMany({
        where: { id: step.id, workspaceId: job.workspaceId },
        data: { state: "FAILED", errorCode: failure.failure, finishedAt: now },
      });
    }
    if (failure.retryable && job.attempts < job.maxAttempts) {
      const backoff = (deps.timing?.retryBaseMs ?? RETRY_BASE_MS) * 2 ** (job.attempts - 1);
      await tx.creatorJob.updateMany({
        where: { id: job.id, workspaceId: job.workspaceId },
        data: {
          state: "QUEUED",
          leaseToken: null,
          leaseExpiresAt: null,
          failureCode: failure.failure,
          runAfter: new Date(now.getTime() + backoff),
        },
      });
      await recordEvent(tx, job.workspaceId, job.projectId, "job_retrying", null, {
        kind: job.kind,
        jobId: job.id,
        failure: failure.failure,
        attempt: job.attempts,
      });
      return { status: "retrying", failure: failure.failure };
    }
    await tx.creatorJob.updateMany({
      where: { id: job.id, workspaceId: job.workspaceId },
      data: {
        state: "FAILED",
        failureCode: failure.failure,
        finishedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (job.kind === "ANALYZE" && FILE_PROBLEMS.has(failure.failure)) {
      const source = await tx.creatorSource.findFirst({
        where: { id: job.sourceId, workspaceId: job.workspaceId },
        select: { storageProvider: true, storageKey: true },
      });
      await tx.creatorSource.updateMany({
        where: { id: job.sourceId, workspaceId: job.workspaceId },
        data: { status: "REJECTED", rejectionCode: failure.failure },
      });
      if (source !== null)
        rejectedKey = { provider: source.storageProvider, key: source.storageKey };
    }
    if (job.exportId !== null) {
      await tx.creatorExport.updateMany({
        where: {
          id: job.exportId,
          workspaceId: job.workspaceId,
          status: { in: ["QUEUED", "RENDERING"] },
        },
        data: { status: "FAILED", failureCode: failure.failure },
      });
    }
    if (job.kind === "ANALYZE" || job.kind === "TRANSCRIBE") {
      await tx.creatorProject.updateMany({
        where: { id: job.projectId, workspaceId: job.workspaceId },
        data: { status: "FAILED", version: { increment: 1 } },
      });
    }
    await recordEvent(tx, job.workspaceId, job.projectId, "job_failed", null, {
      kind: job.kind,
      jobId: job.id,
      failure: failure.failure,
    });
    return { status: "failed", failure: failure.failure };
  });
  // A rejected upload is not kept (it may not even be media).
  const rejected = rejectedKey as { provider: string; key: string } | null;
  if (rejected !== null) {
    try {
      const storage = await deps.storage.forProvider(rejected.provider as "LEGACY_S3" | "WASABI");
      await storage.delete(rejected.key, { signal: AbortSignal.timeout(15_000) });
    } catch {
      deps.logger?.warn({ jobId: job.id }, "Could not remove a rejected upload");
    }
  }
  return outcome;
}

async function finishSucceeded(deps: CreatorDeps, lease: JobLease): Promise<void> {
  const { job } = lease;
  await lease.write(async (tx, now) => {
    await tx.creatorJob.updateMany({
      where: { id: job.id, workspaceId: job.workspaceId },
      data: {
        state: "SUCCEEDED",
        stage: null,
        failureCode: null,
        finishedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    const status =
      job.kind === "ANALYZE"
        ? "READY"
        : job.kind === "EXPORT"
          ? "COMPLETED"
          : job.kind === "TRANSCRIBE"
            ? "NEEDS_REVIEW"
            : null;
    if (status !== null) {
      await tx.creatorProject.updateMany({
        where: { id: job.projectId, workspaceId: job.workspaceId },
        data: { status, version: { increment: 1 } },
      });
    }
    await recordEvent(tx, job.workspaceId, job.projectId, "job_succeeded", null, {
      kind: job.kind,
      jobId: job.id,
    });
  });
}

/**
 * Holds credits for a step attempt (inside a fenced transaction). A hold of an earlier
 * attempt that is still open is released first; the same attempt reuses its hold.
 */
async function holdForStep(
  ctx: StepContext,
  feature: CreditFeature,
  units: number,
): Promise<string> {
  const { deps, job, step, lease } = ctx;
  const key = `creator:${job.id}:${step.stage}:${String(step.attempts)}`;
  return lease.write(async (tx, now) => {
    const current = await tx.creatorJobStep.findFirst({
      where: { id: step.id, workspaceId: job.workspaceId },
      select: { holdId: true },
    });
    if (current !== null && current.holdId !== null) {
      const previous = await tx.creditHold.findFirst({
        where: { workspaceId: job.workspaceId, id: current.holdId },
        select: { id: true, idempotencyKey: true, status: true },
      });
      if (previous?.status === "HELD" && previous.idempotencyKey === key) return previous.id;
      if (previous?.status === "HELD") {
        await releaseHold(
          tx,
          job.workspaceId,
          previous.id,
          "creator_superseded",
          now,
          deps.credits,
        );
      }
    }
    const workspace = await tx.workspace.findFirst({
      where: { id: job.workspaceId },
      select: { timezone: true },
    });
    const hold = await holdCredits(
      tx,
      {
        workspaceId: job.workspaceId,
        feature,
        units,
        idempotencyKey: key,
        reference: `creator_job:${job.id}`,
        userId: job.requestedByUserId,
        timeZone: workspace?.timezone ?? "UTC",
        now,
      },
      deps.credits,
    );
    await tx.creatorJobStep.updateMany({
      where: { id: step.id, workspaceId: job.workspaceId },
      data: { holdId: hold.holdId },
    });
    return hold.holdId;
  });
}

async function verifiedSource(ctx: StepContext) {
  const source = await ctx.deps.db.creatorSource.findFirst({
    where: { id: ctx.job.sourceId, workspaceId: ctx.job.workspaceId },
  });
  if (source === null) throw new StepFailure("upload_missing", false);
  return source;
}

/** Copies the source's bytes into the run's scratch directory. */
async function downloadSource(
  ctx: StepContext,
  source: { storageProvider: "LEGACY_S3" | "WASABI"; storageKey: string; declaredBytes: number },
): Promise<{ path: string; body: Uint8Array }> {
  let storage;
  try {
    storage = await ctx.deps.storage.forProvider(source.storageProvider);
  } catch {
    throw new StepFailure("storage_unavailable", true);
  }
  let object;
  try {
    object = await storage.getObject(source.storageKey, {
      expectedBytes: source.declaredBytes,
      signal: ctx.signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw new StepFailure("storage_unavailable", true);
  }
  if (object === null) throw new StepFailure("upload_missing", false);
  const path = join(ctx.workDir, "source.bin");
  await writeFile(path, object.body);
  return { path, body: object.body };
}

const stepDone = (
  tx: Db,
  ctx: StepContext,
  now: Date,
  output: Record<string, string | number | boolean | null>,
  provider?: { id: string; model: string; simulated: boolean },
) =>
  tx.creatorJobStep.updateMany({
    where: { id: ctx.step.id, workspaceId: ctx.job.workspaceId },
    data: {
      state: "SUCCEEDED",
      finishedAt: now,
      output,
      ...(provider === undefined
        ? {}
        : { provider: provider.id, model: provider.model, simulated: provider.simulated }),
    },
  });

// ── Steps ─────────────────────────────────────────────────────────────────────

/** ANALYZE: the uploaded bytes are what was announced, a known container, and media. */
async function verify(ctx: StepContext): Promise<void> {
  const { deps, job } = ctx;
  const source = await verifiedSource(ctx);
  const { path, body } = await downloadSource(ctx, source);
  if (body.byteLength !== source.declaredBytes) throw new StepFailure("size_mismatch", false);
  if (body.byteLength > deps.limits.maxUploadBytes) throw new StepFailure("too_large", false);
  const container = sniffContainer(body.subarray(0, SNIFF_BYTES));
  if (container === null) throw new StepFailure("unsupported_format", false);
  if (
    !isSourceContentType(source.declaredContentType) ||
    !containerMatches(source.declaredContentType, container)
  ) {
    throw new StepFailure("type_mismatch", false);
  }
  let info;
  try {
    info = await probeMedia(deps.tools, path, { timeoutMs: 60_000, signal: ctx.signal });
  } catch (error) {
    if (error instanceof MediaToolError && error.code === "failed") {
      throw new StepFailure("unreadable_media", false);
    }
    throw error;
  }
  if (info.durationMs <= 0 || (!info.hasVideo && !info.hasAudio)) {
    throw new StepFailure("unreadable_media", false);
  }
  if (info.durationMs > deps.limits.maxDurationMs) throw new StepFailure("too_long", false);
  const sha256 = createHash("sha256").update(body).digest("hex");
  await ctx.lease.write(async (tx, now) => {
    await tx.creatorSource.updateMany({
      where: { id: source.id, workspaceId: job.workspaceId },
      data: {
        status: "VERIFIED",
        verifiedAt: now,
        container,
        byteSize: body.byteLength,
        sha256,
        durationMs: info.durationMs,
        width: info.width,
        height: info.height,
        fpsMilli: info.fpsMilli,
        hasAudio: info.hasAudio,
        hasVideo: info.hasVideo,
        videoCodec: info.videoCodec,
        audioCodec: info.audioCodec,
      },
    });
    await stepDone(tx, ctx, now, {
      container,
      durationMs: info.durationMs,
      hasVideo: info.hasVideo,
      hasAudio: info.hasAudio,
    });
    await recordEvent(tx, job.workspaceId, job.projectId, "source_verified", null, {
      container,
      durationMs: info.durationMs,
    });
  });
}

const jobOptions = z.object({
  language: z.string().regex(LANGUAGE_PATTERN).optional(),
  targetLanguage: z.string().regex(LANGUAGE_PATTERN).optional(),
  transcriptId: z.uuid().optional(),
});

/** TRANSCRIBE: audio → provider → stored transcript (charged only when real). */
async function transcribe(ctx: StepContext): Promise<void> {
  const { deps, job } = ctx;
  const provider = deps.transcription;
  if (provider === null) throw new StepFailure("provider_disabled", false);
  const source = await verifiedSource(ctx);
  if (source.status !== "VERIFIED" || source.durationMs === null) {
    throw new StepFailure("unreadable_media", false);
  }
  if (source.hasAudio !== true) throw new StepFailure("no_audio", false);
  if (source.durationMs > provider.maxDurationMs) throw new StepFailure("too_long", false);
  const options = jobOptions.parse(job.options ?? {});
  const hint = options.language ?? null;
  if (hint !== null && !provider.supportsLanguage(hint)) {
    throw new StepFailure("unsupported_language", false);
  }
  const holdId = provider.simulated
    ? null
    : await holdForStep(ctx, "creator_transcription", billedMinutes(source.durationMs));
  const { path } = await downloadSource(ctx, source);
  const audioPath = join(ctx.workDir, "audio.wav");
  await extractAudio(deps.tools, path, audioPath, { timeoutMs: 5 * 60_000, signal: ctx.signal });
  const result = await provider.transcribe({
    audioPath,
    durationMs: source.durationMs,
    languageHint: hint,
    signal: ctx.signal,
  });
  const segments = validateTimedText(result.segments, source.durationMs);
  if (!LANGUAGE_PATTERN.test(result.language))
    throw new StepFailure("provider_invalid_output", false);
  await ctx.lease.write(async (tx, now) => {
    const transcript = await tx.creatorTranscript.create({
      data: {
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        sourceId: source.id,
        jobId: job.id,
        kind: "ORIGINAL",
        language: result.language,
        provider: provider.id,
        model: provider.model,
        simulated: provider.simulated,
        segmentCount: segments.length,
      },
      select: { id: true },
    });
    await tx.creatorTranscriptSegment.createMany({
      data: segments.map((segment, position) => ({
        workspaceId: job.workspaceId,
        transcriptId: transcript.id,
        position,
        ...segment,
      })),
    });
    if (holdId !== null) {
      await captureHold(
        tx,
        job.workspaceId,
        holdId,
        { provider: provider.id, model: provider.model },
        now,
        deps.credits,
      );
    }
    await stepDone(
      tx,
      ctx,
      now,
      { segments: segments.length, language: result.language, charged: holdId !== null },
      provider,
    );
    await recordEvent(tx, job.workspaceId, job.projectId, "transcribed", null, {
      segments: segments.length,
      simulated: provider.simulated,
    });
  });
}

/** SUGGEST: rule-based clips from the transcript's text and timestamps. */
async function suggest(ctx: StepContext): Promise<void> {
  const { deps, job } = ctx;
  const transcript = await deps.db.creatorTranscript.findFirst({
    where: { workspaceId: job.workspaceId, jobId: job.id, kind: "ORIGINAL" },
    select: { id: true, simulated: true, source: { select: { durationMs: true } } },
  });
  if (transcript === null) throw new StepFailure("internal_error", false);
  const segments = await deps.db.creatorTranscriptSegment.findMany({
    where: { workspaceId: job.workspaceId, transcriptId: transcript.id },
    orderBy: { position: "asc" },
    select: { startMs: true, endMs: true, text: true },
  });
  const suggestions = deps.clips.suggest({
    segments,
    durationMs: transcript.source.durationMs ?? 0,
  });
  await ctx.lease.write(async (tx, now) => {
    if (suggestions.length > 0) {
      await tx.creatorClip.createMany({
        data: suggestions.map((clip) => ({
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          sourceId: job.sourceId,
          transcriptId: transcript.id,
          title: clip.title.slice(0, 200) || "—",
          startMs: clip.startMs,
          endMs: clip.endMs,
          suggestedStartMs: clip.startMs,
          suggestedEndMs: clip.endMs,
          text: clip.text,
          reasons: [...clip.reasons],
          score: clip.score,
          origin: "SUGGESTED",
          simulated: transcript.simulated,
        })),
      });
    }
    await stepDone(tx, ctx, now, { clips: suggestions.length, suggester: deps.clips.id });
    await recordEvent(tx, job.workspaceId, job.projectId, "clips_suggested", null, {
      clips: suggestions.length,
    });
  });
}

/** TRANSLATE: the transcript's cues in another language (same timestamps). */
async function translate(ctx: StepContext): Promise<void> {
  const { deps, job } = ctx;
  const provider = deps.translation;
  if (provider === null) throw new StepFailure("provider_disabled", false);
  const options = jobOptions.parse(job.options ?? {});
  if (options.targetLanguage === undefined || options.transcriptId === undefined) {
    throw new StepFailure("internal_error", false);
  }
  if (!provider.supportsLanguage(options.targetLanguage)) {
    throw new StepFailure("unsupported_language", false);
  }
  const original = await deps.db.creatorTranscript.findFirst({
    where: {
      workspaceId: job.workspaceId,
      id: options.transcriptId,
      projectId: job.projectId,
      kind: "ORIGINAL",
    },
    select: { id: true, language: true, sourceId: true, source: { select: { durationMs: true } } },
  });
  if (original === null) throw new StepFailure("internal_error", false);
  const sourceDurationMs = original.source.durationMs;
  if (sourceDurationMs === null) throw new StepFailure("internal_error", false);
  const durationMs = sourceDurationMs;
  const segments = await deps.db.creatorTranscriptSegment.findMany({
    where: { workspaceId: job.workspaceId, transcriptId: original.id },
    orderBy: { position: "asc" },
    select: { startMs: true, endMs: true, text: true },
  });
  const holdId = provider.simulated
    ? null
    : await holdForStep(ctx, "creator_translation", billedMinutes(durationMs));
  const translated = validateTimedText(
    await provider.translate({
      segments,
      from: original.language,
      to: options.targetLanguage,
      signal: ctx.signal,
    }),
    durationMs,
  );
  if (translated.length !== segments.length)
    throw new StepFailure("provider_invalid_output", false);
  const language = options.targetLanguage;
  await ctx.lease.write(async (tx, now) => {
    const transcript = await tx.creatorTranscript.create({
      data: {
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        sourceId: original.sourceId,
        jobId: job.id,
        kind: "TRANSLATION",
        language,
        translatedFromId: original.id,
        provider: provider.id,
        model: provider.model,
        simulated: provider.simulated,
        segmentCount: translated.length,
      },
      select: { id: true },
    });
    await tx.creatorTranscriptSegment.createMany({
      data: translated.map((segment, position) => ({
        workspaceId: job.workspaceId,
        transcriptId: transcript.id,
        position,
        ...segment,
      })),
    });
    if (holdId !== null) {
      await captureHold(
        tx,
        job.workspaceId,
        holdId,
        { provider: provider.id, model: provider.model },
        now,
        deps.credits,
      );
    }
    await stepDone(
      tx,
      ctx,
      now,
      { segments: translated.length, language, charged: holdId !== null },
      provider,
    );
    await recordEvent(tx, job.workspaceId, job.projectId, "translated", null, {
      language,
      simulated: provider.simulated,
    });
  });
}

/**
 * EXPORT: cut, reframe and encode the reviewed clip, verify the file, store it
 * privately, then mark the export READY and charge it — in one fenced transaction. A
 * file stored by a worker that can no longer record it is removed again.
 */
async function render(ctx: StepContext): Promise<void> {
  const { deps, job } = ctx;
  if (job.exportId === null) throw new StepFailure("internal_error", false);
  const exportRow = await deps.db.creatorExport.findFirst({
    where: { id: job.exportId, workspaceId: job.workspaceId },
  });
  if (exportRow === null) throw new StepFailure("internal_error", false);
  const source = await verifiedSource(ctx);
  if (source.hasVideo !== true || source.width === null || source.height === null) {
    throw new StepFailure("no_video", false);
  }
  await ctx.lease.write((tx) =>
    tx.creatorExport.updateMany({
      where: { id: exportRow.id, workspaceId: job.workspaceId },
      data: { status: "RENDERING", failureCode: null },
    }),
  );
  const durationMs = exportRow.endMs - exportRow.startMs;
  const holdId = await holdForStep(ctx, "creator_export", billedMinutes(durationMs));
  const { path } = await downloadSource(ctx, source);
  let cues = null;
  if (exportRow.burnSubtitles && exportRow.subtitleTranscriptId !== null) {
    const segments = await deps.db.creatorTranscriptSegment.findMany({
      where: { workspaceId: job.workspaceId, transcriptId: exportRow.subtitleTranscriptId },
      orderBy: { position: "asc" },
      select: { startMs: true, endMs: true, text: true },
    });
    cues = cuesForClip(segments, exportRow.startMs, exportRow.endMs);
  }
  const output = join(ctx.workDir, "clip.mp4");
  const aspect: AspectRatio = exportRow.aspectRatio;
  await renderClip(deps.tools, {
    input: path,
    output,
    workDir: ctx.workDir,
    startMs: exportRow.startMs,
    endMs: exportRow.endMs,
    source: { width: source.width, height: source.height, hasAudio: source.hasAudio === true },
    aspect,
    cropX: exportRow.cropX,
    subtitles: cues,
    maxBytes: EXPORT_MAX_BYTES,
    timeoutMs: 8 * 60_000,
    signal: ctx.signal,
  });
  const info = await verifyRender(
    deps.tools,
    output,
    { durationMs, aspect },
    { timeoutMs: 60_000, signal: ctx.signal },
  );
  if (info === null) throw new StepFailure("render_invalid", true);
  const bytes = new Uint8Array(await readFile(output));
  if (bytes.byteLength === 0 || bytes.byteLength >= EXPORT_MAX_BYTES) {
    throw new StepFailure("render_invalid", false);
  }
  let target;
  try {
    target = await deps.storage.writeTarget();
  } catch {
    throw new StepFailure("storage_unavailable", true);
  }
  const key = buildWorkspaceKey(job.workspaceId, "creator-exports", "video/mp4");
  try {
    await putOrCleanUp(target.storage, key, bytes, { contentType: "video/mp4" });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw new StepFailure("storage_unavailable", true);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    await ctx.lease.write(async (tx, now) => {
      await target.confirm(tx);
      await tx.creatorExport.updateMany({
        where: { id: exportRow.id, workspaceId: job.workspaceId },
        data: {
          status: "READY",
          storageProvider: target.provider,
          storageKey: key,
          byteSize: bytes.byteLength,
          sha256,
          durationMs: info.durationMs,
          width: info.width,
          height: info.height,
          readyAt: now,
          failureCode: null,
        },
      });
      await captureHold(
        tx,
        job.workspaceId,
        holdId,
        { provider: "ffmpeg", model: null },
        now,
        deps.credits,
      );
      await stepDone(
        tx,
        ctx,
        now,
        {
          bytes: bytes.byteLength,
          durationMs: info.durationMs,
          width: info.width ?? 0,
          height: info.height ?? 0,
        },
        { id: "ffmpeg", model: "libx264", simulated: false },
      );
      await recordEvent(tx, job.workspaceId, job.projectId, "export_ready", null, {
        exportId: exportRow.id,
        aspectRatio: exportRow.aspectRatio,
      });
    });
  } catch (error) {
    // Not recorded (lease lost, a storage location change, the database): not kept.
    await target.storage.delete(key, { signal: AbortSignal.timeout(15_000) }).catch(() => {
      deps.logger?.error({ jobId: job.id }, "Could not remove an unrecorded export");
    });
    throw error;
  }
}

const HANDLERS: Readonly<Record<string, ((ctx: StepContext) => Promise<void>) | undefined>> = {
  VERIFY: verify,
  TRANSCRIBE: transcribe,
  SUGGEST: suggest,
  TRANSLATE: translate,
  RENDER: render,
};
