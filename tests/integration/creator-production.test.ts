// Creator Studio production capabilities (Pass 9) on the real database with REAL FFmpeg
// and an in-memory store that applies S3's multipart rules: resumable uploads with
// per-part checksums, project deletion while work is queued or running, the storage
// deletion queue with failures and retries, data export, provider checkpoints and
// unknown outcomes (no double charge), external-processing consent, and ops-status.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import type { CreatorDeps } from "@/server/creator/config";
import { processStorageDeletions } from "@/server/creator/deletions";
import { claimNextJob, runClaimedJob, workOnce } from "@/server/creator/jobs";
import { runMediaTool } from "@/server/creator/media/tools";
import {
  abortUpload,
  cleanupExpiredUploads,
  completeUpload,
  createProject,
  deleteProject,
  exportProjectData,
  getProject,
  receiveAppPart,
  receiveAppUpload,
  requestTranscription,
  signUploadPart,
  startMultipartUpload,
  startUpload,
  uploadStatus,
} from "@/server/creator/project-service";
import { ruleBasedClipSuggester } from "@/server/creator/providers/clip-suggester";
import {
  createSimulatedTranscription,
  createSimulatedTranslation,
} from "@/server/creator/providers/simulated";
import { CreatorProviderError, type TranscriptionProvider } from "@/server/creator/providers/types";
import { AppError } from "@/server/errors/app-error";
import { collectOpsStatus } from "@/server/monitoring/ops-status";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import type { StorageDeleteOptions } from "@/server/storage/storage";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const TOOLS = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", threads: 2 };
const MiB = 1024 * 1024;
const PART = 5 * MiB;

let media = "";
let small: Uint8Array;
let large: Uint8Array;

beforeAll(async () => {
  media = mkdtempSync(join(tmpdir(), "creator-production-"));
  const make = (out: string, seconds: number, extra: string[]) =>
    runMediaTool(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=25",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330",
        "-t",
        String(seconds),
        ...extra,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        join(media, out),
      ],
      { timeoutMs: 60_000 },
    );
  await make("small.mp4", 20, []);
  // Noise makes the file large enough for three 5 MiB parts (the S3 minimum part size).
  await make("large.mp4", 6, ["-vf", "noise=alls=40:allf=t+u", "-crf", "16"]);
  small = new Uint8Array(readFileSync(join(media, "small.mp4")));
  large = new Uint8Array(readFileSync(join(media, "large.mp4")));
  expect(large.byteLength).toBeGreaterThan(2 * PART);
}, 120_000);

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  rmSync(media, { recursive: true, force: true });
  await system.$disconnect();
});

/** The in-memory store, with deletes that can be made to fail (a storage outage). */
class FlakyStorage extends MemoryStorageService {
  failDeletes = 0;
  override delete(key: string, options?: StorageDeleteOptions): Promise<void> {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      const error = new Error("storage unavailable");
      error.name = "ServiceUnavailable";
      return Promise.reject(error);
    }
    return super.delete(key, options);
  }
}

function harness(overrides: Partial<CreatorDeps> = {}) {
  const storage = new FlakyStorage();
  const deps: CreatorDeps = {
    db,
    storage: {
      forProvider: () => Promise.resolve(storage),
      writeTarget: () =>
        Promise.resolve({ provider: "LEGACY_S3", storage, confirm: () => Promise.resolve() }),
    },
    transcription: createSimulatedTranscription(),
    translation: createSimulatedTranslation(),
    clips: ruleBasedClipSuggester,
    tools: TOOLS,
    credits: { trialPeriodCredits: 50 },
    limits: {
      maxUploadBytes: 100 * MiB,
      maxDurationMs: 600_000,
      maxActiveUploads: 2,
      uploadSessionMs: 3_600_000,
    },
    workDir: media,
    timing: { retryBaseMs: 0, partSizeBytes: PART },
    ...overrides,
  };
  return { deps, storage };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function expectRefusal(promise: Promise<unknown>, code: string, field?: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (field !== undefined) expect((error as AppError).fields[0]?.code).toBe(field);
}

/** What the browser does for one part: declare its size and hash, then PUT it. */
async function sendPart(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
  bytes: Uint8Array,
  partNumber: number,
  options: { readonly declaredSha?: string } = {},
) {
  const body = bytes.subarray((partNumber - 1) * PART, partNumber * PART);
  await signUploadPart(deps, ctx, sourceId, {
    partNumber,
    size: body.byteLength,
    sha256: options.declaredSha ?? sha256(body),
  });
  await receiveAppPart(deps, ctx, sourceId, partNumber, body, (storage, uploadId, expected) => {
    (storage as MemoryStorageService).putPart(uploadId, partNumber, body, expected);
  });
}

async function project(ctx: TenantContext, name = "Long interview") {
  return (await createProject(db, ctx, { name, description: null })).id;
}

async function holds(workspaceId: string) {
  return system.creditHold.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { feature: true, amount: true, status: true, capturedAmount: true },
  });
}

