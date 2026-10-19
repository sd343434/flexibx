import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { CreatorJobKind, StorageProvider } from "@/generated/prisma/enums";

import { captureHold, holdCredits, releaseHold } from "../billing/credits";
import type { CreditFeature } from "../billing/pricing";
import type { Db } from "../db/types";
import { buildWorkspaceKey, ObjectTooLargeError, putOrCleanUp } from "../storage/storage";

import {
  billedMinutes,
  DEFAULT_MAX_RUNNING_JOBS,
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
import { queueStorageDeletions } from "./deletions";
import { classifyFailure, LeaseLostError, StepFailure, type JobFailure } from "./errors";
import { freeBytes, hashFile, readHead } from "./media/files";
import {
  cuesForClip,
  encodeAudioPiece,
  extractAudio,
  probeMedia,
  renderClip,
  verifyRender,
  type AspectRatio,
} from "./media/media";
import { containerMatches, isSourceContentType, SNIFF_BYTES, sniffContainer } from "./media/sniff";
import { MediaToolError } from "./media/tools";
import { createWorkDir, removeWorkDir } from "./media/workdir";
import { LANGUAGE_PATTERN, validateTimedText, type TimedText } from "./providers/types";

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
// - Provider results a step already paid for (transcribed audio pieces, translated
//   batches) are kept on the step (`checkpoint`, fenced), so a retried attempt only buys
//   what is still missing. A request whose outcome is unknown is never retried blindly.
// - Work on our own machines (FFmpeg) and work bought from a provider are recorded apart
//   on the step (local_processing_ms vs provider_* usage and estimated cost).

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
 * A job past its attempts or its deadline is failed instead of run. A workspace already
 * running its share of jobs (limits.maxRunningJobsPerWorkspace) is skipped: the check and
 * the claim run under a per-workspace advisory lock, so two workers cannot both take the
 * last slot.
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
    take: 25,
    select: { id: true, workspaceId: true },
  });
  const maxRunning = deps.limits.maxRunningJobsPerWorkspace ?? DEFAULT_MAX_RUNNING_JOBS;
  const busy = new Set<string>();
  for (const candidate of candidates) {
    if (busy.has(candidate.workspaceId)) continue;
    const token = randomUUID();
    const claimed = await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creator-claim:${candidate.workspaceId}`}))`;
      // Jobs of this workspace held by a live worker (an expired lease frees its slot).
      const running = await tx.creatorJob.count({
        where: {
          workspaceId: candidate.workspaceId,
          state: "RUNNING",
          leaseExpiresAt: { gte: now },
          NOT: { id: candidate.id },
        },
      });
      if (running >= maxRunning) return null;
      return tx.creatorJob.updateMany({
        where: { id: candidate.id, workspaceId: candidate.workspaceId, ...due },
        data: {
          state: "RUNNING",
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + (deps.timing?.leaseMs ?? LEASE_MS)),
          attempts: { increment: 1 },
        },
      });
    });
    if (claimed === null) {
      busy.add(candidate.workspaceId);
      continue;
    }
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
    const project = await deps.db.creatorProject.findFirst({
      where: { id: job.projectId, workspaceId: job.workspaceId },
      select: { status: true },
    });
    if (project === null || project.status === "DELETING") {
      return await finishFailed(deps, lease, null, new StepFailure("project_deleted", false));
    }
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
  "checksum_mismatch",
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
      // A rejected upload is not kept (it may not even be media): queued for deletion in
      // this transaction, removed by the worker's storage sweep.
      if (source !== null) {
        await queueStorageDeletions(
          tx,
          [
            {
              workspaceId: job.workspaceId,
              projectId: job.projectId,
              reason: "source_rejected",
              storageProvider: source.storageProvider,
              storageKey: source.storageKey,
            },
          ],
          now,
        );
      }
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
        where: { id: job.projectId, workspaceId: job.workspaceId, status: { not: "DELETING" } },
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
        where: { id: job.projectId, workspaceId: job.workspaceId, status: { not: "DELETING" } },
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

/** Scratch space a step needs on top of the source (audio, pieces, the rendered clip). */
export const SCRATCH_MARGIN_BYTES = 256 * 1024 * 1024;

