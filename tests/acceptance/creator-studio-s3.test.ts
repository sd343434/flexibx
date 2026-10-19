// Creator Studio acceptance on a staging-like stack (Pass 12): the real database, REAL
// FFmpeg/ffprobe and a REAL S3-compatible bucket reached over HTTP with signed URLs —
// what a hosted staging run does, minus the browser. Synthetic media only (lavfi test
// pattern and tone); transcripts come from the declared simulator, which marks every
// line as simulated. Nothing is sent to an AI provider.
//
//   ACCEPTANCE_S3_ENDPOINT=http://127.0.0.1:8333 ACCEPTANCE_S3_BUCKET=… \
//   ACCEPTANCE_S3_ACCESS_KEY_ID=… ACCEPTANCE_S3_SECRET_ACCESS_KEY=… pnpm test:acceptance
//
// scripts/staging/local-stack.sh starts a disposable SeaweedFS and runs this with the
// right variables. The run refuses a non-local endpoint unless ACCEPTANCE_ALLOW_REMOTE=yes
// (a disposable staging bucket only). It fails — never skips — without a bucket. Every
// object it writes lives under a test workspace's prefix and is deleted by the scenario.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ListMultipartUploadsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CreatorDeps, CreatorLogger } from "@/server/creator/config";
import { processStorageDeletions } from "@/server/creator/deletions";
import { workOnce } from "@/server/creator/jobs";
import { runWorker } from "@/server/creator/worker";
import { probeMedia } from "@/server/creator/media/media";
import { runMediaTool } from "@/server/creator/media/tools";
import {
  cancelJob,
  completeUpload,
  createClip,
  createProject,
  deleteProject,
  exportFile,
  getProject,
  requestExport,
  requestTranscription,
  retryJob,
  reviewClip,
  signUploadPart,
  startMultipartUpload,
  startUpload,
  subtitleFile,
  updateClip,
  updateSegment,
  uploadStatus,
} from "@/server/creator/project-service";
import { ruleBasedClipSuggester } from "@/server/creator/providers/clip-suggester";
import {
  createSimulatedTranscription,
  createSimulatedTranslation,
} from "@/server/creator/providers/simulated";
import type { StorageEnv } from "@/server/env-schema";
import { AppError } from "@/server/errors/app-error";
import { S3StorageService } from "@/server/storage/s3-storage";
import { buildWorkspaceKey, type StorageService } from "@/server/storage/storage";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "../integration/helpers";

const { system, db } = createTestDb();
const TOOLS = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", threads: 2 };
const MiB = 1024 * 1024;
const PART = 5 * MiB; // the S3 minimum for every part but the last