/** A paid, non-simulated provider for the tests (never a real service). */
function paidProvider(options: {
  readonly chunkMs?: number | null;
  readonly external?: boolean;
  readonly behaviour?: (call: number, signal: AbortSignal) => Promise<void>;
}) {
  let calls = 0;
  const provider: TranscriptionProvider = {
    id: "test-paid",
    model: "test-model",
    simulated: false,
    external: options.external ?? false,
    region: options.external === true ? "US" : null,
    chunkMs: options.chunkMs ?? null,
    costMicroUsdPerAudioSecond: 100,
    maxDurationMs: 3_600_000,
    supportsLanguage: () => true,
    transcribe: async ({ durationMs, signal }) => {
      calls += 1;
      await options.behaviour?.(calls, signal);
      return {
        language: "en",
        billedSeconds: Math.ceil(durationMs / 1000),
        segments: [
          { startMs: 0, endMs: Math.min(durationMs, 3000), text: `Line ${String(calls)}?` },
        ],
      };
    },
  };
  return { provider, calls: () => calls };
}

async function verifiedProject(deps: CreatorDeps, ctx: TenantContext) {
  const projectId = await project(ctx);
  const { sourceId } = await startUpload(deps, ctx, projectId, {
    fileName: "talk.mp4",
    contentType: "video/mp4",
    size: small.byteLength,
    sha256: sha256(small),
  });
  await receiveAppUpload(deps, ctx, sourceId, small);
  await completeUpload(deps, ctx, sourceId);
  expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
  return { projectId, sourceId };
}

