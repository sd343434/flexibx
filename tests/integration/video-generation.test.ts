import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { FakeVideoProvider, type FakeVideoScenario } from "@/server/ai/providers/video/fake";
import { AppError } from "@/server/errors/app-error";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import { StorageTimeoutError, type StorageWriteTarget } from "@/server/storage/storage";
import type { TenantContext } from "@/server/tenancy/context";
import { DEFAULT_VIDEO_LIMITS, type VideoLimits } from "@/server/videos/generation/budget";
import { validateClip } from "@/server/videos/generation/mp4";
import {
  attemptIdempotencyKey,
  getVideoJob,
  recoverVideoJobs,
  requestVideoGeneration,
  reviewVideoJob,
  runVideoJob,
  type VideoGenerationDeps,
  type VideoRequestInput,
} from "@/server/videos/generation/video-generation-service";
import { readGeneratedVideoFile } from "@/server/videos/video-service";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

// Generative video core end to end on the real database with the deterministic fake
// provider and an in-memory store: request → reservation → attempts → validation →
// storage → recorded video (168 h retention) → review, plus every failure path of
// docs/AI_MARKETING_EMPLOYEE_ARCHITECTURE.md §4.2.4 that the fake can reproduce.

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

const REQUEST: VideoRequestInput = {
  title: "Spring launch",
  prompt: "A slow pan over a coffee cup on a sunny table",
  durationSeconds: 8,
  aspectRatio: "16:9",
  resolution: "720p",
  audio: false,
  tier: "DRAFT",
};
/** DRAFT at the fake card: 8 s × 0.05 $ = 0.40 $ per attempt; two attempts reserved. */
const PER_ATTEMPT = 400_000n;
const RESERVED = 800_000n;

interface Harness {
  readonly deps: VideoGenerationDeps;
  readonly provider: FakeVideoProvider;
  readonly storage: MemoryStorageService;
}

function harness(
  options: {
    readonly scenarios?: readonly FakeVideoScenario[];
    readonly pollsBeforeDone?: number;
    readonly limits?: Partial<VideoLimits>;
    readonly maxPolls?: number;
    readonly writeTarget?: () => Promise<StorageWriteTarget>;
    readonly sleepMs?: number;
  } = {},
): Harness {
  const provider = new FakeVideoProvider({
    scenarios: options.scenarios ?? [],
    pollsBeforeDone: options.pollsBeforeDone ?? 1,
  });
  const storage = new MemoryStorageService();
  const target: StorageWriteTarget = {
    provider: "LEGACY_S3",
    storage,
    confirm: () => Promise.resolve(),
  };
  const sleepMs = options.sleepMs ?? 0;
  return {
    provider,
    storage,
    deps: {
      db,
      provider,
      writeTarget: options.writeTarget ?? (() => Promise.resolve(target)),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      maxPolls: options.maxPolls ?? 10,
      sleep: () => new Promise((resolve) => setTimeout(resolve, sleepMs)),
    },
  };
}

async function ledger(jobId: string) {
  const rows = await system.usageLedgerEntry.findMany({
    where: { jobId },
    orderBy: { createdAt: "asc" },
    select: { kind: true, amountMicros: true, estimated: true },
  });
  return rows.map((row) => `${row.kind}:${row.amountMicros.toString()}${row.estimated ? "~" : ""}`);
}

async function generate(h: Harness, ctx: TenantContext, input: VideoRequestInput = REQUEST) {
  const { jobId } = await requestVideoGeneration(h.deps, ctx, input);
  const outcome = await runVideoJob(h.deps, ctx.workspaceId, jobId);
  return { jobId, outcome, job: await getVideoJob(db, ctx, jobId) };
}

