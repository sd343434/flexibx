import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  VIDEO_TIERS,
  isVideoProviderError,
  type VideoJobStatus,
  type VideoProvider,
  type VideoSpec,
  type VideoTier,
} from "@/server/ai/providers/video/gateway";
import type { PrismaClient } from "@/generated/prisma/client";
import type { VideoAttemptState, VideoJobState } from "@/generated/prisma/enums";

import { recordAudit } from "../../audit/audit-log";
import type { GuardedPrismaClient } from "../../db/prisma";
import type { Db } from "../../db/types";
import { AppError } from "../../errors/app-error";
import type { Logger } from "../../logger";
import {
  assertUploadAllowed,
  buildWorkspaceKey,
  STORAGE_CATEGORIES,
  type StorageWriteTarget,
} from "../../storage/storage";
import { isUuid, type TenantContext } from "../../tenancy/context";
import { assertCan, can } from "../../tenancy/permissions";
import { isRole } from "../../tenancy/roles";
import { parseInput } from "../../validation/parse";
import { databaseNow, recordGeneratedVideo } from "../video-service";
import {
  attemptCharge,
  DEFAULT_VIDEO_LIMITS,
  FAKE_VIDEO_RATE_CARD,
  ledgerPeriod,
  reservationMicros,
  VIDEO_LEDGER_CATEGORY,
  type VideoLimits,
  type VideoRateCard,
} from "./budget";
import { expectedDimensions, validateClip } from "./mp4";
import {
  ACTIVE_JOB_STATES,
  assertAttemptTransition,
  assertJobTransition,
  OPEN_ATTEMPT_STATES,
} from "./states";

// Generative video jobs (Phase 4, docs/AI_MARKETING_EMPLOYEE_ARCHITECTURE.md §4.2):
//
//   request  → validate, policy check, reserve the worst-case cost under the workspace
//              lock (one transaction; the job is stored as RESERVED)
//   run      → per attempt: write INTENDED before calling the provider, store the
//              provider job id as soon as submit returns, poll, capture the charge,
//              download, validate the MP4, store it, record the video (retention 168 h)
//              and release the unused reservation — or fail/retry by the §4.2.4 table
//   recover  → resume jobs whose runner stopped (crash, restart): never resubmits an
//              accepted or possibly-accepted submission; reconciles unknown outcomes
//   review   → a person accepts or rejects the stored clip
//
// The runner is in-process and bounded (a fixed number of status polls per call); a
// queue/worker can call the same functions later. No real provider exists yet.

const MAX_PROMPT = 2000;
const MAX_TITLE = 200;
/** How long a runner's claim on a job lasts (longer than one bounded run). */
const LEASE_MS = 5 * 60 * 1000;
/** Download tries per run before the attempt waits for the next run (output kept). */
const DOWNLOAD_TRIES = 2;

export const videoRequestSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  prompt: z.string().trim().min(1).max(MAX_PROMPT),
  durationSeconds: z.number().int().min(1).max(60),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
  resolution: z.enum(VIDEO_RESOLUTIONS),
  audio: z.boolean(),
  tier: z.enum(VIDEO_TIERS),
});

export type VideoRequestInput = z.input<typeof videoRequestSchema>;

export interface VideoGenerationDeps {
  readonly db: GuardedPrismaClient;
  /** Where the clip is written (the storage router's current write target). */
  readonly writeTarget: () => Promise<StorageWriteTarget>;
  readonly provider: VideoProvider;
  readonly rateCard?: VideoRateCard;
  readonly limits?: Partial<VideoLimits>;
  readonly logger?: Logger;
  /** Waits between status polls (tests pass a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  /** Status polls per run; afterwards the job stays IN_PROGRESS for the next run. */
  readonly maxPolls?: number;
}

const videoError = (
  code: "SERVICE_UNAVAILABLE" | "VALIDATION_FAILED" | "RATE_LIMITED" | "FORBIDDEN",
  field:
    "video_not_configured" | "video_unsupported" | "video_daily_budget" | "video_approval_required",
  path = "video",
) => new AppError(code, { message: field, fields: [{ path, code: field }] });

export function videoNotConfigured(): AppError {
  return videoError("SERVICE_UNAVAILABLE", "video_not_configured");
}