describe("resumable uploads in parts", () => {
  it("resumes after an interruption, then verifies every part's checksum with real FFmpeg", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const projectId = await project(ctx);
    const started = await startMultipartUpload(deps, ctx, projectId, {
      fileName: "interview.mp4",
      contentType: "video/mp4",
      size: large.byteLength,
    });
    expect(started.partSize).toBe(PART);
    expect(started.partCount).toBe(Math.ceil(large.byteLength / PART));
    expect(started.partCount).toBeGreaterThanOrEqual(3);

    // The connection drops after the first part.
    await sendPart(deps, ctx, started.sourceId, large, 1);
    await expectRefusal(
      completeUpload(deps, ctx, started.sourceId),
      "CONFLICT",
      "creator_upload_incomplete",
    );
    // The browser comes back: storage says which parts it already holds.
    expect((await uploadStatus(deps, ctx, started.sourceId)).uploadedParts).toEqual([1]);
    for (let part = 2; part <= started.partCount; part += 1) {
      await sendPart(deps, ctx, started.sourceId, large, part);
    }
    expect((await uploadStatus(deps, ctx, started.sourceId)).uploadedParts).toHaveLength(
      started.partCount,
    );
    await completeUpload(deps, ctx, started.sourceId);
    // Assembled in storage; the open upload is gone.
    expect(storage.uploads.size).toBe(0);

    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const source = await system.creatorSource.findUniqueOrThrow({
      where: { id: started.sourceId },
    });
    expect(source).toMatchObject({
      status: "VERIFIED",
      uploadMode: "multipart",
      multipartUploadId: null,
      byteSize: large.byteLength,
      sha256: sha256(large),
      container: "mp4",
    });
    const step = await system.creatorJobStep.findFirstOrThrow({ where: { stage: "VERIFY" } });
    expect(step.output).toMatchObject({ checksum: "parts" });
    expect(step.localProcessingMs).not.toBeNull();
    const parts = await system.creatorSourcePart.findMany({ where: { sourceId: source.id } });
    expect(parts.every((part) => part.uploadedAt !== null && part.etag !== null)).toBe(true);
  }, 90_000);

  it("rejects a part whose bytes do not match the declared checksum, and removes the file", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const projectId = await project(ctx);
    const started = await startMultipartUpload(deps, ctx, projectId, {
      fileName: "interview.mp4",
      contentType: "video/mp4",
      size: large.byteLength,
    });
    for (let part = 1; part <= started.partCount; part += 1) {
      await sendPart(deps, ctx, started.sourceId, large, part, {
        ...(part === 2 ? { declaredSha: "0".repeat(64) } : {}),
      });
    }
    await completeUpload(deps, ctx, started.sourceId);
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "failed", failure: "checksum_mismatch" },
    });
    const source = await system.creatorSource.findUniqueOrThrow({
      where: { id: started.sourceId },
    });
    expect(source).toMatchObject({ status: "REJECTED", rejectionCode: "checksum_mismatch" });
    expect(
      await system.creatorStorageDeletion.count({ where: { reason: "source_rejected" } }),
    ).toBe(1);
    await processStorageDeletions(deps, system);
    expect(storage.objects.has(source.storageKey)).toBe(false);
  }, 90_000);

  it("rejects a single upload whose bytes do not hash to the declared SHA-256", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const projectId = await project(ctx);
    const { sourceId } = await startUpload(deps, ctx, projectId, {
      fileName: "talk.mp4",
      contentType: "video/mp4",
      size: small.byteLength,
      sha256: "f".repeat(64),
    });
    await receiveAppUpload(deps, ctx, sourceId, small);
    await completeUpload(deps, ctx, sourceId);
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { failure: "checksum_mismatch" },
    });
    await expectRefusal(
      startUpload(deps, ctx, projectId, {
        fileName: "x.mp4",
        contentType: "video/mp4",
        size: 10,
        sha256: "not-a-hash",
      }),
      "VALIDATION_FAILED",
      "creator_checksum_invalid",
    );
  }, 60_000);

  it("validates parts, limits concurrent uploads and keeps sessions inside their workspace", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const { deps, storage } = harness();
    const projectId = await project(ctx);
    const started = await startMultipartUpload(deps, ctx, projectId, {
      fileName: "a.mp4",
      contentType: "video/mp4",
      size: large.byteLength,
    });
    const hash = "a".repeat(64);
    // Wrong size for the part, a part number out of range, a bad hash.
    await expectRefusal(
      signUploadPart(deps, ctx, started.sourceId, { partNumber: 1, size: PART - 1, sha256: hash }),
      "VALIDATION_FAILED",
      "creator_part_invalid",
    );
    await expectRefusal(
      signUploadPart(deps, ctx, started.sourceId, {
        partNumber: started.partCount + 1,
        size: PART,
        sha256: hash,
      }),
      "VALIDATION_FAILED",
      "creator_part_invalid",
    );
    await expectRefusal(
      signUploadPart(deps, ctx, started.sourceId, { partNumber: 1, size: PART, sha256: "xyz" }),
      "VALIDATION_FAILED",
      "creator_checksum_invalid",
    );
    // Another workspace cannot see, sign, resume, complete or cancel this session.
    await expectRefusal(
      signUploadPart(deps, other, started.sourceId, { partNumber: 1, size: PART, sha256: hash }),
      "NOT_FOUND",
    );
    await expectRefusal(uploadStatus(deps, other, started.sourceId), "NOT_FOUND");
    await expectRefusal(completeUpload(deps, other, started.sourceId), "NOT_FOUND");
    await expectRefusal(abortUpload(deps, other, started.sourceId), "NOT_FOUND");
    await expectRefusal(
      receiveAppPart(deps, other, started.sourceId, 1, large.subarray(0, PART), () => undefined),
      "NOT_FOUND",
    );
    // One open upload per project; at most maxActiveUploads (2) per workspace.
    await expectRefusal(
      startUpload(deps, ctx, projectId, { fileName: "b.mp4", contentType: "video/mp4", size: 100 }),
      "CONFLICT",
      "creator_upload_in_progress",
    );
    await startUpload(deps, ctx, await project(ctx, "Second"), {
      fileName: "c.mp4",
      contentType: "video/mp4",
      size: 100,
    });
    await expectRefusal(
      startUpload(deps, ctx, await project(ctx, "Third"), {
        fileName: "d.mp4",
        contentType: "video/mp4",
        size: 100,
      }),
      "RATE_LIMITED",
      "creator_upload_limit",
    );
    // A single PUT is for small files; the limit applies to multipart sizes too.
    await expectRefusal(
      startMultipartUpload(deps, ctx, await project(ctx, "Huge"), {
        fileName: "e.mp4",
        contentType: "video/mp4",
        size: 101 * MiB,
      }),
      "PAYLOAD_TOO_LARGE",
      "creator_upload_too_large",
    );
    // The person cancels: the open upload is aborted by the sweep, its parts removed.
    await sendPart(deps, ctx, started.sourceId, large, 1);
    await abortUpload(deps, ctx, started.sourceId);
    expect(storage.uploads.size).toBe(1);
    await processStorageDeletions(deps, system);
    expect(storage.uploads.size).toBe(0);
  }, 60_000);

  it("an abandoned multipart upload expires: aborted and its parts removed", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const started = await startMultipartUpload(deps, ctx, await project(ctx), {
      fileName: "a.mp4",
      contentType: "video/mp4",
      size: large.byteLength,
    });
    await sendPart(deps, ctx, started.sourceId, large, 1);
    await system.creatorSource.update({
      where: { id: started.sourceId },
      data: { uploadExpiresAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    // Visible to the operator before the cleanup ran.
    const before = await collectOpsStatus(system, new Date());
    expect(before.checks.find((check) => check.name === "creator_uploads_not_cleaned")?.value).toBe(
      1,
    );
    expect(await cleanupExpiredUploads(deps, system)).toBe(1);
    const deletion = await system.creatorStorageDeletion.findFirstOrThrow();
    expect(deletion).toMatchObject({ reason: "upload_expired", completedAt: null });
    expect(deletion.multipartUploadId).not.toBeNull();
    await processStorageDeletions(deps, system);
    expect(storage.uploads.size).toBe(0);
    expect((await system.creatorStorageDeletion.findFirstOrThrow()).completedAt).not.toBeNull();
  }, 60_000);
});