function bucketEnv(): StorageEnv {
  const value = (name: string) => {
    const found = process.env[`ACCEPTANCE_S3_${name}`];
    if (found === undefined || found === "") {
      throw new Error(
        `ACCEPTANCE_S3_${name} is not set: the acceptance run needs a disposable S3-compatible bucket (scripts/staging/local-stack.sh)`,
      );
    }
    return found;
  };
  const endpoint = value("ENDPOINT");
  const host = new URL(endpoint).hostname;
  if (
    !["127.0.0.1", "localhost", "::1"].includes(host) &&
    process.env.ACCEPTANCE_ALLOW_REMOTE !== "yes"
  ) {
    throw new Error(
      "refusing a non-local bucket (set ACCEPTANCE_ALLOW_REMOTE=yes for a disposable one)",
    );
  }
  return {
    S3_ENDPOINT: endpoint,
    S3_REGION: process.env.ACCEPTANCE_S3_REGION ?? "us-east-1",
    S3_BUCKET: value("BUCKET"),
    S3_ACCESS_KEY_ID: value("ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: value("SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: true,
    S3_PUBLIC_BASE_URL: undefined,
  };
}

let env: StorageEnv;
let bucket: S3StorageService;
let client: S3Client | undefined;
let media = "";
let small: Uint8Array;
let large: Uint8Array;

beforeAll(async () => {
  env = bucketEnv();
  bucket = new S3StorageService(env);
  client = new S3Client({
    region: env.S3_REGION,
    forcePathStyle: true,
    endpoint: env.S3_ENDPOINT ?? "",
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  media = mkdtempSync(join(tmpdir(), "creator-acceptance-"));
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
  await make("small.mp4", 12, []);
  // Noise makes the file large enough for three 5 MiB parts.
  await make("large.mp4", 8, ["-vf", "noise=alls=40:allf=t+u", "-crf", "16"]);
  small = new Uint8Array(readFileSync(join(media, "small.mp4")));
  large = new Uint8Array(readFileSync(join(media, "large.mp4")));
  expect(large.byteLength).toBeGreaterThan(2 * PART);
}, 120_000);

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  if (media !== "") rmSync(media, { recursive: true, force: true });
  client?.destroy();
  await system.$disconnect();
});

/** Every log line the services and the worker write. */
function capturingLogger() {
  const lines: string[] = [];
  const logger: CreatorLogger = {
    info: (object, message) => lines.push(JSON.stringify({ level: "info", ...object, message })),
    warn: (object, message) => lines.push(JSON.stringify({ level: "warn", ...object, message })),
    error: (object, message) => lines.push(JSON.stringify({ level: "error", ...object, message })),
  };
  return { logger, lines };
}

function harness(storage: StorageService = bucket, overrides: Partial<CreatorDeps> = {}) {
  const { logger, lines } = capturingLogger();
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
      maxActiveUploads: 3,
      uploadSessionMs: 3_600_000,
    },
    workDir: media,
    logger,
    timing: { retryBaseMs: 0, partSizeBytes: PART },
    ...overrides,
  };
  return { deps, lines };
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

/** The browser's PUT to a signed URL (fetch sets content-length from the body itself). */
async function put(url: string, headers: Readonly<Record<string, string>>, body: Uint8Array) {
  const sent = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
  const response = await fetch(url, { method: "PUT", headers: sent, body: new Uint8Array(body) });
  await response.arrayBuffer();
  return response;
}

/** One part, as the browser sends it: declare its size and SHA-256, then PUT it. */
async function sendPart(
  deps: CreatorDeps,
  ctx: TenantContext,
  sourceId: string,
  partNumber: number,
  declaredSha?: string,
) {
  const body = large.subarray((partNumber - 1) * PART, partNumber * PART);
  const { upload } = await signUploadPart(deps, ctx, sourceId, {
    partNumber,
    size: body.byteLength,
    sha256: declaredSha ?? sha256(body),
  });
  if (upload.kind !== "direct") throw new Error("expected a signed URL");
  return put(upload.url, upload.headers, body);
}

/** What the bucket holds under a workspace's prefix: objects and open multipart uploads. */
async function bucketContents(workspaceId: string) {
  if (client === undefined) throw new Error("no bucket client");
  const prefix = `workspaces/${workspaceId}/`;
  const objects = await client.send(
    new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix }),
  );
  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: env.S3_BUCKET, Prefix: prefix }),
  );
  return {
    objects: (objects.Contents ?? []).map((entry) => entry.Key ?? ""),
    uploads: (uploads.Uploads ?? []).length,
  };
}

/** The worker loop as the worker process runs it, stopped once `done` holds. */
async function runWorkerUntil(deps: CreatorDeps, done: () => Promise<boolean>) {
  const stop = new AbortController();
  const loop = runWorker(deps, system, {
    signal: stop.signal,
    pollMs: 100,
    heartbeatEveryMs: 200,
    minFreeBytes: 0,
  });
  const deadline = Date.now() + 60_000;
  while (!(await done()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stop.abort();
  return loop;
}

async function holds(workspaceId: string) {
  return system.creditHold.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { feature: true, status: true, capturedAmount: true },
  });
}