const notFound = () => new AppError("NOT_FOUND", { metadata: { resource: "video_job" } });

/** hash(jobId, attemptNo): the attempt's client reference, never reused. */
export function attemptIdempotencyKey(jobId: string, attemptNo: number): string {
  return createHash("sha256")
    .update(`${jobId}:${String(attemptNo)}`)
    .digest("hex")
    .slice(0, 48);
}

function limitsOf(deps: VideoGenerationDeps): VideoLimits {
  return { ...DEFAULT_VIDEO_LIMITS, ...deps.limits };
}

function rateCardOf(deps: VideoGenerationDeps, version: string): VideoRateCard {
  const card = deps.rateCard ?? FAKE_VIDEO_RATE_CARD;
  // A job is always charged with the card it was reserved under.
  if (card.version !== version) throw new Error(`Rate card ${version} is not available`);
  return card;
}

/** Committed video spend of the workspace for `period` (reserved minus released). */
async function committedMicros(db: Db, workspaceId: string, period: Date): Promise<bigint> {
  const rows = await db.usageLedgerEntry.groupBy({
    by: ["kind"],
    where: { workspaceId, category: VIDEO_LEDGER_CATEGORY, period },
    _sum: { amountMicros: true },
  });
  const sum = (kind: "RESERVE" | "RELEASE") =>
    rows.find((row) => row.kind === kind)?._sum.amountMicros ?? 0n;
  return sum("RESERVE") - sum("RELEASE");
}

/**
 * Validates and records a video request, reserving its worst-case cost. Refused before
 * anything is stored when the request is invalid or unsupported, larger than one request
 * may spend without an approval flow (none exists yet), or over the workspace's daily
 * video budget. Concurrent requests of one workspace are serialized by a row lock, so
 * reservations can never over-commit the budget.
 */