describe("deleting a project", () => {
  it("while its job waits: nothing runs, files are removed, then the project is purged", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const { projectId, sourceId } = await verifiedProject(deps, ctx);
    const source = await system.creatorSource.findUniqueOrThrow({ where: { id: sourceId } });
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "del-q" });

    await expectRefusal(
      deleteProject(deps, ctx, projectId, { confirmName: "not the name" }),
      "VALIDATION_FAILED",
      "creator_delete_name_mismatch",
    );
    expect(await deleteProject(deps, ctx, projectId, { confirmName: "Long interview" })).toEqual({
      queuedObjects: 1,
    });
    // Repeating it is harmless.
    expect(await deleteProject(deps, ctx, projectId, { confirmName: "x" })).toEqual({
      queuedObjects: 0,
    });
    const page = await getProject(deps, ctx, projectId);
    expect(page.project.status).toBe("DELETING");
    expect(page.deletion).toEqual({ pending: 1, failing: 0 });
    expect(await system.creatorJob.count({ where: { projectId } })).toBe(0);
    expect(await system.creatorSource.count({ where: { projectId } })).toBe(0);
    // No work is left to start; nothing new can start (service and database).
    expect(await workOnce(deps, system)).toBeNull();
    await expectRefusal(
      requestTranscription(deps, ctx, projectId, { language: null, requestKey: "after" }),
      "CONFLICT",
      "creator_project_deleting",
    );
    await expect(
      system.creatorSource.create({
        data: {
          workspaceId: ctx.workspaceId,
          projectId,
          storageProvider: "LEGACY_S3",
          storageKey: `workspaces/${ctx.workspaceId}/creator-sources/${crypto.randomUUID()}.mp4`,
          originalName: "x",
          declaredContentType: "video/mp4",
          declaredBytes: 1,
          uploadExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/being deleted/);

    expect(storage.objects.has(source.storageKey)).toBe(true);
    expect(await processStorageDeletions(deps, system)).toEqual({
      deleted: 1,
      failed: 0,
      purgedProjects: 1,
    });
    expect(storage.objects.has(source.storageKey)).toBe(false);
    expect(await system.creatorProject.count({ where: { id: projectId } })).toBe(0);
    // What is kept: who deleted it, its purge, and the deletion record (keys only).
    const audit = await system.auditLog.findMany({
      where: { workspaceId: ctx.workspaceId, entityId: projectId },
      select: { action: true },
    });
    expect(audit.map((row) => row.action).sort()).toEqual([
      "creator.processing_requested",
      "creator.project_created",
      "creator.project_deletion_requested",
      "creator.project_purged",
    ]);
    expect(await system.creatorStorageDeletion.count({ where: { projectId } })).toBe(1);
  }, 60_000);

  it("while a worker processes it: the worker stops, nothing is charged, the files go", async () => {
    const ctx = await createTenant(system);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inside: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      inside = resolve;
    });
    const paid = paidProvider({
      behaviour: async () => {
        inside();
        await gate;
      },
    });
    const { deps, storage } = harness({ transcription: paid.provider });
    const { projectId, sourceId } = await verifiedProject(deps, ctx);
    const key = (await system.creatorSource.findUniqueOrThrow({ where: { id: sourceId } }))
      .storageKey;
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "del-run" });
    const job = await claimNextJob(deps, system);
    if (job === null) throw new Error("no job");
    const running = runClaimedJob(deps, job);
    await entered;
    expect((await holds(ctx.workspaceId)).map((hold) => hold.status)).toEqual(["HELD"]);

    await deleteProject(deps, ctx, projectId, { confirmName: "Long interview" });
    release();
    expect(await running).toEqual({ status: "lease_lost" });
    // The held credits were released by the deletion; nothing was captured.
    expect(await holds(ctx.workspaceId)).toEqual([
      { feature: "creator_transcription", amount: 2, status: "RELEASED", capturedAmount: null },
    ]);
    expect(await system.creatorTranscript.count()).toBe(0);
    await processStorageDeletions(deps, system);
    expect(storage.objects.has(key)).toBe(false);
    expect(await system.creatorProject.count()).toBe(0);
  }, 60_000);

  it("a storage failure keeps the deletion open and retries it with backoff", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const { projectId, sourceId } = await verifiedProject(deps, ctx);
    const key = (await system.creatorSource.findUniqueOrThrow({ where: { id: sourceId } }))
      .storageKey;
    await deleteProject(deps, ctx, projectId, { confirmName: "Long interview" });

    storage.failDeletes = 1;
    expect(await processStorageDeletions(deps, system)).toEqual({
      deleted: 0,
      failed: 1,
      purgedProjects: 0,
    });
    const failed = await system.creatorStorageDeletion.findFirstOrThrow();
    expect(failed).toMatchObject({
      attempts: 1,
      lastErrorCode: "ServiceUnavailable",
      completedAt: null,
    });
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(storage.objects.has(key)).toBe(true);
    expect((await getProject(deps, ctx, projectId)).deletion).toEqual({ pending: 1, failing: 1 });
    // Not due yet: nothing happens.
    expect(await processStorageDeletions(deps, system)).toMatchObject({ deleted: 0, failed: 0 });
    // Later (backoff elapsed): deleted, project purged.
    expect(
      await processStorageDeletions(deps, system, { now: new Date(Date.now() + 10 * 60_000) }),
    ).toEqual({ deleted: 1, failed: 0, purgedProjects: 1 });
    expect(storage.objects.has(key)).toBe(false);
    expect(await system.creatorProject.count()).toBe(0);
  }, 60_000);

  it("only an editor of the same workspace can delete or export a project", async () => {
    const owner = await createTenant(system);
    const other = await createTenant(system);
    const { deps } = harness();
    const { projectId } = await verifiedProject(deps, owner);
    const viewer = { ...owner, role: WorkspaceRole.VIEWER };
    const client = { ...owner, role: WorkspaceRole.CLIENT };
    for (const ctx of [viewer, client]) {
      await expectRefusal(
        deleteProject(deps, ctx, projectId, { confirmName: "Long interview" }),
        "FORBIDDEN",
      );
      await expectRefusal(exportProjectData(deps, ctx, projectId), "FORBIDDEN");
    }
    await expectRefusal(
      deleteProject(deps, other, projectId, { confirmName: "Long interview" }),
      "NOT_FOUND",
    );
    await expectRefusal(exportProjectData(deps, other, projectId), "NOT_FOUND");
    expect((await getProject(deps, owner, projectId)).project.status).not.toBe("DELETING");
  }, 60_000);
});

