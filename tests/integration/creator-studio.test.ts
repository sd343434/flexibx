// AI Creator Studio end to end on the real database, REAL FFmpeg/ffprobe (the test
// skips nothing: it fails when the binaries are missing) and an in-memory store:
// project → upload → analysis → transcription (declared simulator, and test providers
// that behave like a paid one) → clip suggestions → review → render → private storage,
// plus isolation, refusals, leases, retries, cancellation, timeouts and credits.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import type { CreatorDeps } from "@/server/creator/config";
import { processStorageDeletions } from "@/server/creator/deletions";
import { claimNextJob, runClaimedJob, workOnce } from "@/server/creator/jobs";
import { probeMedia } from "@/server/creator/media/media";
import { runMediaTool } from "@/server/creator/media/tools";
import {
  cancelJob,
  cleanupExpiredUploads,
  completeUpload,
  createProject,
  exportFile,
  getProject,
  listProjects,
  receiveAppUpload,
  requestExport,
  requestTranscription,
  requestTranslation,
  retryJob,
  reviewClip,
  startUpload,
  subtitleFile,
  updateClip,
  updateSegment,
} from "@/server/creator/project-service";
import { ruleBasedClipSuggester } from "@/server/creator/providers/clip-suggester";
import {
  createSimulatedTranscription,
  createSimulatedTranslation,
} from "@/server/creator/providers/simulated";
import { CreatorProviderError, type TranscriptionProvider } from "@/server/creator/providers/types";
import { AppError } from "@/server/errors/app-error";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const TOOLS = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", threads: 2 };
let media: string;
let video: Uint8Array;

beforeAll(async () => {
  media = mkdtempSync(join(tmpdir(), "creator-test-"));
  // A synthetic 20 s, 640×360 clip with a tone (no real person, no real speech).
  await runMediaTool(
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
      "sine=frequency=440",
      "-t",
      "20",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      join(media, "source.mp4"),
    ],
    { timeoutMs: 60_000 },
  );
  video = new Uint8Array(readFileSync(join(media, "source.mp4")));
}, 120_000);

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  rmSync(media, { recursive: true, force: true });
  await system.$disconnect();
});

function harness(overrides: Partial<CreatorDeps> = {}) {
  const storage = new MemoryStorageService();
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
      maxUploadBytes: 50 * 1024 * 1024,
      maxDurationMs: 600_000,
      maxActiveUploads: 3,
      uploadSessionMs: 3_600_000,
    },
    workDir: media,
    timing: { retryBaseMs: 0 },
    ...overrides,
  };
  return { deps, storage };
}

/** A test provider that behaves like a paid, real one (not simulated). */
function paidTranscription(
  behaviour: (attempt: number, signal: AbortSignal) => Promise<void> = () => Promise.resolve(),
) {
  let calls = 0;
  const provider: TranscriptionProvider = {
    id: "test-paid",
    model: "test-model",
    simulated: false,
    external: false,
    region: null,
    chunkMs: null,
    costMicroUsdPerAudioSecond: 100,
    maxDurationMs: 3_600_000,
    supportsLanguage: () => true,
    transcribe: async ({ durationMs, signal }) => {
      calls += 1;
      await behaviour(calls, signal);
      return {
        language: "en",
        billedSeconds: Math.ceil(durationMs / 1000),
        segments: [
          { startMs: 0, endMs: 6000, text: "Why do clips need a hook?" },
          { startMs: 6000, endMs: 12000, text: "Here are 3 quick steps." },
          { startMs: 12000, endMs: 19000, text: "Try it today!" },
        ],
      };
    },
  };
  return { provider, calls: () => calls };
}

async function uploadedProject(
  deps: CreatorDeps,
  ctx: TenantContext,
  bytes: Uint8Array = video,
  contentType = "video/mp4",
) {
  const { id: projectId } = await createProject(db, ctx, {
    name: "Launch talk",
    description: null,
  });
  const { sourceId, upload } = await startUpload(deps, ctx, projectId, {
    fileName: "talk.mp4",
    contentType,
    size: bytes.byteLength,
  });
  expect(upload.kind).toBe("app");
  await receiveAppUpload(deps, ctx, sourceId, bytes);
  await completeUpload(deps, ctx, sourceId);
  return { projectId, sourceId };
}