describe("the whole Creator Studio cycle on a real S3-compatible bucket", () => {
  it("upload in parts with an interruption → analysis → simulated text → edits → clip → export → links → delete", async () => {
    const ctx = await createTenant(system);
    const { deps, lines } = harness();
    const projectName = "Acceptance synthetic project";
    const fileName = "acceptance-synthetic-source.mp4";

    // 1. Project.
    const { id: projectId } = await createProject(db, ctx, {
      name: projectName,
      description: null,
    });

    // 3. Upload in parts; the connection drops during part 2 and the browser resumes.
    const started = await startMultipartUpload(deps, ctx, projectId, {
      fileName,
      contentType: "video/mp4",
      size: large.byteLength,
    });
    expect(started.partCount).toBeGreaterThanOrEqual(3);
    expect((await sendPart(deps, ctx, started.sourceId, 1)).status).toBe(200);
    // Part 2 is cut off half way: the stream fails, storage keeps nothing of it.
    const second = large.subarray(PART, 2 * PART);
    const { upload: signedSecond } = await signUploadPart(deps, ctx, started.sourceId, {
      partNumber: 2,
      size: second.byteLength,
      sha256: sha256(second),
    });
    if (signedSecond.kind !== "direct") throw new Error("expected a signed URL");
    const cut = new AbortController();
    const half = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(second.subarray(0, second.byteLength / 2));
        setTimeout(() => {
          cut.abort();
        }, 50);
      },
    });
    await expect(
      fetch(signedSecond.url, {
        method: "PUT",
        body: half,
        signal: cut.signal,
        duplex: "half",
      } as RequestInit),
    ).rejects.toThrow();
    await expectRefusal(
      completeUpload(deps, ctx, started.sourceId),
      "CONFLICT",
      "creator_upload_incomplete",
    );
    // A new page: storage itself says which parts arrived.
    expect((await uploadStatus(deps, ctx, started.sourceId)).uploadedParts).toEqual([1]);
    for (let part = 2; part <= started.partCount; part += 1) {
      expect((await sendPart(deps, ctx, started.sourceId, part)).status).toBe(200);
    }
    await completeUpload(deps, ctx, started.sourceId);
    expect((await bucketContents(ctx.workspaceId)).uploads).toBe(0);

    // 2 + 4. The worker checks size and every part's SHA-256 and analyses with ffprobe.
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const source = await system.creatorSource.findUniqueOrThrow({
      where: { id: started.sourceId },
    });
    expect(source).toMatchObject({
      status: "VERIFIED",
      byteSize: large.byteLength,
      sha256: sha256(large),
      container: "mp4",
      width: 640,
      height: 360,
      videoCodec: "h264",
      hasAudio: true,
    });
    expect(Math.abs((source.durationMs ?? 0) - 8000)).toBeLessThan(200);

    // 5 + 6. Audio extracted and transcribed by the declared simulator (never real AI).
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "t1" });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    let page = await getProject(deps, ctx, projectId);
    const transcript = page.transcripts[0];
    if (transcript === undefined) throw new Error("no transcript");
    expect(transcript).toMatchObject({ provider: "simulated", simulated: true });
    expect(transcript.segments.every((segment) => segment.text.includes("نص محاكاة"))).toBe(true);
    const steps = await system.creatorJobStep.findMany({
      where: { workspaceId: ctx.workspaceId, state: "SUCCEEDED" },
      select: { stage: true },
    });
    // The audio is extracted with FFmpeg inside TRANSCRIBE (not a separate stage).
    expect(steps.map((step) => step.stage).sort()).toEqual(["SUGGEST", "TRANSCRIBE", "VERIFY"]);

    // 7. The person corrects a line's text and timing.
    const firstLine = transcript.segments[0];
    if (firstLine === undefined) throw new Error("no line");
    await updateSegment(deps, ctx, firstLine.id, {
      text: "Edited synthetic line",
      startMs: 100,
      endMs: 2500,
    });

    // 8. A clip: made by hand, adjusted, approved.
    const { id: clipId } = await createClip(deps, ctx, projectId, {
      title: "Synthetic hook",
      startMs: 500,
      endMs: 4500,
    });
    page = await getProject(deps, ctx, projectId);
    const clip = page.clips.find((entry) => entry.id === clipId);
    if (clip === undefined) throw new Error("no clip");
    await updateClip(deps, ctx, clipId, {
      title: "Synthetic hook",
      startMs: 1000,
      endMs: 4000,
      cropX: 50,
      version: clip.version,
    });
    await reviewClip(deps, ctx, clipId, { decision: "APPROVED", version: clip.version + 1 });

    // 9. Export 9:16 with the subtitles burned in. A double click is the same request.
    const exportRequest = {
      aspectRatio: "PORTRAIT_9_16" as const,
      subtitleTranscriptId: transcript.id,
      requestKey: "e1",
    };
    const { exportId, jobId: exportJob } = await requestExport(deps, ctx, clipId, exportRequest);
    expect(await requestExport(deps, ctx, clipId, exportRequest)).toEqual({
      exportId,
      jobId: exportJob,
    });
    // Rendered by the worker loop itself (what the worker process runs).
    const ran = await runWorkerUntil(deps, async () => {
      const row = await system.creatorExport.findUniqueOrThrow({ where: { id: exportId } });
      return row.status === "READY";
    });
    expect(ran.jobs).toBe(1); // the duplicate request made no second job
    expect(await workOnce(deps, system)).toBeNull();

    // 10. Downloaded through a signed link and checked again with ffprobe.
    const file = await exportFile(deps, ctx, exportId);
    expect(file.key.startsWith(`workspaces/${ctx.workspaceId}/creator-exports/`)).toBe(true);
    const link = await bucket.getSignedDownloadUrl(file.key, { expiresInSeconds: 120 });
    const download = await fetch(link);
    expect(download.status).toBe(200);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.byteLength).toBe(file.byteSize);
    const copy = join(media, "downloaded-export.mp4");
    writeFileSync(copy, bytes);
    const info = await probeMedia(TOOLS, copy, { timeoutMs: 10_000 });
    expect(info).toMatchObject({
      hasVideo: true,
      width: 720,
      height: 1280,
      videoCodec: "h264",
      hasAudio: true,
    });
    expect(Math.abs(info.durationMs - 3000)).toBeLessThanOrEqual(500);
    const exported = await system.creatorExport.findUniqueOrThrow({ where: { id: exportId } });
    expect(exported).toMatchObject({
      status: "READY",
      burnSubtitles: true,
      byteSize: bytes.byteLength,
    });

    // 11. Subtitle files carry the edit and say the text is simulated.
    const srt = await subtitleFile(deps, ctx, transcript.id, "srt");
    expect(srt.fileName).toMatch(/-simulated\.srt$/);
    expect(srt.body).toMatch(/^1\n00:00:00,100 --> 00:00:02,500\nEdited synthetic line\n/);
    const vtt = await subtitleFile(deps, ctx, transcript.id, "vtt");
    expect(vtt.body.startsWith("WEBVTT\n\nNOTE Simulated text")).toBe(true);
    expect(vtt.body).toContain("00:00:00.100 --> 00:00:02.500\nEdited synthetic line");

    // 12. The bucket is private and links expire.
    const bare = link.split("?")[0] ?? "";
    expect((await fetch(bare)).status).toBe(403);
    const tampered = link.replace(
      /X-Amz-Signature=([0-9a-f])/,
      (_, c: string) => `X-Amz-Signature=${c === "0" ? "1" : "0"}`,
    );
    expect((await fetch(tampered)).status).toBe(403);
    const brief = await bucket.getSignedDownloadUrl(file.key, { expiresInSeconds: 1 });
    expect((await fetch(brief)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await fetch(brief)).status).toBe(403);

    // 13. A second export is cancelled, then retried: charged once, nothing left held.
    const second2 = await requestExport(deps, ctx, clipId, {
      aspectRatio: "SQUARE_1_1",
      subtitleTranscriptId: null,
      requestKey: "e2",
    });
    await cancelJob(deps, ctx, second2.jobId);
    expect(await workOnce(deps, system)).toBeNull();
    const retried = await retryJob(deps, ctx, second2.jobId);
    expect(await workOnce(deps, system)).toMatchObject({
      jobId: retried.jobId,
      outcome: { status: "succeeded" },
    });
    const charged = await holds(ctx.workspaceId);
    expect(charged.filter((hold) => hold.status === "HELD")).toEqual([]);
    expect(charged.filter((hold) => hold.status === "CAPTURED")).toHaveLength(2); // two exports

    // 14. Deleting the project removes every object it had in the bucket, then the row.
    expect((await bucketContents(ctx.workspaceId)).objects.length).toBeGreaterThanOrEqual(3);
    await deleteProject(deps, ctx, projectId, { confirmName: projectName });
    const swept = await processStorageDeletions(deps, system);
    expect(swept.failed).toBe(0);
    expect(swept.purgedProjects).toBe(1);
    expect(await bucketContents(ctx.workspaceId)).toEqual({ objects: [], uploads: 0 });
    expect(await system.creatorProject.count({ where: { id: projectId } })).toBe(0);
    expect(
      await system.auditLog.count({
        where: { workspaceId: ctx.workspaceId, action: "creator.project_purged" },
      }),
    ).toBe(1);
    expect((await fetch(link)).status).toBe(404); // the signed link now finds nothing

    // 15. The logs name jobs and outcomes only: no names, text, keys, links or secrets.
    expect(lines.some((line) => line.includes("Creator job ended"))).toBe(true);
    const all = lines.join("\n");
    for (const secret of [
      projectName,
      fileName,
      "Edited synthetic line",
      "نص محاكاة",
      "Synthetic hook",
      `workspaces/${ctx.workspaceId}`,
      "X-Amz-Signature",
      env.S3_SECRET_ACCESS_KEY,
      env.S3_ACCESS_KEY_ID,
    ]) {
      expect(all).not.toContain(secret);
    }
  }, 240_000);
});