describe("data export", () => {
  it("contains the project's data, its history and charges — and nothing secret", async () => {
    const ctx = await createTenant(system);
    const paid = paidProvider({});
    const { deps } = harness({ transcription: paid.provider });
    const { projectId } = await verifiedProject(deps, ctx);
    await requestTranscription(deps, ctx, projectId, { language: "en", requestKey: "export-t" });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const data = await exportProjectData(deps, ctx, projectId);
    expect(data.format).toBe("flexibx.creator-project.v1");
    expect(data.project).toMatchObject({ id: projectId, name: "Long interview" });
    expect(data.transcripts[0]).toMatchObject({
      language: "en",
      simulated: false,
      provider: "test-paid",
    });
    expect(data.transcripts[0]?.segments[0]).toMatchObject({ startMs: 0, text: "Line 1?" });
    const transcribeStep = data.jobs
      .flatMap((job) => job.steps)
      .find((step) => step.stage === "TRANSCRIBE");
    expect(transcribeStep).toMatchObject({ creditsCharged: 2, simulated: false });
    const text = JSON.stringify(data);
    expect(text).not.toContain("storageKey");
    expect(text).not.toContain("workspaces/");
    expect(text).not.toContain("holdId");
    const audit = await system.auditLog.count({
      where: { action: "creator.project_data_exported" },
    });
    expect(audit).toBe(1);
  }, 60_000);
});