describe("request and reservation", () => {
  it("reserves the worst case in one transaction and audits without the prompt", async () => {
    const ctx = await createTenant(system);
    const h = harness();
    const { jobId, reservedMicros } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    expect(reservedMicros).toBe(RESERVED);
    expect(await getVideoJob(db, ctx, jobId)).toMatchObject({
      state: "RESERVED",
      attemptCount: 0,
      maxAttempts: 2,
      reservedMicros: RESERVED,
    });
    expect(await ledger(jobId)).toEqual([`RESERVE:${RESERVED.toString()}`]);
    const audit = await system.auditLog.findFirstOrThrow({
      where: { action: "video.job_requested", entityId: jobId },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("coffee");
    expect(h.provider.calls.submit).toBe(0);
  });

  it("refuses invalid, unsupported, too costly and unauthorized requests before reserving", async () => {
    const ctx = await createTenant(system);
    const viewer = await createTenant(system, { role: WorkspaceRole.CLIENT });
    const h = harness();
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) =>
          error instanceof AppError ? [error.code, error.fields[0]?.code] : error,
      );
    expect(await refusal(requestVideoGeneration(h.deps, ctx, { ...REQUEST, prompt: " " }))).toEqual(
      ["VALIDATION_FAILED", "too_small"],
    );
    expect(
      await refusal(
        requestVideoGeneration(h.deps, ctx, { ...REQUEST, tier: "PREMIUM" as "DRAFT" }),
      ),
    ).toEqual(["VALIDATION_FAILED", "invalid_value"]);
    expect(
      await refusal(requestVideoGeneration(h.deps, ctx, { ...REQUEST, durationSeconds: 5 })),
    ).toEqual(["VALIDATION_FAILED", "video_unsupported"]);
    const strict = harness({ limits: { perRequestMaxMicros: RESERVED - 1n } });
    expect(await refusal(requestVideoGeneration(strict.deps, ctx, REQUEST))).toEqual([
      "FORBIDDEN",
      "video_approval_required",
    ]);
    expect(await refusal(requestVideoGeneration(h.deps, viewer, REQUEST))).toEqual([
      "FORBIDDEN",
      undefined,
    ]);
    expect(await system.videoGenerationJob.count()).toBe(0);
    expect(await system.usageLedgerEntry.count()).toBe(0);
  });

  it("never over-commits the daily budget under concurrent requests", async () => {
    const ctx = await createTenant(system);
    const h = harness({ limits: { dailyBudgetMicros: RESERVED * 2n } });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => requestVideoGeneration(h.deps, ctx, REQUEST)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "RATE_LIMITED" });
      }
    }
    // Released money is available again: a refused job releases its whole reservation.
    const job = await system.videoGenerationJob.findFirstOrThrow({ select: { id: true } });
    const refusing = harness({
      scenarios: ["refused"],
      limits: { dailyBudgetMicros: RESERVED * 2n },
    });
    await runVideoJob(refusing.deps, ctx.workspaceId, job.id);
    await expect(requestVideoGeneration(h.deps, ctx, REQUEST)).resolves.toMatchObject({
      reservedMicros: RESERVED,
    });
    await expect(requestVideoGeneration(h.deps, ctx, REQUEST)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    // Another workspace has its own budget.
    await expect(
      requestVideoGeneration(h.deps, await createTenant(system), REQUEST),
    ).resolves.toBeDefined();
  });
});