interface SourceFile {
  readonly storageProvider: StorageProvider;
  readonly storageKey: string;
  readonly declaredBytes: number;
  /** Set once verified: later steps check the bytes they process are those verified. */
  readonly sha256: string | null;
}

/**
 * Streams the source into the run's scratch directory (never into memory). Refuses to
 * start when the disk could not hold it plus the step's own files; after ANALYZE, the
 * bytes must still hash to what was verified.
 */
async function downloadSource(
  ctx: StepContext,
  source: SourceFile,
): Promise<{ path: string; bytes: number }> {
  let storage;
  try {
    storage = await ctx.deps.storage.forProvider(source.storageProvider);
  } catch {
    throw new StepFailure("storage_unavailable", true);
  }
  if (storage.downloadToFile === undefined) throw new StepFailure("storage_unavailable", false);
  const free = await freeBytes(ctx.workDir);
  if (free !== null && free < 2 * source.declaredBytes + SCRATCH_MARGIN_BYTES) {
    throw new StepFailure("worker_disk_full", true);
  }
  const path = join(ctx.workDir, "source.bin");
  let bytes;
  try {
    bytes = await storage.downloadToFile(source.storageKey, path, {
      expectedBytes: source.declaredBytes,
      maxBytes: source.declaredBytes,
      signal: ctx.signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof ObjectTooLargeError) throw new StepFailure("size_mismatch", false);
    throw new StepFailure("storage_unavailable", true);
  }
  if (bytes === null) throw new StepFailure("upload_missing", false);
  if (source.sha256 !== null) {
    const { sha256 } = await hashFile(path, null, ctx.signal);
    if (sha256 !== source.sha256) throw new StepFailure("checksum_mismatch", false);
  }
  return { path, bytes };
}

interface StepCosts {
  readonly localProcessingMs?: number | null;
  readonly providerAudioSeconds?: number | null;
  readonly providerInputTokens?: number | null;
  readonly providerOutputTokens?: number | null;
  readonly providerCostMicroUsd?: number | null;
}

/** Times local work (FFmpeg) for the step's cost record. */
async function timed<T>(costs: { localMs: number }, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    costs.localMs += Date.now() - started;
  }
}

/** Saves what this attempt already bought from a provider (fenced: only the owner writes). */
async function saveCheckpoint(ctx: StepContext, checkpoint: Prisma.InputJsonValue): Promise<void> {
  await ctx.lease.write((tx) =>
    tx.creatorJobStep.updateMany({
      where: { id: ctx.step.id, workspaceId: ctx.job.workspaceId },
      data: { checkpoint },
    }),
  );
}

async function loadCheckpoint(ctx: StepContext): Promise<unknown> {
  const row = await ctx.deps.db.creatorJobStep.findFirst({
    where: { id: ctx.step.id, workspaceId: ctx.job.workspaceId },
    select: { checkpoint: true },
  });
  return row?.checkpoint ?? null;
}

const stepDone = (
  tx: Db,
  ctx: StepContext,
  now: Date,
  output: Record<string, string | number | boolean | null>,
  provider?: { id: string; model: string; simulated: boolean },
  costs: StepCosts = {},
) =>
  tx.creatorJobStep.updateMany({
    where: { id: ctx.step.id, workspaceId: ctx.job.workspaceId },
    data: {
      state: "SUCCEEDED",
      finishedAt: now,
      output,
      checkpoint: Prisma.DbNull,
      localProcessingMs: costs.localProcessingMs ?? null,
      providerAudioSeconds: costs.providerAudioSeconds ?? null,
      providerInputTokens: costs.providerInputTokens ?? null,
      providerOutputTokens: costs.providerOutputTokens ?? null,
      providerCostMicroUsd: costs.providerCostMicroUsd ?? null,
      ...(provider === undefined
        ? {}
        : { provider: provider.id, model: provider.model, simulated: provider.simulated }),
    },
  });

// ── Steps ─────────────────────────────────────────────────────────────────────

/**
 * ANALYZE: the uploaded bytes are what was announced (size; the SHA-256 the browser
 * declared for the file or for each of its parts), a known container, and media.
 */