describe("provider results, charges and consent", () => {
  it("a retried step reuses pieces already paid for, and is charged once", async () => {
    const ctx = await createTenant(system);
    // Pieces of 8 s over a 20 s source: three provider calls when nothing fails.
    const paid = paidProvider({
      chunkMs: 8000,
      behaviour: (call) =>
        call === 2
          ? Promise.reject(new CreatorProviderError("unavailable", true))
          : Promise.resolve(),
    });
    const { deps } = harness({ transcription: paid.provider });
    const { projectId } = await verifiedProject(deps, ctx);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "pieces" });
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "retrying", failure: "provider_unavailable" },
    });
    const step = await system.creatorJobStep.findFirstOrThrow({ where: { stage: "TRANSCRIBE" } });
    expect(step.checkpoint).toMatchObject({ kind: "transcription", pieces: [{ index: 0 }] });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    // Piece 1 once, piece 2 twice (failed, then done), piece 3 once.
    expect(paid.calls()).toBe(4);
    const done = await system.creatorJobStep.findFirstOrThrow({ where: { stage: "TRANSCRIBE" } });
    expect(done.checkpoint).toBeNull();
    expect(done.providerAudioSeconds).toBe(20);
    expect(done.providerCostMicroUsd).toBe(2000);
    expect(done.localProcessingMs).not.toBeNull();
    const transcript = await system.creatorTranscript.findFirstOrThrow({
      include: { segments: { orderBy: { position: "asc" } } },
    });
    // Timestamps are offset by each piece's start.
    expect(transcript.segments.map((segment) => segment.startMs)).toEqual([0, 8000, 16_000]);
    const all = await holds(ctx.workspaceId);
    expect(all.filter((hold) => hold.status === "CAPTURED")).toHaveLength(1);
    expect(all.filter((hold) => hold.status === "HELD")).toEqual([]);
  }, 60_000);

  it("an unknown provider outcome is not retried automatically and charges nothing", async () => {
    const ctx = await createTenant(system);
    const paid = paidProvider({
      behaviour: () => Promise.reject(new CreatorProviderError("outcome_unknown", false)),
    });
    const { deps } = harness({ transcription: paid.provider });
    const { projectId } = await verifiedProject(deps, ctx);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "unknown" });
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "failed", failure: "provider_outcome_unknown" },
    });
    expect(await workOnce(deps, system)).toBeNull();
    expect(paid.calls()).toBe(1);
    expect((await holds(ctx.workspaceId)).map((hold) => hold.status)).toEqual(["RELEASED"]);
    const status = await collectOpsStatus(system, new Date());
    expect(
      status.checks.find((check) => check.name === "creator_provider_outcome_unknown_24h"),
    ).toMatchObject({
      value: 1,
      level: "warning",
    });
  }, 60_000);

  it("media goes to an external provider only with the person's confirmation", async () => {
    const ctx = await createTenant(system);
    const paid = paidProvider({ external: true });
    const { deps } = harness({ transcription: paid.provider });
    const { projectId } = await verifiedProject(deps, ctx);
    await expectRefusal(
      requestTranscription(deps, ctx, projectId, { language: null, requestKey: "no-consent" }),
      "VALIDATION_FAILED",
      "creator_external_consent_required",
    );
    await requestTranscription(deps, ctx, projectId, {
      language: null,
      requestKey: "consent",
      externalProcessing: true,
    });
    const job = await system.creatorJob.findFirstOrThrow({ where: { kind: "TRANSCRIBE" } });
    expect(job.options).toMatchObject({ externalProcessing: "confirmed" });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const transcript = await system.creatorTranscript.findFirstOrThrow();
    expect(transcript).toMatchObject({ simulated: false, provider: "test-paid" });

    const page = await getProject(deps, ctx, projectId);
    expect(page.provider).toMatchObject({ external: true, region: "US", simulated: false });
  }, 60_000);
});