async function expectRefusal(promise: Promise<unknown>, code: string, field?: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (field !== undefined) expect((error as AppError).fields[0]?.code).toBe(field);
}

async function holds(workspaceId: string) {
  return system.creditHold.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { feature: true, amount: true, status: true, capturedAmount: true },
  });
}

describe("the whole path with the declared simulator and real FFmpeg", () => {
  it("project → upload → analysis → simulated transcript → clips → review → export", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const { projectId, sourceId } = await uploadedProject(deps, ctx);

    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const source = await system.creatorSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source).toMatchObject({
      status: "VERIFIED",
      container: "mp4",
      width: 640,
      height: 360,
      hasVideo: true,
      hasAudio: true,
      videoCodec: "h264",
      byteSize: video.byteLength,
    });
    expect(Math.abs((source.durationMs ?? 0) - 20_000)).toBeLessThan(200);
    let page = await getProject(deps, ctx, projectId);
    expect(page.project.status).toBe("READY");
    // Simulated text is never charged: the estimate says so.
    expect(page.estimate).toMatchObject({ minutes: 1, transcriptionCredits: 0 });
    expect(page.provider).toMatchObject({ id: "simulated", simulated: true, external: false });

    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "r1" });
    // A double click is the same request, and a second request is refused.
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "r1" });
    await expectRefusal(
      requestTranscription(deps, ctx, projectId, { language: null, requestKey: "r2" }),
      "CONFLICT",
      "creator_job_active",
    );
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    page = await getProject(deps, ctx, projectId);
    expect(page.project.status).toBe("NEEDS_REVIEW");
    const transcript = page.transcripts[0];
    expect(transcript).toMatchObject({ kind: "ORIGINAL", provider: "simulated", simulated: true });
    expect(transcript?.segments.length).toBeGreaterThan(2);
    // Every simulated line says it is simulated; timestamps follow the real duration.
    for (const segment of transcript?.segments ?? []) {
      expect(segment.text).toMatch(/نص محاكاة/);
      expect(segment.endMs).toBeLessThanOrEqual(source.durationMs ?? 0);
    }
    expect(page.clips.length).toBeGreaterThan(0);
    expect(page.clips.every((clip) => clip.simulated && clip.origin === "SUGGESTED")).toBe(true);
    expect(page.clips.every((clip) => clip.score >= 0 && clip.score <= 100)).toBe(true);
    expect(await holds(ctx.workspaceId)).toEqual([]); // nothing held or charged

    // The person adjusts the first clip, then approves it.
    const clip = page.clips[0];
    if (clip === undefined) throw new Error("no clip");
    await expectRefusal(
      requestExport(deps, ctx, clip.id, {
        aspectRatio: "PORTRAIT_9_16",
        subtitleTranscriptId: null,
        requestKey: "e0",
      }),
      "CONFLICT",
      "creator_clip_not_approved",
    );
    await updateClip(deps, ctx, clip.id, {
      title: "Hook",
      startMs: 2000,
      endMs: 8000,
      cropX: 30,
      version: clip.version,
    });
    await expectRefusal(
      updateClip(deps, ctx, clip.id, {
        title: "Old",
        startMs: 0,
        endMs: 5000,
        cropX: 50,
        version: clip.version,
      }),
      "CONFLICT",
      "creator_stale",
    );
    await reviewClip(deps, ctx, clip.id, { decision: "APPROVED", version: clip.version + 1 });
    const { exportId } = await requestExport(deps, ctx, clip.id, {
      aspectRatio: "PORTRAIT_9_16",
      subtitleTranscriptId: transcript?.id ?? null,
      requestKey: "e1",
    });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const exported = await system.creatorExport.findUniqueOrThrow({ where: { id: exportId } });
    expect(exported).toMatchObject({
      status: "READY",
      startMs: 2000,
      endMs: 8000,
      cropX: 30,
      width: 720,
      height: 1280,
      burnSubtitles: true,
    });
    expect(Math.abs((exported.durationMs ?? 0) - 6000)).toBeLessThanOrEqual(500);
    expect(exported.storageKey).toMatch(
      new RegExp(`^workspaces/${ctx.workspaceId}/creator-exports/`),
    );

    // The stored file is a valid MP4 of that size and length (checked again here).
    const file = await exportFile(deps, ctx, exportId);
    const stored = storage.objects.get(file.key);
    expect(stored?.body.byteLength).toBe(exported.byteSize);
    const copy = join(media, `check-${exportId}.mp4`);
    writeFileSync(copy, stored?.body ?? new Uint8Array());
    const info = await probeMedia(TOOLS, copy, { timeoutMs: 10_000 });
    expect(info).toMatchObject({
      hasVideo: true,
      width: 720,
      height: 1280,
      videoCodec: "h264",
      hasAudio: true,
    });

    // The export is charged once (FFmpeg work on our worker), and only after it is stored.
    expect(await holds(ctx.workspaceId)).toEqual([
      { feature: "creator_export", amount: 1, status: "CAPTURED", capturedAmount: 1 },
    ]);
    expect((await getProject(deps, ctx, projectId)).project.status).toBe("COMPLETED");

    // Subtitles of simulated text say so.
    const vtt = await subtitleFile(deps, ctx, transcript?.id ?? "", "vtt");
    expect(vtt.fileName).toBe("subtitles-ar-simulated.vtt");
    expect(vtt.body).toContain("NOTE Simulated text");
    const events = (await getProject(deps, ctx, projectId)).events.map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining([
        "upload_completed",
        "source_verified",
        "transcribed",
        "clips_suggested",
        "clip_reviewed",
        "export_ready",
      ]),
    );
  }, 120_000);

  it("translates with the same timestamps and edits a subtitle line", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    await requestTranscription(deps, ctx, projectId, { language: "ar", requestKey: "t" });
    await workOnce(deps, system);
    const original = (await getProject(deps, ctx, projectId)).transcripts[0];
    if (original === undefined) throw new Error("no transcript");
    await requestTranslation(deps, ctx, original.id, { targetLanguage: "en", requestKey: "tr" });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const page = await getProject(deps, ctx, projectId);
    const translation = page.transcripts.find((t) => t.kind === "TRANSLATION");
    expect(translation).toMatchObject({
      language: "en",
      simulated: true,
      translatedFromId: original.id,
    });
    expect(translation?.segments.map((s) => [s.startMs, s.endMs])).toEqual(
      original.segments.map((s) => [s.startMs, s.endMs]),
    );
    expect(translation?.segments[0]?.text).toMatch(/^\[simulated en\]/);
    await expectRefusal(
      requestTranslation(deps, ctx, original.id, { targetLanguage: "en", requestKey: "tr2" }),
      "CONFLICT",
      "creator_translation_exists",
    );
    const first = original.segments[0];
    if (first === undefined) throw new Error("no segment");
    await updateSegment(deps, ctx, first.id, { text: "Edited line", startMs: 100, endMs: 5000 });
    await expectRefusal(
      updateSegment(deps, ctx, first.id, { text: "x", startMs: 5000, endMs: 4000 }),
      "VALIDATION_FAILED",
      "creator_segment_out_of_bounds",
    );
    const after = (await getProject(deps, ctx, projectId)).transcripts[0]?.segments[0];
    expect(after).toMatchObject({ text: "Edited line", startMs: 100, endMs: 5000, edited: true });
  }, 120_000);
});