export async function requestVideoGeneration(
  deps: VideoGenerationDeps,
  ctx: TenantContext,
  input: unknown,
): Promise<{ readonly jobId: string; readonly reservedMicros: bigint }> {
  assertCan(ctx, "content.create");
  const data = parseInput(videoRequestSchema, input);
  const { provider } = deps;
  const spec: VideoSpec = data;
  const unsupported = provider.unsupported(spec);
  if (unsupported !== null) {
    // Reported on the request field it concerns, so a form shows it next to that field.
    const path = unsupported === "duration" ? "durationSeconds" : "video";
    throw videoError("VALIDATION_FAILED", "video_unsupported", path);
  }
  const limits = limitsOf(deps);
  const card = deps.rateCard ?? FAKE_VIDEO_RATE_CARD;
  const reserved = reservationMicros(card, data.tier, spec, limits.maxAttempts);
  if (reserved > limits.perRequestMaxMicros) {
    throw videoError("FORBIDDEN", "video_approval_required");
  }

  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId}::uuid FOR UPDATE`;
    const now = await databaseNow(tx);
    const period = ledgerPeriod(now);
    const committed = await committedMicros(tx, ctx.workspaceId, period);
    if (committed + reserved > limits.dailyBudgetMicros) {
      throw videoError("RATE_LIMITED", "video_daily_budget");
    }
    const job = await tx.videoGenerationJob.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        title: data.title,
        prompt: data.prompt,
        durationSeconds: data.durationSeconds,
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        audio: data.audio,
        tier: data.tier,
        maxAttempts: limits.maxAttempts,
        provider: provider.name,
        model: provider.modelFor(data.tier),
        rateCardVersion: card.version,
        reservedMicros: reserved,
        deadlineAt: new Date(now.getTime() + limits.maxWallTimeMs),
      },
      select: { id: true },
    });
    await tx.usageLedgerEntry.create({
      data: {
        workspaceId: ctx.workspaceId,
        jobId: job.id,
        category: VIDEO_LEDGER_CATEGORY,
        period,
        kind: "RESERVE",
        amountMicros: reserved,
        rateCardVersion: card.version,
      },
    });
    await recordAudit(tx, ctx, {
      action: "video.job_requested",
      entityType: "video_job",
      entityId: job.id,
      metadata: {
        tier: data.tier,
        durationSeconds: data.durationSeconds,
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        audio: data.audio,
        provider: provider.name,
        reservedMicros: reserved.toString(),
        rateCardVersion: card.version,
      },
    });
    return { jobId: job.id, reservedMicros: reserved };
  });
}

// ── Runner ──

const JOB_SELECT = {
  id: true,
  workspaceId: true,
  userId: true,
  title: true,
  prompt: true,
  durationSeconds: true,
  aspectRatio: true,
  resolution: true,
  audio: true,
  tier: true,
  state: true,
  maxAttempts: true,
  attemptCount: true,
  provider: true,
  model: true,
  rateCardVersion: true,
  reservedMicros: true,
  capturedMicros: true,
  releasedMicros: true,
  deadlineAt: true,
} as const;

interface JobRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly audio: boolean;
  readonly tier: string;
  readonly state: VideoJobState;
  readonly maxAttempts: number;
  readonly attemptCount: number;
  readonly provider: string;
  readonly model: string;
  readonly rateCardVersion: string;
  readonly reservedMicros: bigint;
  readonly capturedMicros: bigint;
  readonly releasedMicros: bigint;
  readonly deadlineAt: Date;
}

const ATTEMPT_SELECT = {
  id: true,
  attemptNo: true,
  idempotencyKey: true,
  state: true,
  providerJobId: true,
} as const;

interface AttemptRow {
  readonly id: string;
  readonly attemptNo: number;
  readonly idempotencyKey: string;
  readonly state: VideoAttemptState;
  readonly providerJobId: string | null;
}

/** What a run ended with. `waiting`: the job is still in progress (run again later). */
export type VideoRunOutcome =
  | { readonly status: "busy" | "not_active" }
  | { readonly status: "waiting"; readonly reason: string }
  | { readonly status: "finished"; readonly state: VideoJobState };

const spec = (job: JobRow): VideoSpec => ({
  durationSeconds: job.durationSeconds,
  aspectRatio: job.aspectRatio as VideoSpec["aspectRatio"],
  resolution: job.resolution as VideoSpec["resolution"],
  audio: job.audio,
});

const systemScope = (job: JobRow) => ({ workspaceId: job.workspaceId, userId: null });

class Run {
  private readonly limits: VideoLimits;
  private readonly card: VideoRateCard;

  constructor(
    private readonly deps: VideoGenerationDeps,
    private job: JobRow,
  ) {
    this.limits = limitsOf(deps);
    this.card = rateCardOf(deps, job.rateCardVersion);
  }

  private get db() {
    return this.deps.db;
  }

  private where() {
    return { id: this.job.id, workspaceId: this.job.workspaceId };
  }

  private async reload(db: Db = this.db): Promise<void> {
    const job = await db.videoGenerationJob.findFirst({
      where: this.where(),
      select: JOB_SELECT,
    });
    if (job === null) throw notFound();
    this.job = job;
  }

  /** The requester's current access (re-read every time it matters). */
  private async requester(): Promise<TenantContext | null> {
    const { userId, workspaceId } = this.job;
    if (userId === null) return null;
    const workspace = await this.db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (workspace === null) return null;
    const membership = await this.db.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
    if (membership === null || !isRole(membership.role)) return null;
    if (!can(membership.role, "content.create")) return null;
    return { userId, workspaceId, role: membership.role };
  }

  private async setAttempt(
    db: Db,
    attempt: AttemptRow,
    to: VideoAttemptState,
    data: Record<string, unknown> = {},
  ): Promise<AttemptRow> {
    assertAttemptTransition(attempt.state, to);
    return db.videoGenerationAttempt.update({
      where: { id: attempt.id, workspaceId: this.job.workspaceId },
      data: { ...data, state: to },
      select: ATTEMPT_SELECT,
    });
  }

  /** Records what one attempt was charged (CAPTURE), bounded by what is still reserved. */
  private async capture(db: Db, attempt: AttemptRow, billedSeconds: number | null): Promise<void> {
    await this.reload(db);
    const remaining = this.job.reservedMicros - this.job.capturedMicros - this.job.releasedMicros;
    const charge = attemptCharge(
      this.card,
      this.job.tier as VideoTier,
      this.job.durationSeconds,
      billedSeconds,
      remaining,
    );
    await db.videoGenerationAttempt.update({
      where: { id: attempt.id, workspaceId: this.job.workspaceId },
      data: { billedSeconds, costMicros: charge.micros, costEstimated: charge.estimated },
    });
    if (charge.micros === 0n) return;
    await db.usageLedgerEntry.create({
      data: {
        workspaceId: this.job.workspaceId,
        jobId: this.job.id,
        category: VIDEO_LEDGER_CATEGORY,
        period: await this.period(db),
        kind: "CAPTURE",
        amountMicros: charge.micros,
        estimated: charge.estimated,
        rateCardVersion: this.card.version,
      },
    });
    await db.videoGenerationJob.update({
      where: this.where(),
      data: { capturedMicros: { increment: charge.micros } },
    });
  }

  /** The job's reservation day (all its ledger entries count against that day). */
  private async period(db: Db): Promise<Date> {
    const reserve = await db.usageLedgerEntry.findFirst({
      where: { workspaceId: this.job.workspaceId, jobId: this.job.id, kind: "RESERVE" },
      select: { period: true },
    });
    if (reserve === null) throw new Error("Video job has no reservation");
    return reserve.period;
  }

  /**
   * Ends the job: releases whatever is reserved but not captured (never while an
   * outcome is unknown — NEEDS_RECONCILIATION keeps the reservation) and audits it.
   */
  private async finish(
    db: Db,
    state: VideoJobState,
    failureCode: string | null,
    extra: { readonly generatedVideoId?: string } = {},
  ): Promise<VideoRunOutcome> {
    await this.reload(db);
    assertJobTransition(this.job.state, state);
    const hold = state === "NEEDS_RECONCILIATION";
    const release = hold
      ? 0n
      : this.job.reservedMicros - this.job.capturedMicros - this.job.releasedMicros;
    if (release > 0n) {
      await db.usageLedgerEntry.create({
        data: {
          workspaceId: this.job.workspaceId,
          jobId: this.job.id,
          category: VIDEO_LEDGER_CATEGORY,
          period: await this.period(db),
          kind: "RELEASE",
          amountMicros: release,
          rateCardVersion: this.card.version,
        },
      });
    }
    await db.videoGenerationJob.update({
      where: this.where(),
      data: {
        state,
        failureCode,
        releasedMicros: { increment: release },
        finishedAt: hold ? null : new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        ...(extra.generatedVideoId === undefined
          ? {}
          : { generatedVideoId: extra.generatedVideoId }),
      },
    });
    await recordAudit(db, systemScope(this.job), {
      action: "video.job_finished",
      entityType: "video_job",
      entityId: this.job.id,
      metadata: {
        state,
        failureCode,
        attempts: this.job.attemptCount,
        capturedMicros: this.job.capturedMicros.toString(),
        releasedMicros: release.toString(),
      },
    });
    return { status: "finished", state };
  }

  private async attemptFailed(attempt: AttemptRow, to: VideoAttemptState, code: string) {
    await recordAudit(this.db, systemScope(this.job), {
      action: "video.attempt_failed",
      entityType: "video_job",
      entityId: this.job.id,
      metadata: { attemptNo: attempt.attemptNo, state: to, failureCode: code },
    });
  }

  private async pastDeadline(): Promise<boolean> {
    return (await databaseNow(this.db)) >= this.job.deadlineAt;
  }

  async execute(): Promise<VideoRunOutcome> {
    if (this.job.state === "RESERVED") {
      assertJobTransition("RESERVED", "IN_PROGRESS");
      await this.db.videoGenerationJob.update({
        where: this.where(),
        data: { state: "IN_PROGRESS" },
      });
      await this.reload();
    }
    for (;;) {
      const attempt = await this.db.videoGenerationAttempt.findFirst({
        where: { workspaceId: this.job.workspaceId, jobId: this.job.id },
        orderBy: { attemptNo: "desc" },
        select: ATTEMPT_SELECT,
      });
      const outcome =
        attempt === null || !OPEN.has(attempt.state)
          ? await this.nextAttempt(attempt)
          : await this.continueAttempt(attempt);
      if (outcome !== null) return outcome;
    }
  }

  /** Starts the next attempt, or ends the job when the last one may not be retried. */
  private async nextAttempt(last: AttemptRow | null): Promise<VideoRunOutcome | null> {
    if (last?.state === "FAILED_PERMANENT") return this.finish(this.db, "FAILED", "rejected");
    if (last?.state === "REFUSED_BY_PROVIDER") return this.finish(this.db, "FAILED", "refused");
    if (last?.state === "TIMED_OUT") return this.finish(this.db, "LIMIT_REACHED", "max_wall_time");
    if (last?.state === "VALIDATED") return { status: "not_active" };
    if (this.job.attemptCount >= this.job.maxAttempts) {
      return this.finish(this.db, "LIMIT_REACHED", "max_attempts");
    }
    if (await this.pastDeadline()) return this.finish(this.db, "LIMIT_REACHED", "max_wall_time");
    if ((await this.requester()) === null) {
      return this.finish(this.db, "CANCELLED", null);
    }
    const attemptNo = this.job.attemptCount + 1;
    // Written BEFORE the provider is called: a crash after this point is recovered by
    // reconciliation, never by a blind resubmission.
    const attempt = await this.db.$transaction(async (tx) => {
      await tx.videoGenerationJob.update({
        where: this.where(),
        data: { attemptCount: attemptNo },
      });
      return tx.videoGenerationAttempt.create({
        data: {
          workspaceId: this.job.workspaceId,
          jobId: this.job.id,
          attemptNo,
          idempotencyKey: attemptIdempotencyKey(this.job.id, attemptNo),
          provider: this.job.provider,
          model: this.job.model,
        },
        select: ATTEMPT_SELECT,
      });
    });
    await this.reload();
    return this.submit(attempt);
  }

  private async submit(attempt: AttemptRow): Promise<VideoRunOutcome | null> {
    try {
      const { providerJobId } = await this.deps.provider.submit({
        ...spec(this.job),
        prompt: this.job.prompt,
        model: this.job.model,
        idempotencyKey: attempt.idempotencyKey,
      });
      await this.setAttempt(this.db, attempt, "SUBMITTED", {
        providerJobId,
        submittedAt: new Date(),
      });
      return null;
    } catch (error) {
      if (isVideoProviderError(error) && error.accepted === "no") {
        const permanent = error.kind === "rejected" || error.kind === "refused";
        const to = permanent ? "FAILED_PERMANENT" : "FAILED_RETRYABLE";
        await this.setAttempt(this.db, attempt, to, {
          failureCode: error.kind,
          finishedAt: new Date(),
        });
        await this.attemptFailed(attempt, to, error.kind);
        return null;
      }
      // Timeout, connection loss or anything unexpected: it may have been accepted.
      this.deps.logger?.warn({ jobId: this.job.id }, "Video submission outcome unknown");
      await this.setAttempt(this.db, attempt, "OUTCOME_UNKNOWN", {
        failureCode: isVideoProviderError(error) ? error.kind : "unknown",
      });
      return null;
    }
  }

  private async continueAttempt(attempt: AttemptRow): Promise<VideoRunOutcome | null> {
    switch (attempt.state) {
      case "INTENDED":
        // A runner stopped between writing the attempt and storing the submit result:
        // the submission may or may not have reached the provider.
        await this.setAttempt(this.db, attempt, "OUTCOME_UNKNOWN", { failureCode: "unknown" });
        return null;
      case "OUTCOME_UNKNOWN":
        return this.reconcile(attempt);
      case "SUBMITTED":
        return this.poll(attempt);
      case "OUTPUT_READY":
        return this.store(attempt);
      case "VALIDATED":
      case "FAILED_RETRYABLE":
      case "FAILED_PERMANENT":
      case "REFUSED_BY_PROVIDER":
      case "TIMED_OUT":
      case "CANCELLED":
        return null;
    }
  }

  /**
   * An unknown submission outcome: ask the provider whether it holds a job with this
   * client reference. Found → follow that job. Not found → it was never accepted (the
   * attempt failed, nothing billed). If the provider cannot answer, the job waits for an
   * operator with its reservation held — it is never resubmitted blindly.
   */
  private async reconcile(attempt: AttemptRow): Promise<VideoRunOutcome | null> {
    let providerJobId: string | null;
    try {
      providerJobId = await this.deps.provider.findByClientRef(attempt.idempotencyKey);
    } catch {
      return this.finish(this.db, "NEEDS_RECONCILIATION", "outcome_unknown");
    }
    if (providerJobId === null) {
      await this.setAttempt(this.db, attempt, "FAILED_RETRYABLE", {
        failureCode: "not_accepted",
        finishedAt: new Date(),
      });
      await this.attemptFailed(attempt, "FAILED_RETRYABLE", "not_accepted");
      return null;
    }
    await this.setAttempt(this.db, attempt, "SUBMITTED", {
      providerJobId,
      failureCode: null,
      submittedAt: new Date(),
    });
    return null;
  }

  private async poll(attempt: AttemptRow): Promise<VideoRunOutcome | null> {
    const { provider } = this.deps;
    const providerJobId = attempt.providerJobId ?? "";
    const maxPolls = this.deps.maxPolls ?? 30;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let polls = 0; polls < maxPolls; polls += 1) {
      if (await this.pastDeadline()) {
        await provider.cancel(providerJobId).catch(() => undefined);
        await this.db.$transaction(async (tx) => {
          // Billed at the estimate: the provider may still finish and charge.
          await this.capture(tx, attempt, null);
          await this.setAttempt(tx, attempt, "TIMED_OUT", {
            failureCode: "timeout",
            finishedAt: new Date(),
          });
        });
        await this.attemptFailed(attempt, "TIMED_OUT", "timeout");
        return null;
      }
      let polled: VideoJobStatus;
      try {
        polled = await provider.status(providerJobId);
      } catch {
        return { status: "waiting", reason: "status_unavailable" };
      }
      const status = polled;
      if (status.state === "QUEUED" || status.state === "RUNNING") {
        await sleep(this.deps.pollIntervalMs ?? 10_000);
        continue;
      }
      if (status.state === "SUCCEEDED") {
        const ready = await this.db.$transaction(async (tx) => {
          await this.capture(tx, attempt, status.billedSeconds);
          return this.setAttempt(tx, attempt, "OUTPUT_READY");
        });
        return this.store(ready);
      }
      const to: VideoAttemptState =
        status.state === "CANCELLED"
          ? "FAILED_RETRYABLE"
          : status.failure === "refused"
            ? "REFUSED_BY_PROVIDER"
            : status.failure === "rejected"
              ? "FAILED_PERMANENT"
              : "FAILED_RETRYABLE";
      const code = status.state === "CANCELLED" ? "provider_cancelled" : status.failure;
      await this.db.$transaction(async (tx) => {
        await this.capture(tx, attempt, status.billedSeconds);
        await this.setAttempt(tx, attempt, to, { failureCode: code, finishedAt: new Date() });
      });
      await this.attemptFailed(attempt, to, code);
      return null;
    }
    return { status: "waiting", reason: "provider_running" };
  }

  /**
   * The provider has the clip: download (only the download is retried — never a new
   * generation because a download failed), validate, store, then record the video and
   * close the job in one transaction. If storing or recording fails the object is
   * removed again and the attempt stays OUTPUT_READY for the next run.
   */
  private async store(attempt: AttemptRow): Promise<VideoRunOutcome | null> {
    const providerJobId = attempt.providerJobId ?? "";
    let bytes: Uint8Array | null = null;
    for (let tries = 0; tries < DOWNLOAD_TRIES && bytes === null; tries += 1) {
      try {
        bytes = await this.deps.provider.download(providerJobId);
      } catch (error) {
        this.deps.logger?.warn({ err: error, jobId: this.job.id }, "Video download failed");
      }
    }
    if (bytes === null) return { status: "waiting", reason: "download_failed" };

    const tooBig = bytes.byteLength > STORAGE_CATEGORIES["generated-videos"].maxBytes;
    const problem = tooBig ? "too_big" : validateClip(bytes, spec(this.job));
    if (problem !== null) {
      await this.setAttempt(this.db, attempt, "FAILED_RETRYABLE", {
        failureCode: problem,
        outputBytes: bytes.byteLength,
        finishedAt: new Date(),
      });
      await this.attemptFailed(attempt, "FAILED_RETRYABLE", problem);
      return null;
    }

    const ctx = await this.requester();
    if (ctx === null) {
      await this.setAttempt(this.db, attempt, "FAILED_RETRYABLE", {
        failureCode: "requester_no_access",
        finishedAt: new Date(),
      });
      return this.finish(this.db, "CANCELLED", null);
    }

    let target: StorageWriteTarget;
    try {
      target = await this.deps.writeTarget();
    } catch (error) {
      this.deps.logger?.error({ err: error, jobId: this.job.id }, "No storage for a video");
      return { status: "waiting", reason: "storage_unavailable" };
    }
    assertUploadAllowed("generated-videos", "video/mp4", bytes.byteLength);
    const storageKey = buildWorkspaceKey(this.job.workspaceId, "generated-videos", "video/mp4");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      await target.storage.put(storageKey, bytes, { contentType: "video/mp4" });
    } catch (error) {
      this.deps.logger?.error({ err: error, jobId: this.job.id }, "Could not store a video");
      return { status: "waiting", reason: "storage_unavailable" };
    }
    const byteSize = bytes.byteLength;
    try {
      return await this.db.$transaction(async (tx) => {
        await target.confirm(tx);
        await this.reload(tx);
        const video = await recordGeneratedVideo(tx, ctx, {
          title: this.job.title,
          provider: this.job.provider,
          model: this.job.model,
          providerJobId,
          durationSeconds: this.job.durationSeconds,
          ...expectedDimensions(spec(this.job)),
          costMicros: this.job.capturedMicros,
          storageProvider: target.provider,
          files: [{ kind: "VIDEO", storageKey, contentType: "video/mp4", byteSize }],
        });
        await this.setAttempt(tx, attempt, "VALIDATED", {
          outputSha256: sha256,
          outputBytes: byteSize,
          finishedAt: new Date(),
        });
        return this.finish(tx, "READY_FOR_REVIEW", null, { generatedVideoId: video.id });
      });
    } catch (error) {
      await target.storage.delete(storageKey).catch((cleanupError: unknown) => {
        this.deps.logger?.error({ err: cleanupError }, "Could not remove an orphaned video");
      });
      this.deps.logger?.error({ err: error, jobId: this.job.id }, "Could not record a video");
      await this.reload();
      return { status: "waiting", reason: "record_failed" };
    }
  }

  async claim(): Promise<string | null> {
    const token = randomUUID();
    const now = await databaseNow(this.db);
    const claimed = await this.db.videoGenerationJob.updateMany({
      where: {
        ...this.where(),
        state: { in: [...ACTIVE] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
    });
    return claimed.count === 1 ? token : null;
  }

  async release(token: string): Promise<void> {
    await this.db.videoGenerationJob.updateMany({
      where: { ...this.where(), leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

const OPEN: ReadonlySet<VideoAttemptState> = new Set(OPEN_ATTEMPT_STATES);
const ACTIVE: readonly VideoJobState[] = ACTIVE_JOB_STATES;

/**
 * Drives one job as far as it can go in one bounded run. Safe to call repeatedly and
 * concurrently: a lease lets only one runner work on a job at a time, and every step
 * resumes from the stored attempt state.
 */
export async function runVideoJob(
  deps: VideoGenerationDeps,
  workspaceId: string,
  jobId: string,
): Promise<VideoRunOutcome> {
  if (!isUuid(jobId) || !isUuid(workspaceId)) throw notFound();
  const job = await deps.db.videoGenerationJob.findFirst({
    where: { id: jobId, workspaceId },
    select: JOB_SELECT,
  });
  if (job === null) throw notFound();
  if (!ACTIVE.includes(job.state)) return { status: "not_active" };
  const run = new Run(deps, job);
  const token = await run.claim();
  if (token === null) return { status: "busy" };
  try {
    return await run.execute();
  } finally {
    await run.release(token);
  }
}

/**
 * Resumes jobs whose runner stopped (crash, restart, a bounded run that ended while the
 * provider was still working). Unguarded `system` only finds them across workspaces;
 * each job then runs through the guarded client of its own workspace.
 */
export async function recoverVideoJobs(
  deps: VideoGenerationDeps & { readonly system: PrismaClient },
  options: { readonly limit?: number } = {},
): Promise<{ readonly resumed: number; readonly outcomes: readonly VideoRunOutcome[] }> {
  const now = await deps.system.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  const at = now[0]?.now ?? new Date();
  const jobs = await deps.system.videoGenerationJob.findMany({
    where: {
      state: { in: [...ACTIVE] },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }],
    },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(options.limit ?? 20, 1), 100),
    select: { id: true, workspaceId: true },
  });
  const outcomes: VideoRunOutcome[] = [];
  for (const job of jobs) {
    try {
      outcomes.push(await runVideoJob(deps, job.workspaceId, job.id));
    } catch (error) {
      deps.logger?.error({ err: error, jobId: job.id }, "Video job recovery failed");
    }
  }
  return { resumed: jobs.length, outcomes };
}

/** A person accepts or rejects a clip waiting for review. */
export async function reviewVideoJob(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  jobId: string,
  decision: "accept" | "reject",
): Promise<void> {
  assertCan(ctx, "content.create");
  if (!isUuid(jobId)) throw notFound();
  const to = decision === "accept" ? "ACCEPTED" : "REJECTED";
  await db.$transaction(async (tx) => {
    const updated = await tx.videoGenerationJob.updateMany({
      where: { id: jobId, workspaceId: ctx.workspaceId, state: "READY_FOR_REVIEW" },
      data: { state: to },
    });
    if (updated.count !== 1) {
      const exists = await tx.videoGenerationJob.count({
        where: { id: jobId, workspaceId: ctx.workspaceId },
      });
      throw exists === 0
        ? notFound()
        : new AppError("CONFLICT", { metadata: { resource: "video_job" } });
    }
    await recordAudit(tx, ctx, {
      action: "video.job_reviewed",
      entityType: "video_job",
      entityId: jobId,
      metadata: { decision: to },
    });
  });
}

/**
 * "Generate again": a NEW job with the same title, prompt and settings as `jobId` — its
 * own validation, reservation, attempts and audit (the old reservation is never reused).
 * Not while the original is still running or waiting for an operator.
 */
export async function regenerateVideoJob(
  deps: VideoGenerationDeps,
  ctx: TenantContext,
  jobId: string,
): Promise<{ readonly jobId: string; readonly reservedMicros: bigint }> {
  assertCan(ctx, "content.create");
  if (!isUuid(jobId)) throw notFound();
  const source = await deps.db.videoGenerationJob.findFirst({
    where: { id: jobId, workspaceId: ctx.workspaceId },
    select: {
      state: true,
      title: true,
      prompt: true,
      durationSeconds: true,
      aspectRatio: true,
      resolution: true,
      audio: true,
      tier: true,
    },
  });
  if (source === null) throw notFound();
  if (ACTIVE.includes(source.state) || source.state === "NEEDS_RECONCILIATION") {
    throw new AppError("CONFLICT", { metadata: { resource: "video_job", state: source.state } });
  }
  const { state: _state, ...request } = source;
  return requestVideoGeneration(deps, ctx, request);
}

/** One job with its attempts and money (for status views and tests). */
export async function getVideoJob(db: Db, ctx: TenantContext, jobId: string) {
  assertCan(ctx, "content.view");
  if (!isUuid(jobId)) throw notFound();
  const job = await db.videoGenerationJob.findFirst({
    where: { id: jobId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      provider: true,
      prompt: true,
      title: true,
      state: true,
      failureCode: true,
      tier: true,
      durationSeconds: true,
      aspectRatio: true,
      resolution: true,
      audio: true,
      attemptCount: true,
      maxAttempts: true,
      reservedMicros: true,
      capturedMicros: true,
      releasedMicros: true,
      generatedVideoId: true,
      createdAt: true,
      finishedAt: true,
      attempts: {
        where: { workspaceId: ctx.workspaceId },
        orderBy: { attemptNo: "asc" },
        select: {
          attemptNo: true,
          state: true,
          failureCode: true,
          billedSeconds: true,
          costMicros: true,
          costEstimated: true,
        },
      },
    },
  });
  if (job === null) throw notFound();
  return job;
}

/** At most this many jobs are listed on the generation page (newest first). */
export const MAX_VIDEO_JOBS_LISTED = 20;

/** The workspace's most recent video jobs (no prompts, no money). */
export async function listVideoJobs(db: Db, ctx: TenantContext) {
  assertCan(ctx, "content.view");
  return db.videoGenerationJob.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_VIDEO_JOBS_LISTED,
    select: {
      id: true,
      provider: true,
      title: true,
      state: true,
      failureCode: true,
      tier: true,
      durationSeconds: true,
      aspectRatio: true,
      resolution: true,
      createdAt: true,
    },
  });
}