describe("operational status for the Creator Studio", () => {
  it("counts stuck work and missing workers without exposing customer data", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const { projectId } = await verifiedProject(deps, ctx);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "ops" });
    // A queued job, waiting 20 minutes, with no worker heartbeat.
    await system.creatorJob.updateMany({
      where: { kind: "TRANSCRIBE" },
      data: { runAfter: new Date(Date.now() - 20 * 60_000) },
    });
    let status = await collectOpsStatus(system, new Date());
    const check = (name: string) => status.checks.find((entry) => entry.name === name);
    expect(check("creator_jobs_queued")?.value).toBe(1);
    expect(check("creator_oldest_queued_job_age_seconds")).toMatchObject({ level: "warning" });
    expect(check("creator_worker_last_seen_age_seconds")).toMatchObject({
      value: null,
      level: "warning",
    });

    // A running job whose worker vanished long ago.
    await system.creatorJob.updateMany({
      where: { kind: "TRANSCRIBE" },
      data: {
        state: "RUNNING",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 30 * 60_000),
        startedAt: new Date(Date.now() - 40 * 60_000),
      },
    });
    status = await collectOpsStatus(system, new Date());
    expect(check("creator_jobs_lease_expired")).toMatchObject({ value: 1, level: "critical" });

    // A deletion storage keeps refusing.
    await deleteProject(deps, ctx, projectId, { confirmName: "Long interview" });
    storage.failDeletes = 100;
    for (let round = 0; round < 6; round += 1) {
      await processStorageDeletions(deps, system, {
        now: new Date(Date.now() + (round + 1) * 7 * 3_600_000),
      });
    }
    status = await collectOpsStatus(system, new Date());
    expect(check("creator_storage_deletions_failing")).toMatchObject({
      value: 1,
      level: "critical",
    });

    // The worker reports in: no longer missing.
    await system.systemHeartbeat.create({
      data: {
        name: "creator-worker",
        lastStartedAt: new Date(),
        lastFinishedAt: new Date(),
        lastSucceededAt: new Date(),
        lastStatus: "ok",
      },
    });
    status = await collectOpsStatus(system, new Date());
    expect(check("creator_worker_last_seen_age_seconds")).toMatchObject({ level: "ok" });

    // Counts only: no workspace, project, file name or key in what an operator receives.
    const text = JSON.stringify(status);
    for (const secret of [
      ctx.workspaceId,
      projectId,
      "Long interview",
      "talk.mp4",
      "creator-sources",
    ]) {
      expect(text).not.toContain(secret);
    }
  }, 90_000);
});