describe("workspace isolation and roles", () => {
  it("another workspace cannot see, upload to, process or download anything", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const { deps } = harness();
    const { projectId, sourceId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    expect(await listProjects(db, other)).toEqual([]);
    await expectRefusal(getProject(deps, other, projectId), "NOT_FOUND");
    await expectRefusal(
      startUpload(deps, other, projectId, {
        fileName: "x.mp4",
        contentType: "video/mp4",
        size: 10,
      }),
      "NOT_FOUND",
    );
    await expectRefusal(completeUpload(deps, other, sourceId), "NOT_FOUND");
    await expectRefusal(
      requestTranscription(deps, other, projectId, { language: null, requestKey: "x" }),
      "NOT_FOUND",
    );
    // The database refuses rows that point into another workspace's project.
    const foreign = await createProject(db, other, { name: "Other", description: null });
    await expect(
      system.creatorSource.create({
        data: {
          workspaceId: other.workspaceId,
          projectId,
          storageProvider: "LEGACY_S3",
          storageKey: `workspaces/${other.workspaceId}/creator-sources/${crypto.randomUUID()}.mp4`,
          originalName: "x",
          declaredContentType: "video/mp4",
          declaredBytes: 1,
          uploadExpiresAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    // …and a job whose source belongs to another project.
    await expect(
      system.creatorJob.create({
        data: {
          workspaceId: other.workspaceId,
          projectId: foreign.id,
          sourceId,
          kind: "ANALYZE",
          deadlineAt: new Date(),
          idempotencyKey: "x",
        },
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("a viewer can neither create nor approve; a client (review only) cannot create", async () => {
    const owner = await createTenant(system);
    const { deps } = harness();
    const viewer = { ...owner, role: WorkspaceRole.VIEWER };
    await expectRefusal(createProject(db, viewer, { name: "x", description: null }), "FORBIDDEN");
    await expectRefusal(
      reviewClip(deps, viewer, crypto.randomUUID(), { decision: "APPROVED", version: 1 }),
      "FORBIDDEN",
    );
    const client = { ...owner, role: WorkspaceRole.CLIENT };
    await expectRefusal(createProject(db, client, { name: "x", description: null }), "FORBIDDEN");
  });
});

describe("uploads", () => {
  it("refuses an unsupported type, an oversized file and a body of the wrong size", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const { id } = await createProject(db, ctx, { name: "P", description: null });
    await expectRefusal(
      startUpload(deps, ctx, id, {
        fileName: "x.exe",
        contentType: "application/x-msdownload",
        size: 10,
      }),
      "UNSUPPORTED_MEDIA_TYPE",
      "creator_type_unsupported",
    );
    await expectRefusal(
      startUpload(deps, ctx, id, {
        fileName: "big.mp4",
        contentType: "video/mp4",
        size: 60 * 1024 * 1024,
      }),
      "PAYLOAD_TOO_LARGE",
      "creator_upload_too_large",
    );
    const { sourceId } = await startUpload(deps, ctx, id, {
      fileName: "a.mp4",
      contentType: "video/mp4",
      size: 100,
    });
    await expectRefusal(
      receiveAppUpload(deps, ctx, sourceId, new Uint8Array(99)),
      "VALIDATION_FAILED",
      "creator_upload_size_mismatch",
    );
  });

  it("rejects bytes that are not the declared media, and removes them", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const fake = new TextEncoder().encode("#!/bin/sh\necho not a video\n");
    const { sourceId, projectId } = await uploadedProject(deps, ctx, fake);
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "failed", failure: "unsupported_format" },
    });
    const source = await system.creatorSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source).toMatchObject({ status: "REJECTED", rejectionCode: "unsupported_format" });
    // Queued for deletion with the rejection, removed by the storage sweep.
    expect(storage.objects.has(source.storageKey)).toBe(true);
    expect(await processStorageDeletions(deps, system)).toMatchObject({ deleted: 1, failed: 0 });
    expect(storage.objects.has(source.storageKey)).toBe(false);
    expect((await getProject(deps, ctx, projectId)).project.status).toBe("FAILED");

    // A real MP4 declared as audio is refused too (header and declaration must agree).
    const wav = await uploadedProject(deps, ctx, video, "audio/wav");
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { failure: "type_mismatch" } });
    expect(
      await system.creatorSource.findUniqueOrThrow({ where: { id: wav.sourceId } }),
    ).toMatchObject({ status: "REJECTED" });
  }, 60_000);

  it("an upload not completed in time expires and is cleaned up", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    const { id } = await createProject(db, ctx, { name: "P", description: null });
    const { sourceId } = await startUpload(deps, ctx, id, {
      fileName: "a.mp4",
      contentType: "video/mp4",
      size: video.byteLength,
    });
    await receiveAppUpload(deps, ctx, sourceId, video);
    await system.creatorSource.update({
      where: { id: sourceId },
      data: { uploadExpiresAt: new Date(Date.now() - 60 * 60_000) },
    });
    await expectRefusal(completeUpload(deps, ctx, sourceId), "CONFLICT", "creator_upload_expired");
    expect(await cleanupExpiredUploads(deps, system)).toBe(1);
    const source = await system.creatorSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.status).toBe("EXPIRED");
    await processStorageDeletions(deps, system);
    expect(storage.objects.has(source.storageKey)).toBe(false);
    expect(await cleanupExpiredUploads(deps, system)).toBe(0);
  });
});