describe("successful generation", () => {
  it("stores a validated clip, records it for retention, captures and releases money", async () => {
    const ctx = await createTenant(system);
    const h = harness();
    const { jobId, outcome, job } = await generate(h, ctx);
    expect(outcome).toEqual({ status: "finished", state: "READY_FOR_REVIEW" });
    expect(job).toMatchObject({
      state: "READY_FOR_REVIEW",
      failureCode: null,
      attemptCount: 1,
      capturedMicros: PER_ATTEMPT,
      releasedMicros: RESERVED - PER_ATTEMPT,
      attempts: [{ attemptNo: 1, state: "VALIDATED", billedSeconds: 8, costEstimated: false }],
    });
    expect(await ledger(jobId)).toEqual(["RESERVE:800000", "CAPTURE:400000", "RELEASE:400000"]);

    const video = await system.generatedVideo.findUniqueOrThrow({
      where: { id: job.generatedVideoId ?? "" },
      include: { files: true },
    });
    expect(video).toMatchObject({
      workspaceId: ctx.workspaceId,
      provider: "fake",
      model: "fake-video-draft-1",
      durationSeconds: 8,
      width: 1280,
      height: 720,
      costMicros: PER_ATTEMPT,
      status: "AVAILABLE",
    });
    expect(video.expiresAt.getTime() - video.succeededAt.getTime()).toBe(168 * 3600 * 1000);
    expect(video.files).toHaveLength(1);
    const [file] = video.files;
    expect(file?.storageKey).toMatch(
      new RegExp(`^workspaces/${ctx.workspaceId}/generated-videos/[0-9a-f-]{36}\\.mp4$`),
    );
    const stored = h.storage.objects.get(file?.storageKey ?? "");
    expect(stored?.body.byteLength).toBe(file?.byteSize);
    const attempt = await system.videoGenerationAttempt.findFirstOrThrow({ where: { jobId } });
    expect(attempt).toMatchObject({
      idempotencyKey: attemptIdempotencyKey(jobId, 1),
      providerJobId: `fake-video-${attemptIdempotencyKey(jobId, 1)}`,
      outputBytes: file?.byteSize,
    });
    expect(attempt.outputSha256).toMatch(/^[0-9a-f]{64}$/);

    // The workspace can download it through the normal retention-aware path.
    const download = await readGeneratedVideoFile(
      db,
      { forProvider: () => Promise.resolve(h.storage) },
      ctx,
      video.id,
      "VIDEO",
    );
    expect(
      validateClip(download.body, { ...REQUEST, aspectRatio: "16:9", resolution: "720p" }),
    ).toBeNull();
    expect(h.provider.calls.submit).toBe(1);
  });

  it("is accepted or rejected once by a person; other workspaces cannot see it", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const h = harness();
    const { jobId } = await generate(h, ctx);
    await expect(getVideoJob(db, other, jobId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reviewVideoJob(db, other, jobId, "accept")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(runVideoJob(h.deps, other.workspaceId, jobId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await reviewVideoJob(db, ctx, jobId, "accept");
    expect((await getVideoJob(db, ctx, jobId)).state).toBe("ACCEPTED");
    await expect(reviewVideoJob(db, ctx, jobId, "reject")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // A finished job is never run again.
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({ status: "not_active" });
    expect(h.provider.calls.submit).toBe(1);
  });
});

describe("failures and retries (§4.2.4)", () => {
  it("retries once after a provider-side failure (not billed)", async () => {
    const ctx = await createTenant(system);
    const { jobId, job } = await generate(harness({ scenarios: ["provider_failed"] }), ctx);
    expect(job).toMatchObject({
      state: "READY_FOR_REVIEW",
      attemptCount: 2,
      attempts: [
        { state: "FAILED_RETRYABLE", failureCode: "unavailable", costMicros: 0n },
        { state: "VALIDATED" },
      ],
    });
    expect(await ledger(jobId)).toEqual(["RESERVE:800000", "CAPTURE:400000", "RELEASE:400000"]);
  });

  it("stops at maxAttempts when every clip fails validation (charged, nothing stored)", async () => {
    const ctx = await createTenant(system);
    const h = harness({ scenarios: ["invalid_output", "corrupt_output"] });
    const { jobId, job } = await generate(h, ctx);
    expect(job).toMatchObject({
      state: "LIMIT_REACHED",
      failureCode: "max_attempts",
      generatedVideoId: null,
      capturedMicros: RESERVED,
      releasedMicros: 0n,
      attempts: [
        { state: "FAILED_RETRYABLE", failureCode: "duration_mismatch" },
        { state: "FAILED_RETRYABLE", failureCode: "corrupt" },
      ],
    });
    expect(await ledger(jobId)).toEqual(["RESERVE:800000", "CAPTURE:400000", "CAPTURE:400000"]);
    expect(h.storage.objects.size).toBe(0);
    expect(await system.generatedVideo.count()).toBe(0);
  });

  it("never retries a content refusal or a rejected submission", async () => {
    const ctx = await createTenant(system);
    const refused = await generate(harness({ scenarios: ["refused"] }), ctx);
    expect(refused.job).toMatchObject({
      state: "FAILED",
      failureCode: "refused",
      attemptCount: 1,
      releasedMicros: RESERVED,
      attempts: [{ state: "REFUSED_BY_PROVIDER" }],
    });
    const rejected = await generate(harness({ scenarios: ["submit_rejected"] }), ctx);
    expect(rejected.job).toMatchObject({
      state: "FAILED",
      failureCode: "rejected",
      attemptCount: 1,
      attempts: [{ state: "FAILED_PERMANENT", failureCode: "rejected" }],
    });
    expect(await ledger(rejected.jobId)).toEqual(["RESERVE:800000", "RELEASE:800000"]);
  });

  it("retries a submission the provider certainly did not accept", async () => {
    const ctx = await createTenant(system);
    const h = harness({ scenarios: ["submit_unavailable"] });
    const { job } = await generate(h, ctx);
    expect(job.attempts.map((attempt) => attempt.state)).toEqual(["FAILED_RETRYABLE", "VALIDATED"]);
    expect(h.provider.calls.submit).toBe(2);
  });

  it("reconciles a timed-out submission that was accepted instead of resubmitting", async () => {
    const ctx = await createTenant(system);
    const h = harness({ scenarios: ["submit_timeout_accepted"] });
    const { job } = await generate(h, ctx);
    expect(job).toMatchObject({
      state: "READY_FOR_REVIEW",
      attemptCount: 1,
      attempts: [{ state: "VALIDATED", failureCode: null }],
    });
    expect(h.provider.calls.submit).toBe(1);
    expect(h.provider.calls.findByClientRef).toBe(1);
  });

  it("retries a timed-out submission only after the provider confirms it never arrived", async () => {
    const ctx = await createTenant(system);
    const h = harness({ scenarios: ["submit_timeout_lost"] });
    const { job } = await generate(h, ctx);
    expect(job.attempts).toMatchObject([
      { state: "FAILED_RETRYABLE", failureCode: "not_accepted", costMicros: null },
      { state: "VALIDATED" },
    ]);
    expect(h.provider.calls.submit).toBe(2);
  });

  it("holds the reservation when an unknown outcome cannot be reconciled", async () => {
    const ctx = await createTenant(system);
    const h = harness({ scenarios: ["submit_timeout_lost"] });
    h.provider.findByClientRef = () => Promise.reject(new Error("listing unavailable"));
    const { jobId, job } = await generate(h, ctx);
    expect(job).toMatchObject({
      state: "NEEDS_RECONCILIATION",
      failureCode: "outcome_unknown",
      releasedMicros: 0n,
      finishedAt: null,
      attempts: [{ state: "OUTCOME_UNKNOWN" }],
    });
    expect(await ledger(jobId)).toEqual(["RESERVE:800000"]);
    expect(h.provider.calls.submit).toBe(1);
  });

  it("times out after the wall-time bound, cancels and charges the estimate", async () => {
    const ctx = await createTenant(system);
    const h = harness({
      scenarios: ["never_finishes"],
      limits: { maxWallTimeMs: 1500 },
      maxPolls: 100,
      sleepMs: 100,
    });
    const { jobId, job } = await generate(h, ctx);
    expect(job).toMatchObject({
      state: "LIMIT_REACHED",
      failureCode: "max_wall_time",
      attempts: [{ state: "TIMED_OUT", costEstimated: true, costMicros: PER_ATTEMPT }],
    });
    expect(h.provider.calls.cancel).toBe(1);
    expect(await ledger(jobId)).toEqual(["RESERVE:800000", "CAPTURE:400000~", "RELEASE:400000"]);
  });

  it("cancels before a new attempt when the requester lost access", async () => {
    const ctx = await createTenant(system);
    const h = harness();
    const { jobId } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    await system.workspaceMember.updateMany({
      where: { workspaceId: ctx.workspaceId, userId: ctx.userId },
      data: { role: WorkspaceRole.CLIENT },
    });
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({
      status: "finished",
      state: "CANCELLED",
    });
    expect(h.provider.calls.submit).toBe(0);
    expect(await ledger(jobId)).toEqual(["RESERVE:800000", "RELEASE:800000"]);
  });
});

describe("storage and download failures", () => {
  it("keeps the output when storage is unavailable and stores it later without regenerating", async () => {
    const ctx = await createTenant(system);
    let down = true;
    const storage = new MemoryStorageService();
    const h = harness({
      writeTarget: () =>
        down
          ? Promise.reject(new AppError("SERVICE_UNAVAILABLE"))
          : Promise.resolve({ provider: "LEGACY_S3", storage, confirm: () => Promise.resolve() }),
    });
    const { jobId } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({
      status: "waiting",
      reason: "storage_unavailable",
    });
    expect((await getVideoJob(db, ctx, jobId)).attempts).toMatchObject([{ state: "OUTPUT_READY" }]);
    down = false;
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({
      status: "finished",
      state: "READY_FOR_REVIEW",
    });
    expect(h.provider.calls.submit).toBe(1);
    expect(storage.objects.size).toBe(1);
    // Captured once, although the output was handled in two runs.
    expect(await ledger(jobId)).toEqual(["RESERVE:800000", "CAPTURE:400000", "RELEASE:400000"]);
  });

  it("a write that stored the video but timed out: the object is removed, the job waits and stores it later", async () => {
    const ctx = await createTenant(system);
    const storage = new MemoryStorageService();
    const put = storage.put.bind(storage);
    let ambiguous = true;
    const deleted: string[] = [];
    const remove = storage.delete.bind(storage);
    storage.delete = (key, options) => {
      deleted.push(key);
      return remove(key, options);
    };
    storage.put = async (key, body, options) => {
      await put(key, body, options); // storage has it…
      if (ambiguous) {
        ambiguous = false;
        throw new StorageTimeoutError("put"); // …the client never heard back
      }
    };
    const h = harness({
      writeTarget: () =>
        Promise.resolve({ provider: "LEGACY_S3", storage, confirm: () => Promise.resolve() }),
    });
    const { jobId } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({
      status: "waiting",
      reason: "storage_unavailable",
    });
    // The orphan was deleted (exactly the key just written), no row points at anything.
    expect(deleted).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
    expect(await system.generatedVideoFile.count()).toBe(0);
    // The next run stores it once, without regenerating.
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({
      status: "finished",
      state: "READY_FOR_REVIEW",
    });
    expect(h.provider.calls.submit).toBe(1);
    expect(storage.objects.size).toBe(1);
    const [file] = await system.generatedVideoFile.findMany({ select: { storageKey: true } });
    expect(file?.storageKey).not.toBe(deleted[0]); // a fresh key, never the deleted one
  });

  it("removes the stored object when the location changed before recording (CONFLICT)", async () => {
    const ctx = await createTenant(system);
    const storage = new MemoryStorageService();
    const h = harness({
      writeTarget: () =>
        Promise.resolve({
          provider: "LEGACY_S3",
          storage,
          confirm: () => Promise.reject(new AppError("CONFLICT")),
        }),
    });
    const { jobId } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({
      status: "waiting",
      reason: "record_failed",
    });
    expect(storage.objects.size).toBe(0);
    expect(await system.generatedVideo.count()).toBe(0);
    expect((await getVideoJob(db, ctx, jobId)).attempts).toMatchObject([{ state: "OUTPUT_READY" }]);
  });

  it("retries only the download when it fails transiently", async () => {
    const ctx = await createTenant(system);
    const h = harness({ scenarios: ["download_fails_once"] });
    const { job } = await generate(h, ctx);
    expect(job.state).toBe("READY_FOR_REVIEW");
    expect(h.provider.calls.download).toBe(2);
    expect(h.provider.calls.submit).toBe(1);
  });
});

describe("crash recovery", () => {
  it("resumes polling the stored provider job and never submits again", async () => {
    const ctx = await createTenant(system);
    const h = harness({ pollsBeforeDone: 3, maxPolls: 1 });
    const { jobId } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({
      status: "waiting",
      reason: "provider_running",
    });
    // "Restart": a recovery pass with the same provider (it holds the provider jobs).
    const recovery = { ...h.deps, system, maxPolls: 10 };
    expect(await recoverVideoJobs(recovery)).toMatchObject({
      resumed: 1,
      outcomes: [{ status: "finished", state: "READY_FOR_REVIEW" }],
    });
    expect(h.provider.calls.submit).toBe(1);
    expect(await recoverVideoJobs(recovery)).toEqual({ resumed: 0, outcomes: [] });
  });

  it("treats an attempt left INTENDED as an unknown outcome and reconciles it", async () => {
    const ctx = await createTenant(system);
    const h = harness();
    const { jobId } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    // A runner died right after writing its attempt, before the provider answered.
    await system.videoGenerationJob.update({
      where: { id: jobId },
      data: { state: "IN_PROGRESS", attemptCount: 1 },
    });
    await system.videoGenerationAttempt.create({
      data: {
        workspaceId: ctx.workspaceId,
        jobId,
        attemptNo: 1,
        idempotencyKey: attemptIdempotencyKey(jobId, 1),
        provider: "fake",
        model: "fake-video-draft-1",
      },
    });
    await recoverVideoJobs({ ...h.deps, system });
    expect((await getVideoJob(db, ctx, jobId)).attempts).toMatchObject([
      { state: "FAILED_RETRYABLE", failureCode: "not_accepted" },
      { state: "VALIDATED" },
    ]);
    expect(h.provider.calls.findByClientRef).toBe(1);
  });

  it("lets only one runner work on a job at a time", async () => {
    const ctx = await createTenant(system);
    const h = harness();
    const { jobId } = await requestVideoGeneration(h.deps, ctx, REQUEST);
    await system.videoGenerationJob.update({
      where: { id: jobId },
      data: { leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toEqual({ status: "busy" });
    expect(await recoverVideoJobs({ ...h.deps, system })).toEqual({ resumed: 0, outcomes: [] });
    // An expired lease (the runner died) is taken over.
    await system.videoGenerationJob.update({
      where: { id: jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await runVideoJob(h.deps, ctx.workspaceId, jobId)).toMatchObject({ status: "finished" });
  });
});

describe("database rules", () => {
  it("refuses illegal transitions, ledger changes, over-capture and cross-workspace links", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const h = harness();
    const { jobId } = await generate(h, ctx);
    await expect(
      system.videoGenerationJob.update({ where: { id: jobId }, data: { state: "IN_PROGRESS" } }),
    ).rejects.toThrow(/illegal video job transition/);
    await expect(
      system.videoGenerationAttempt.updateMany({ where: { jobId }, data: { state: "SUBMITTED" } }),
    ).rejects.toThrow(/illegal video attempt transition/);
    await expect(
      system.usageLedgerEntry.updateMany({ where: { jobId }, data: { amountMicros: 1n } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      system.videoGenerationJob.update({
        where: { id: jobId },
        data: { capturedMicros: RESERVED + 1n },
      }),
    ).rejects.toThrow(/video_generation_jobs_bounds_check/);
    await expect(
      system.usageLedgerEntry.create({
        data: {
          workspaceId: other.workspaceId,
          jobId,
          category: "VIDEO_GENERATIVE",
          period: new Date("2026-10-09"),
          kind: "RESERVE",
          amountMicros: 1n,
          rateCardVersion: "x",
        },
      }),
    ).rejects.toThrow(/Foreign key constraint|cross-workspace/);
    // The application client cannot rewrite or delete ledger entries either.
    await expect(
      db.usageLedgerEntry.deleteMany({ where: { workspaceId: ctx.workspaceId } }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("keeps the job when the recorded video's metadata is purged", async () => {
    const ctx = await createTenant(system);
    const { jobId, job } = await generate(harness(), ctx);
    await reviewVideoJob(db, ctx, jobId, "reject");
    // What the retention job does: files deleted, then the metadata purged.
    const videoId = job.generatedVideoId ?? "";
    await system.generatedVideoFile.updateMany({
      where: { videoId },
      data: { deletedAt: new Date() },
    });
    await system.generatedVideo.update({ where: { id: videoId }, data: { status: "DELETING" } });
    await system.generatedVideo.update({
      where: { id: videoId },
      data: { status: "DELETED", filesDeletedAt: new Date() },
    });
    await system.generatedVideo.delete({ where: { id: videoId } });
    expect(await getVideoJob(db, ctx, jobId)).toMatchObject({
      state: "REJECTED",
      generatedVideoId: null,
    });
  });
});

it("uses the documented default bounds", () => {
  expect(DEFAULT_VIDEO_LIMITS).toMatchObject({ maxAttempts: 2, maxWallTimeMs: 20 * 60 * 1000 });
});