async function verify(ctx: StepContext): Promise<void> {
  const { deps, job } = ctx;
  const source = await verifiedSource(ctx);
  const costs = { localMs: 0 };
  const { path, bytes } = await downloadSource(ctx, { ...source, sha256: null });
  if (bytes !== source.declaredBytes) throw new StepFailure("size_mismatch", false);
  if (bytes > deps.limits.maxUploadBytes) throw new StepFailure("too_large", false);
  const container = sniffContainer(await readHead(path, SNIFF_BYTES));
  if (container === null) throw new StepFailure("unsupported_format", false);
  if (
    !isSourceContentType(source.declaredContentType) ||
    !containerMatches(source.declaredContentType, container)
  ) {
    throw new StepFailure("type_mismatch", false);
  }
  const multipart = source.uploadMode === "multipart" ? source.partSizeBytes : null;
  const hashes = await hashFile(path, multipart, ctx.signal);
  if (multipart !== null) {
    const parts = await deps.db.creatorSourcePart.findMany({
      where: { workspaceId: job.workspaceId, sourceId: source.id },
      orderBy: { partNumber: "asc" },
      select: { partNumber: true, sha256: true },
    });
    const matches =
      parts.length === hashes.parts.length &&
      parts.every(
        (part, index) => part.partNumber === index + 1 && part.sha256 === hashes.parts[index],
      );
    if (!matches) throw new StepFailure("checksum_mismatch", false);
  } else if (source.declaredSha256 !== null && source.declaredSha256 !== hashes.sha256) {
    throw new StepFailure("checksum_mismatch", false);
  }
  let info;
  try {
    info = await timed(costs, () =>
      probeMedia(deps.tools, path, { timeoutMs: 60_000, signal: ctx.signal }),
    );
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
  await ctx.lease.write(async (tx, now) => {
    await tx.creatorSource.updateMany({
      where: { id: source.id, workspaceId: job.workspaceId },
      data: {
        status: "VERIFIED",
        verifiedAt: now,
        container,
        byteSize: bytes,
        sha256: hashes.sha256,
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
    await stepDone(
      tx,
      ctx,
      now,
      {
        container,
        durationMs: info.durationMs,
        hasVideo: info.hasVideo,
        hasAudio: info.hasAudio,
        checksum:
          multipart === null ? (source.declaredSha256 === null ? "computed" : "file") : "parts",
      },
      undefined,
      { localProcessingMs: costs.localMs },
    );
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
  /** The requester confirmed that the media is sent to an external provider. */
  externalProcessing: z.literal("confirmed").optional(),
  /** …to THIS provider in THIS region (what the page showed when they confirmed). */
  externalProvider: z.string().max(60).optional(),
  externalRegion: z.string().max(60).optional(),
});

/**
 * Media or text goes to an external provider only with the requester's confirmation for
 * that provider and region. A job confirmed for another provider or region (the
 * configuration changed while it waited) is refused, never sent: a retry or a takeover
 * by another worker cannot widen what the person agreed to.
 */
function assertExternalConsent(
  provider: { readonly external: boolean; readonly id: string; readonly region: string | null },
  options: z.infer<typeof jobOptions>,
): void {
  if (!provider.external) return;
  if (
    options.externalProcessing !== "confirmed" ||
    options.externalProvider !== provider.id ||
    options.externalRegion !== (provider.region ?? "none")
  ) {
    throw new StepFailure("external_consent_missing", false);
  }
}

const pieceCheckpoint = z.object({
  kind: z.literal("transcription"),
  provider: z.string(),
  pieceMs: z.number().int().positive(),
  pieces: z.array(
    z.object({
      index: z.number().int().min(0),
      language: z.string().regex(LANGUAGE_PATTERN),
      billedSeconds: z.number().int().min(0).nullable(),
      segments: z.array(z.object({ startMs: z.number(), endMs: z.number(), text: z.string() })),
    }),
  ),
});

/** Estimated provider cost: audio seconds × the provider's published per-second price. */
function audioCost(seconds: number | null, microUsdPerSecond: number | null): number | null {
  return seconds === null || microUsdPerSecond === null
    ? null
    : Math.round(seconds * microUsdPerSecond);
}

/**
 * TRANSCRIBE: audio → provider → stored transcript (charged only when real). A provider
 * with `chunkMs` gets the audio in pieces; each piece's result is checkpointed, so a
 * retried attempt resumes at the first piece not yet paid for.
 */
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
  // Media goes to an external service only if the requester confirmed it for this job.
  assertExternalConsent(provider, options);
  const hint = options.language ?? null;
  if (hint !== null && !provider.supportsLanguage(hint)) {
    throw new StepFailure("unsupported_language", false);
  }
  const durationMs = source.durationMs;
  const holdId = provider.simulated
    ? null
    : await holdForStep(ctx, "creator_transcription", billedMinutes(durationMs));
  const costs = { localMs: 0 };
  const { path } = await downloadSource(ctx, source);
  const audioPath = join(ctx.workDir, "audio.wav");
  await timed(costs, () =>
    extractAudio(deps.tools, path, audioPath, { timeoutMs: 5 * 60_000, signal: ctx.signal }),
  );
  let language: string;
  let raw: TimedText[];
  let billedSeconds: number | null;
  if (provider.chunkMs === null) {
    const result = await provider.transcribe({
      audioPath,
      durationMs,
      languageHint: hint,
      signal: ctx.signal,
    });
    ({ language, billedSeconds } = result);
    raw = [...result.segments];
  } else {
    const pieceMs = provider.chunkMs;
    const saved = pieceCheckpoint.safeParse(await loadCheckpoint(ctx));
    // A checkpoint of another provider or piece length is not reused.
    const pieces =
      saved.success && saved.data.provider === provider.id && saved.data.pieceMs === pieceMs
        ? [...saved.data.pieces]
        : [];
    const count = Math.ceil(durationMs / pieceMs);
    for (let index = 0; index < count; index += 1) {
      if (pieces.some((piece) => piece.index === index)) continue;
      const startMs = index * pieceMs;
      const pieceDurationMs = Math.min(pieceMs, durationMs - startMs);
      if (pieceDurationMs < 200) break;
      const piecePath = join(ctx.workDir, `piece-${String(index)}.ogg`);
      await timed(costs, () =>
        encodeAudioPiece(
          deps.tools,
          audioPath,
          piecePath,
          { startMs, durationMs: pieceDurationMs },
          { timeoutMs: 2 * 60_000, signal: ctx.signal },
        ),
      );
      // Later pieces keep the language the first one was heard in.
      const languageHint = hint ?? pieces.find((piece) => piece.index === 0)?.language ?? null;
      const result = await provider.transcribe({
        audioPath: piecePath,
        durationMs: pieceDurationMs,
        languageHint,
        signal: ctx.signal,
      });
      pieces.push({
        index,
        language: result.language,
        billedSeconds: result.billedSeconds,
        segments: result.segments.map((segment) => ({
          startMs: segment.startMs + startMs,
          endMs: segment.endMs + startMs,
          text: segment.text,
        })),
      });
      await saveCheckpoint(ctx, {
        kind: "transcription",
        provider: provider.id,
        pieceMs,
        pieces,
      });
    }
    pieces.sort((a, b) => a.index - b.index);
    language = hint ?? pieces[0]?.language ?? "und";
    raw = pieces.flatMap((piece) => piece.segments);
    billedSeconds = pieces.every((piece) => piece.billedSeconds !== null)
      ? pieces.reduce((sum, piece) => sum + (piece.billedSeconds ?? 0), 0)
      : null;
  }
  const segments = validateTimedText(raw, durationMs);
  if (!LANGUAGE_PATTERN.test(language)) throw new StepFailure("provider_invalid_output", false);
  await ctx.lease.write(async (tx, now) => {
    const transcript = await tx.creatorTranscript.create({
      data: {
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        sourceId: source.id,
        jobId: job.id,
        kind: "ORIGINAL",
        language,
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
      { segments: segments.length, language, charged: holdId !== null },
      provider,
      {
        localProcessingMs: costs.localMs,
        providerAudioSeconds: provider.simulated ? null : billedSeconds,
        providerCostMicroUsd: provider.simulated
          ? null
          : audioCost(billedSeconds, provider.costMicroUsdPerAudioSecond),
      },
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

const batchCheckpoint = z.object({
  kind: z.literal("translation"),
  provider: z.string(),
  batchSize: z.number().int().positive(),
  batches: z.array(
    z.object({
      index: z.number().int().min(0),
      inputTokens: z.number().int().min(0).nullable(),
      outputTokens: z.number().int().min(0).nullable(),
      segments: z.array(z.object({ startMs: z.number(), endMs: z.number(), text: z.string() })),
    }),
  ),
});

function sumOrNull(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === values.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/**
 * TRANSLATE: the transcript's cues in another language (same timestamps), in batches of
 * the provider's size; each batch's result is checkpointed (a retry resumes after it).
 */
async function translate(ctx: StepContext): Promise<void> {
  const { deps, job } = ctx;
  const provider = deps.translation;
  if (provider === null) throw new StepFailure("provider_disabled", false);
  const options = jobOptions.parse(job.options ?? {});
  if (options.targetLanguage === undefined || options.transcriptId === undefined) {
    throw new StepFailure("internal_error", false);
  }
  assertExternalConsent(provider, options);
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
  const language = options.targetLanguage;
  const batchSize = Math.max(1, provider.batchSize);
  const saved = batchCheckpoint.safeParse(await loadCheckpoint(ctx));
  const batches =
    saved.success && saved.data.provider === provider.id && saved.data.batchSize === batchSize
      ? [...saved.data.batches]
      : [];
  const count = Math.ceil(segments.length / batchSize);
  for (let index = 0; index < count; index += 1) {
    if (batches.some((batch) => batch.index === index)) continue;
    const slice = segments.slice(index * batchSize, (index + 1) * batchSize);
    const result = await provider.translate({
      segments: slice,
      from: original.language,
      to: language,
      signal: ctx.signal,
    });
    if (result.segments.length !== slice.length) {
      throw new StepFailure("provider_invalid_output", false);
    }
    batches.push({
      index,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      segments: [...result.segments],
    });
    if (count > 1) {
      await saveCheckpoint(ctx, { kind: "translation", provider: provider.id, batchSize, batches });
    }
  }
  batches.sort((a, b) => a.index - b.index);
  const translated = validateTimedText(
    batches.flatMap((batch) => batch.segments),
    durationMs,
  );
  if (translated.length !== segments.length)
    throw new StepFailure("provider_invalid_output", false);
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
      provider.simulated
        ? {}
        : {
            providerInputTokens: sumOrNull(batches.map((batch) => batch.inputTokens)),
            providerOutputTokens: sumOrNull(batches.map((batch) => batch.outputTokens)),
          },
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
  const costs = { localMs: 0 };
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
  const frame = { width: source.width, height: source.height, hasAudio: source.hasAudio === true };
  await timed(costs, () =>
    renderClip(deps.tools, {
      input: path,
      output,
      workDir: ctx.workDir,
      startMs: exportRow.startMs,
      endMs: exportRow.endMs,
      source: frame,
      aspect,
      cropX: exportRow.cropX,
      subtitles: cues,
      maxBytes: EXPORT_MAX_BYTES,
      timeoutMs: 8 * 60_000,
      signal: ctx.signal,
    }),
  );
  const info = await timed(costs, () =>
    verifyRender(
      deps.tools,
      output,
      { durationMs, aspect },
      { timeoutMs: 60_000, signal: ctx.signal },
    ),
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
  // Still this worker's job (not cancelled, not taken over, its project not deleted)
  // right before the file is written: a lost job stores nothing.
  if (!(await ctx.lease.renew())) throw new LeaseLostError();
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
        { localProcessingMs: costs.localMs },
      );
      await recordEvent(tx, job.workspaceId, job.projectId, "export_ready", null, {
        exportId: exportRow.id,
        aspectRatio: exportRow.aspectRatio,
      });
    });
  } catch (error) {
    // Not recorded (lease lost, a storage location change, the database): not kept. If
    // storage refuses the delete now, the object is queued so the sweep removes it later.
    await target.storage.delete(key, { signal: AbortSignal.timeout(15_000) }).catch(async () => {
      deps.logger?.error({ jobId: job.id }, "Could not remove an unrecorded export; queued");
      await queueStorageDeletions(
        deps.db,
        [
          {
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            reason: "render_discarded",
            storageProvider: target.provider,
            storageKey: key,
          },
        ],
        new Date(),
      ).catch(() => {
        deps.logger?.error({ jobId: job.id }, "Could not queue an unrecorded export");
      });
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