describe("leases, retries, cancellation and credits", () => {
  it("a worker that lost its lease writes nothing, and the work is charged once", async () => {
    const ctx = await createTenant(system);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const inProvider = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = paidTranscription(async (attempt) => {
      if (attempt === 1) {
        started();
        await gate;
      }
    });
    const { deps } = harness({ transcription: slow.provider });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "l" });

    const first = await claimNextJob(deps, system);
    if (first === null) throw new Error("no job");
    const running = runClaimedJob(deps, first);
    await inProvider;
    // Worker A's lease runs out (it is slow, not dead); worker B takes the job and finishes.
    await system.creatorJob.update({
      where: { id: first.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await workOnce(deps, system)).toMatchObject({
      jobId: first.id,
      outcome: { status: "succeeded" },
    });
    release();
    expect(await running).toEqual({ status: "lease_lost" });
    expect(await system.creatorTranscript.count({ where: { workspaceId: ctx.workspaceId } })).toBe(
      1,
    );
    // A's hold (attempt 1) was released when B started attempt 2; B's was captured.
    const all = await holds(ctx.workspaceId);
    expect(all.filter((h) => h.status === "CAPTURED")).toEqual([
      { feature: "creator_transcription", amount: 2, status: "CAPTURED", capturedAmount: 2 },
    ]);
    expect(all.filter((h) => h.status === "HELD")).toEqual([]);
  }, 60_000);

  it("two workers: the one that lost the job cannot write while the other holds it", async () => {
    const ctx = await createTenant(system);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const inProvider = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = paidTranscription(async (attempt) => {
      if (attempt === 1) {
        started();
        await gate;
      }
    });
    const { deps } = harness({ transcription: slow.provider });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "two" });

    const a = await claimNextJob(deps, system);
    if (a === null) throw new Error("no job");
    const runningA = runClaimedJob(deps, a);
    await inProvider;
    await system.creatorJob.update({
      where: { id: a.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    // Worker B claims the job (still RUNNING, now under B's token) but has not worked yet.
    const b = await claimNextJob(deps, system);
    expect(b?.id).toBe(a.id);
    release();
    expect(await runningA).toEqual({ status: "lease_lost" });
    // A's finished transcript was not stored: the job is B's.
    expect(await system.creatorTranscript.count({ where: { workspaceId: ctx.workspaceId } })).toBe(
      0,
    );
    if (b === null) throw new Error("no claim");
    expect(await runClaimedJob(deps, b)).toEqual({ status: "succeeded" });
    expect(await system.creatorTranscript.count({ where: { workspaceId: ctx.workspaceId } })).toBe(
      1,
    );
    const all = await holds(ctx.workspaceId);
    expect(all.filter((h) => h.status === "CAPTURED")).toHaveLength(1);
    expect(all.filter((h) => h.status === "HELD")).toEqual([]);
  }, 60_000);

  it("retries a temporary provider failure, releasing the failed attempt's credits", async () => {
    const ctx = await createTenant(system);
    const flaky = paidTranscription((attempt) =>
      attempt === 1
        ? Promise.reject(new CreatorProviderError("unavailable", true))
        : Promise.resolve(),
    );
    const { deps } = harness({ transcription: flaky.provider });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "f" });
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "retrying", failure: "provider_unavailable" },
    });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    expect(flaky.calls()).toBe(2);
    expect(await holds(ctx.workspaceId)).toEqual([
      { feature: "creator_transcription", amount: 2, status: "RELEASED", capturedAmount: null },
      { feature: "creator_transcription", amount: 2, status: "CAPTURED", capturedAmount: 2 },
    ]);
    const account = await system.creditAccount.findUniqueOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(account).toMatchObject({ subscriptionCredits: 48, heldCredits: 0 });
  }, 60_000);

  it("a permanent provider failure fails the job at once; nothing is charged", async () => {
    const ctx = await createTenant(system);
    const refused = paidTranscription(() =>
      Promise.reject(new CreatorProviderError("unsupported_language", false)),
    );
    const { deps } = harness({ transcription: refused.provider });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "p" });
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "failed", failure: "unsupported_language" },
    });
    expect((await holds(ctx.workspaceId)).map((h) => h.status)).toEqual(["RELEASED"]);
    expect((await getProject(deps, ctx, projectId)).project.status).toBe("FAILED");
  }, 60_000);

  it("a step that runs past its time limit is aborted and retried", async () => {
    const ctx = await createTenant(system);
    let aborted = false;
    const hanging = paidTranscription((attempt, signal) =>
      attempt === 1
        ? new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          })
        : Promise.resolve(),
    );
    const { deps } = harness({ transcription: hanging.provider });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "h" });
    const slowDeps = { ...deps, timing: { retryBaseMs: 0, stepTimeoutMs: 3000 } };
    expect(await workOnce(slowDeps, system)).toMatchObject({
      outcome: { status: "retrying", failure: "step_timeout" },
    });
    expect(aborted).toBe(true);
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
  }, 60_000);

  it("cancelling a running job stops the worker and releases its credits", async () => {
    const ctx = await createTenant(system);
    let started: () => void = () => undefined;
    const inProvider = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = paidTranscription(
      (_attempt, signal) =>
        new Promise<void>((_resolve, reject) => {
          started();
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const { deps } = harness({
      transcription: waiting.provider,
      timing: { heartbeatMs: 100, retryBaseMs: 0 },
    });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    const { jobId } = await requestTranscription(deps, ctx, projectId, {
      language: null,
      requestKey: "c",
    });
    const work = workOnce(deps, system);
    await inProvider;
    await cancelJob(deps, ctx, jobId);
    expect(await work).toMatchObject({ outcome: { status: "lease_lost" } });
    expect(await system.creatorJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({
      state: "CANCELLED",
    });
    expect((await holds(ctx.workspaceId)).map((h) => h.status)).toEqual(["RELEASED"]);
    await expectRefusal(cancelJob(deps, ctx, jobId), "CONFLICT", "creator_job_not_active");
  }, 60_000);

  it("resuming a failed job never repeats a succeeded (paid) step", async () => {
    const ctx = await createTenant(system);
    const paid = paidTranscription();
    let suggestCalls = 0;
    const brokenClips = {
      id: "broken",
      suggest: () => {
        suggestCalls += 1;
        throw new Error("boom");
      },
    };
    const { deps } = harness({ transcription: paid.provider, clips: brokenClips });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    const { jobId } = await requestTranscription(deps, ctx, projectId, {
      language: null,
      requestKey: "s",
    });
    for (let i = 0; i < 3; i += 1) await workOnce(deps, system);
    expect(await system.creatorJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({
      state: "FAILED",
    });
    expect(paid.calls()).toBe(1);
    // Fixed suggester; the person resumes the job: only the clip step runs again.
    const fixed = { ...deps, clips: ruleBasedClipSuggester };
    await retryJob(fixed, ctx, jobId);
    expect(await workOnce(fixed, system)).toMatchObject({
      jobId,
      outcome: { status: "succeeded" },
    });
    expect(paid.calls()).toBe(1);
    expect(suggestCalls).toBe(3);
    expect((await holds(ctx.workspaceId)).map((h) => h.status)).toEqual(["CAPTURED"]);
    expect(
      await system.creatorClip.count({ where: { workspaceId: ctx.workspaceId } }),
    ).toBeGreaterThan(0);
  }, 60_000);

  it("refuses work when credits are short, without charging", async () => {
    const ctx = await createTenant(system);
    const paid = paidTranscription();
    const { deps } = harness({ transcription: paid.provider, credits: { trialPeriodCredits: 1 } });
    const { projectId } = await uploadedProject(deps, ctx);
    await workOnce(deps, system);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "n" });
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "failed", failure: "credits_insufficient" },
    });
    expect(paid.calls()).toBe(0);
    expect(await holds(ctx.workspaceId)).toEqual([]);
  }, 60_000);
});

describe("transcription disabled", () => {
  it("analysis still works; transcription is refused with a clear reason", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness({ transcription: null, translation: null });
    const { projectId } = await uploadedProject(deps, ctx);
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    expect((await getProject(deps, ctx, projectId)).provider).toBeNull();
    await expectRefusal(
      requestTranscription(deps, ctx, projectId, { language: null, requestKey: "d" }),
      "SERVICE_UNAVAILABLE",
      "creator_provider_disabled",
    );
  }, 60_000);
});