describe("failures against the real bucket", () => {
  it("a part whose bytes do not match its declared SHA-256 is rejected and removed", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const { id: projectId } = await createProject(db, ctx, { name: "Checksum", description: null });
    const started = await startMultipartUpload(deps, ctx, projectId, {
      fileName: "c.mp4",
      contentType: "video/mp4",
      size: large.byteLength,
    });
    for (let part = 1; part <= started.partCount; part += 1) {
      const response = await sendPart(
        deps,
        ctx,
        started.sourceId,
        part,
        part === 2 ? "0".repeat(64) : undefined,
      );
      expect(response.status).toBe(200);
    }
    await completeUpload(deps, ctx, started.sourceId);
    expect(await workOnce(deps, system)).toMatchObject({
      outcome: { status: "failed", failure: "checksum_mismatch" },
    });
    expect((await bucketContents(ctx.workspaceId)).objects).toHaveLength(1);
    await processStorageDeletions(deps, system);
    expect(await bucketContents(ctx.workspaceId)).toEqual({ objects: [], uploads: 0 });
  }, 120_000);

  it("a single upload is bound to its size, and its link expires", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const { id: projectId } = await createProject(db, ctx, { name: "Single", description: null });
    const { sourceId, upload } = await startUpload(deps, ctx, projectId, {
      fileName: "s.mp4",
      contentType: "video/mp4",
      size: small.byteLength,
      sha256: sha256(small),
    });
    if (upload.kind !== "direct") throw new Error("expected a signed URL");
    // More bytes than were signed for: refused by storage.
    const shorter = small.subarray(0, small.byteLength - 1);
    expect((await put(upload.url, upload.headers, shorter)).status).toBe(403);
    expect((await put(upload.url, upload.headers, small)).status).toBe(200);
    await completeUpload(deps, ctx, sourceId);
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    expect(await system.creatorSource.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject(
      {
        status: "VERIFIED",
        sha256: sha256(small),
      },
    );
    // An upload link used after it expired.
    const key = buildWorkspaceKey(ctx.workspaceId, "creator-sources", "video/mp4");
    const late = await bucket.getSignedUploadUrl(key, {
      contentType: "video/mp4",
      contentLength: small.byteLength,
      category: "creator-sources",
      expiresInSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await put(late.url, late.headers, small)).status).toBe(403);
    expect((await bucketContents(ctx.workspaceId)).objects).not.toContain(key);
  }, 120_000);

  it("a storage outage during deletion keeps the deletion open; it completes once storage is back", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const { id: projectId } = await createProject(db, ctx, { name: "Outage", description: null });
    const { sourceId, upload } = await startUpload(deps, ctx, projectId, {
      fileName: "o.mp4",
      contentType: "video/mp4",
      size: small.byteLength,
    });
    if (upload.kind !== "direct") throw new Error("expected a signed URL");
    expect((await put(upload.url, upload.headers, small)).status).toBe(200);
    await completeUpload(deps, ctx, sourceId);
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    await deleteProject(deps, ctx, projectId, { confirmName: "Outage" });

    // The key is revoked (wrong secret): every delete fails, nothing is lost.
    const revoked = new S3StorageService({ ...env, S3_SECRET_ACCESS_KEY: "revoked-for-the-test" });
    const outage = harness(revoked).deps;
    const failed = await processStorageDeletions(outage, system);
    expect(failed).toMatchObject({ deleted: 0, purgedProjects: 0 });
    expect(failed.failed).toBeGreaterThan(0);
    const open = await system.creatorStorageDeletion.findMany({
      where: { workspaceId: ctx.workspaceId, completedAt: null },
      select: { attempts: true, lastErrorCode: true },
    });
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((row) => row.attempts === 1 && row.lastErrorCode !== null)).toBe(true);
    expect((await bucketContents(ctx.workspaceId)).objects.length).toBeGreaterThan(0);

    // The key works again; the retry (once due) completes and the project is purged.
    await system.creatorStorageDeletion.updateMany({
      where: { workspaceId: ctx.workspaceId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const done = await processStorageDeletions(deps, system);
    expect(done).toMatchObject({ failed: 0, purgedProjects: 1 });
    expect(await bucketContents(ctx.workspaceId)).toEqual({ objects: [], uploads: 0 });
  }, 120_000);

  it("another workspace reaches none of it", async () => {
    const owner = await createTenant(system);
    const outsider = await createTenant(system);
    const { deps } = harness();
    const { id: projectId } = await createProject(db, owner, {
      name: "Private",
      description: null,
    });
    const started = await startMultipartUpload(deps, owner, projectId, {
      fileName: "p.mp4",
      contentType: "video/mp4",
      size: large.byteLength,
    });
    await expectRefusal(uploadStatus(deps, outsider, started.sourceId), "NOT_FOUND");
    await expectRefusal(
      signUploadPart(deps, outsider, started.sourceId, {
        partNumber: 1,
        size: PART,
        sha256: "a".repeat(64),
      }),
      "NOT_FOUND",
    );
    await expectRefusal(completeUpload(deps, outsider, started.sourceId), "NOT_FOUND");
    await expectRefusal(getProject(deps, outsider, projectId), "NOT_FOUND");
    await expectRefusal(
      deleteProject(deps, outsider, projectId, { confirmName: "Private" }),
      "NOT_FOUND",
    );
    // The owner gives up; the open multipart upload is aborted in the bucket.
    await deleteProject(deps, owner, projectId, { confirmName: "Private" });
    await processStorageDeletions(deps, system);
    expect(await bucketContents(owner.workspaceId)).toEqual({ objects: [], uploads: 0 });
  }, 120_000);
});
