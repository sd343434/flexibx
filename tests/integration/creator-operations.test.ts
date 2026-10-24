// Creator Studio operations (Pass 10) on the real database with REAL FFmpeg: consent
// bound to the provider and region shown, duplicate requests, the per-workspace limit on
// running jobs (also under a race), the worker's heartbeat during a long job and its
// scratch-disk check, alert delivery outcomes in ops-status, logs without customer
// content, the read-only retention report, and a stopped worker as the scheduler sees it.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreatorDeps, CreatorLogger } from "@/server/creator/config";
import { claimNextJob, workOnce } from "@/server/creator/jobs";
import { runMediaTool } from "@/server/creator/media/tools";
import {
  completeUpload,
  createProject,
  deleteProject,
  receiveAppUpload,
  requestTranscription,
  startUpload,
} from "@/server/creator/project-service";
import { ruleBasedClipSuggester } from "@/server/creator/providers/clip-suggester";
import { createSimulatedTranslation } from "@/server/creator/providers/simulated";
import type { TranscriptionProvider } from "@/server/creator/providers/types";
import { retentionReport } from "@/server/creator/retention";
import { runWorker } from "@/server/creator/worker";
import { recordAlertDelivery } from "@/server/monitoring/alert-delivery";
import { collectOpsStatus } from "@/server/monitoring/ops-status";
import type { TickPhases } from "@/server/orchestration/runtime";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const TOOLS = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", threads: 2 };
const MiB = 1024 * 1024;
/** Words that must never reach a log line (spoken text of the test provider). */
const SPOKEN = "CONFIDENTIAL-QUARTERLY-NUMBERS";

let media = "";
let small: Uint8Array;

beforeAll(async () => {
  media = mkdtempSync(join(tmpdir(), "creator-operations-"));
  await runMediaTool(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330",
      "-t",
      "8",
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
      join(media, "small.mp4"),
    ],
    { timeoutMs: 60_000 },
  );
  small = new Uint8Array(readFileSync(join(media, "small.mp4")));
}, 120_000);

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  rmSync(media, { recursive: true, force: true });
  await system.$disconnect();
});

/** Every log line the worker and the services write, kept for inspection. */
function capturingLogger() {
  const lines: { level: string; object: Record<string, unknown>; message: string }[] = [];
  const logger: CreatorLogger = {
    info: (object, message) => lines.push({ level: "info", object, message }),
    warn: (object, message) => lines.push({ level: "warn", object, message }),
    error: (object, message) => lines.push({ level: "error", object, message }),
  };
  return { logger, lines };
}

/** A paid provider for the tests (never a real service). */
function paidProvider(
  options: {
    readonly external?: boolean;
    readonly region?: string | null;
    readonly id?: string;
    readonly delayMs?: number;
  } = {},
) {
  let calls = 0;
  const external = options.external ?? false;
  const provider: TranscriptionProvider = {
    id: options.id ?? "test-paid",
    model: "test-model",
    simulated: false,
    external,
    region: options.region !== undefined ? options.region : external ? "US" : null,
    chunkMs: null,
    costMicroUsdPerAudioSecond: 100,
    maxDurationMs: 3_600_000,
    supportsLanguage: () => true,
    transcribe: async ({ durationMs }) => {
      calls += 1;
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      return {
        language: "en",
        billedSeconds: Math.ceil(durationMs / 1000),
        segments: [{ startMs: 0, endMs: Math.min(durationMs, 3000), text: `${SPOKEN}?` }],
      };
    },
  };
  return { provider, calls: () => calls };
}

function harness(overrides: Partial<CreatorDeps> = {}) {
  const storage = new MemoryStorageService();
  const deps: CreatorDeps = {
    db,
    storage: {
      forProvider: () => Promise.resolve(storage),
      writeTarget: () =>
        Promise.resolve({ provider: "LEGACY_S3", storage, confirm: () => Promise.resolve() }),
    },
    transcription: paidProvider().provider,
    translation: createSimulatedTranslation(),
    clips: ruleBasedClipSuggester,
    tools: TOOLS,
    credits: { trialPeriodCredits: 50 },
    limits: {
      maxUploadBytes: 100 * MiB,
      maxDurationMs: 600_000,
      maxActiveUploads: 5,
      uploadSessionMs: 3_600_000,
      maxRunningJobsPerWorkspace: 1,
    },
    workDir: media,
    timing: { retryBaseMs: 0 },
    ...overrides,
  };
  return { deps, storage };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** An uploaded source with its ANALYZE job queued (not run). */
async function queuedAnalysis(deps: CreatorDeps, ctx: TenantContext, name: string) {
  const projectId = (await createProject(db, ctx, { name, description: null })).id;
  const { sourceId } = await startUpload(deps, ctx, projectId, {
    fileName: "private-board-meeting.mp4",
    contentType: "video/mp4",
    size: small.byteLength,
    sha256: sha256(small),
  });
  await receiveAppUpload(deps, ctx, sourceId, small);
  await completeUpload(deps, ctx, sourceId);
  return { projectId, sourceId };
}

async function verifiedProject(deps: CreatorDeps, ctx: TenantContext, name = "Interview") {
  const queued = await queuedAnalysis(deps, ctx, name);
  expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
  return queued;
}

describe("external processing consent", () => {
  it("is bound to the provider and region shown: a changed configuration sends nothing", async () => {
    const ctx = await createTenant(system);
    const shown = paidProvider({ external: true, region: "US" });
    const { deps } = harness({ transcription: shown.provider });
    const { projectId } = await verifiedProject(deps, ctx);
    await requestTranscription(deps, ctx, projectId, {
      language: null,
      requestKey: "consent-us",
      externalProcessing: true,
    });
    const job = await system.creatorJob.findFirstOrThrow({ where: { kind: "TRANSCRIBE" } });
    expect(job.options).toMatchObject({
      externalProcessing: "confirmed",
      externalProvider: "test-paid",
      externalRegion: "US",
    });
    // Who confirmed, when, for which provider and region: the audit entry.
    const audit = await system.auditLog.findFirstOrThrow({
      where: { action: "creator.processing_requested", workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.actorUserId).toBe(ctx.userId);
    expect(audit.metadata).toMatchObject({
      kind: "TRANSCRIBE",
      external: true,
      externalConsent: "confirmed",
      region: "US",
    });

    // The deployment now points at the same vendor in another region: refused, not sent.
    const moved = paidProvider({ external: true, region: "EU" });
    const later = harness({ transcription: moved.provider }).deps;
    const outcome = await workOnce({ ...later, storage: deps.storage }, system);
    expect(outcome).toMatchObject({ outcome: { status: "failed" } });
    expect(moved.calls()).toBe(0);
    const failed = await system.creatorJob.findFirstOrThrow({ where: { id: job.id } });
    expect(failed).toMatchObject({ state: "FAILED", failureCode: "external_consent_missing" });
    expect(
      await system.creditHold.count({
        where: { workspaceId: ctx.workspaceId, status: "CAPTURED" },
      }),
    ).toBe(0);

    // Another provider id with the confirmation of the first: refused too.
    const ctx2 = await createTenant(system);
    const first = harness({ transcription: shown.provider });
    const project2 = await verifiedProject(first.deps, ctx2, "Second");
    await requestTranscription(first.deps, ctx2, project2.projectId, {
      language: null,
      requestKey: "consent-2",
      externalProcessing: true,
    });
    const other = paidProvider({ external: true, region: "US", id: "another-vendor" });
    const swapped = { ...first.deps, transcription: other.provider };
    expect(await workOnce(swapped, system)).toMatchObject({ outcome: { status: "failed" } });
    expect(other.calls()).toBe(0);
  }, 90_000);

  it("a simulated job is never shown or stored as a real transcript", async () => {
    const ctx = await createTenant(system);
    const { createSimulatedTranscription } = await import("@/server/creator/providers/simulated");
    const { deps } = harness({ transcription: createSimulatedTranscription() });
    const { projectId } = await verifiedProject(deps, ctx);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "sim" });
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    const transcript = await system.creatorTranscript.findFirstOrThrow();
    expect(transcript.simulated).toBe(true);
    const step = await system.creatorJobStep.findFirstOrThrow({ where: { stage: "TRANSCRIBE" } });
    expect(step).toMatchObject({ simulated: true, holdId: null, providerCostMicroUsd: null });
  }, 60_000);
});

describe("duplicates, limits and the worker", () => {
  it("the same request sent twice at once is one job and one charge", async () => {
    const ctx = await createTenant(system);
    const paid = paidProvider();
    const { deps } = harness({ transcription: paid.provider });
    const { projectId } = await verifiedProject(deps, ctx);
    const results = await Promise.allSettled([
      requestTranscription(deps, ctx, projectId, { language: null, requestKey: "double-click" }),
      requestTranscription(deps, ctx, projectId, { language: null, requestKey: "double-click" }),
    ]);
    const ids = results.flatMap((entry) =>
      entry.status === "fulfilled" ? [entry.value.jobId] : [],
    );
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ids).size).toBe(1);
    expect(await system.creatorJob.count({ where: { kind: "TRANSCRIBE" } })).toBe(1);
    expect(await workOnce(deps, system)).toMatchObject({ outcome: { status: "succeeded" } });
    // A late repeat of the same request returns the same job and charges nothing more.
    const again = await requestTranscription(deps, ctx, projectId, {
      language: null,
      requestKey: "double-click",
    });
    expect(again.jobId).toBe(ids[0]);
    expect(paid.calls()).toBe(1);
    const holds = await system.creditHold.findMany({
      where: { workspaceId: ctx.workspaceId, feature: "creator_transcription" },
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]?.status).toBe("CAPTURED");
  }, 90_000);

  it("one workspace cannot take every worker, even when workers race for the last slot", async () => {
    const busy = await createTenant(system);
    const other = await createTenant(system);
    const { deps } = harness();
    await queuedAnalysis(deps, busy, "Busy 1");
    await queuedAnalysis(deps, busy, "Busy 2");
    await queuedAnalysis(deps, other, "Other");

    // Two workers race: with a limit of 1, the busy workspace gets one job at most.
    const [first, second] = await Promise.all([
      claimNextJob(deps, system),
      claimNextJob(deps, system),
    ]);
    const claimed = [first, second].filter((job) => job !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((job) => job.workspaceId))).toEqual(
      new Set([busy.workspaceId, other.workspaceId]),
    );
    // A third worker finds nothing it may take: the busy workspace is at its limit.
    expect(await claimNextJob(deps, system)).toBeNull();
    expect(
      await system.creatorJob.count({ where: { workspaceId: busy.workspaceId, state: "QUEUED" } }),
    ).toBe(1);

    // The busy job's worker dies: its lease expires and frees the slot (the expired job
    // itself is taken over; no third job of that workspace runs beside it).
    const held = claimed.find((job) => job.workspaceId === busy.workspaceId);
    if (held === undefined) throw new Error("the busy workspace's job was not claimed");
    await system.creatorJob.updateMany({
      where: { id: held.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const next = await claimNextJob(deps, system);
    expect(next?.workspaceId).toBe(busy.workspaceId);
    expect(
      await system.creatorJob.count({ where: { workspaceId: busy.workspaceId, state: "RUNNING" } }),
    ).toBe(1);
  }, 90_000);

  it("the heartbeat keeps going while a long job runs, and logs carry no customer content", async () => {
    const ctx = await createTenant(system);
    const slow = paidProvider({ delayMs: 1500 });
    const { logger, lines } = capturingLogger();
    const { deps } = harness({ transcription: slow.provider, logger });
    const { projectId } = await verifiedProject(deps, ctx);
    await requestTranscription(deps, ctx, projectId, { language: null, requestKey: "long" });

    const stop = new AbortController();
    const beats = new Set<number>();
    const worker = runWorker(deps, system, {
      signal: stop.signal,
      pollMs: 20,
      heartbeatEveryMs: 100,
      cleanupEveryMs: 60_000,
      minFreeBytes: 1,
    });
    // While the provider works (1.5 s), the heartbeat is written several times.
    const until = Date.now() + 1200;
    await new Promise((resolve) => setTimeout(resolve, 150));
    while (Date.now() < until) {
      const job = await system.creatorJob.findFirstOrThrow({ where: { kind: "TRANSCRIBE" } });
      const beat = await system.systemHeartbeat.findUnique({ where: { name: "creator-worker" } });
      if (job.state === "RUNNING" && beat?.lastFinishedAt) beats.add(beat.lastFinishedAt.getTime());
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    for (let i = 0; i < 100; i += 1) {
      const job = await system.creatorJob.findFirstOrThrow({ where: { kind: "TRANSCRIBE" } });
      if (job.state === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stop.abort();
    expect(await worker).toEqual({ jobs: 1 });
    expect(beats.size).toBeGreaterThanOrEqual(3);
    const beat = await system.systemHeartbeat.findUniqueOrThrow({
      where: { name: "creator-worker" },
    });
    expect(beat).toMatchObject({ lastStatus: "ok", failedPhases: [] });

    // The worker logged its job, but no spoken words, file name or storage key.
    expect(lines.some((line) => line.message === "Creator job ended")).toBe(true);
    const source = await system.creatorSource.findFirstOrThrow();
    const text = JSON.stringify(lines);
    expect(text).not.toContain(SPOKEN);
    expect(text).not.toContain("private-board-meeting");
    expect(text).not.toContain(source.storageKey);
  }, 90_000);

  it("a scratch disk too small for the largest job is reported; the worker still counts as alive", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const stop = new AbortController();
    // No disk is this large: every beat reports the scratch disk as too small.
    const worker = runWorker(deps, system, {
      signal: stop.signal,
      pollMs: 50,
      heartbeatEveryMs: 50,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    for (let i = 0; i < 50; i += 1) {
      const beat = await system.systemHeartbeat.findUnique({ where: { name: "creator-worker" } });
      if (beat?.failedPhases.includes("disk_low") === true) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stop.abort();
    await worker;
    const beat = await system.systemHeartbeat.findUniqueOrThrow({
      where: { name: "creator-worker" },
    });
    expect(beat.failedPhases).toContain("disk_low");
    // Waiting work is queued; the heartbeat is fresh: low disk is its own check.
    await queuedAnalysis(deps, ctx, "Still waiting");
    const status = await collectOpsStatus(system, new Date());
    const check = (name: string) => status.checks.find((entry) => entry.name === name);
    expect(check("creator_worker_disk_low")).toMatchObject({ value: 1, level: "critical" });
    expect(check("creator_worker_last_seen_age_seconds")?.level).toBe("ok");
    expect(check("creator_worker_cleanup_failed")).toMatchObject({ value: 0, level: "ok" });
  }, 90_000);

  it("claims nothing while the media runner is down, and resumes when it answers (Pass 42)", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    await queuedAnalysis(deps, ctx, "Waits for the runner");
    let ready = false;
    let asked = 0;
    const stop = new AbortController();
    const worker = runWorker(deps, system, {
      signal: stop.signal,
      pollMs: 30,
      heartbeatEveryMs: 50,
      minFreeBytes: 1,
      mediaReady: () => {
        asked += 1;
        return Promise.resolve(ready);
      },
    });
    for (let i = 0; i < 60; i += 1) {
      const beat = await system.systemHeartbeat.findUnique({ where: { name: "creator-worker" } });
      if (asked > 5 && beat?.failedPhases.includes("media_runner") === true) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The job was never claimed: no attempt spent, still queued.
    const waiting = await system.creatorJob.findFirstOrThrow({ where: { kind: "ANALYZE" } });
    expect(waiting).toMatchObject({ state: "QUEUED", attempts: 0 });
    const beat = await system.systemHeartbeat.findUniqueOrThrow({
      where: { name: "creator-worker" },
    });
    expect(beat.failedPhases).toContain("media_runner");
    const down = await collectOpsStatus(system, new Date());
    const named = (name: string) => down.checks.find((entry) => entry.name === name);
    expect(named("creator_worker_media_runner_down")).toMatchObject({
      value: 1,
      level: "critical",
    });
    expect(named("creator_worker_cleanup_failed")).toMatchObject({ value: 0, level: "ok" });
    ready = true;
    for (let i = 0; i < 300; i += 1) {
      const job = await system.creatorJob.findFirstOrThrow({ where: { kind: "ANALYZE" } });
      if (job.state === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stop.abort();
    await worker;
    const done = await system.creatorJob.findFirstOrThrow({ where: { kind: "ANALYZE" } });
    expect(done).toMatchObject({ state: "SUCCEEDED", attempts: 1 });
  }, 90_000);
});

describe("a stopped worker, seen from the scheduler (Pass 16)", () => {
  const idle: TickPhases = {
    orchestration: () =>
      Promise.resolve({ recovered: 0, scheduled: 0, skippedNoDelegate: 0, executed: [] }),
    social: () => Promise.resolve({ published: 0, drafted: 0, sent: 0, stuck: 0 }) as never,
    credits: () => Promise.resolve(0),
    video: () => Promise.resolve(0),
  };
  const KEY = "ops:creator_worker_last_seen_age_seconds";

  it("work waiting with no worker is alerted; once a worker is back the job runs and it stops", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    await queuedAnalysis(deps, ctx, "Waiting for a worker");
    const sent: { key: string; severity: string }[] = [];
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/flexibx");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string) as never);
        return Promise.resolve(new Response("ok"));
      }),
    );
    vi.resetModules();
    try {
      const runtime = await import("@/server/orchestration/runtime");
      await runtime.runScheduledAutomationTick(() => new Date(), idle);
      expect(sent.find((entry) => entry.key === KEY)).toMatchObject({ severity: "warning" });

      // A worker starts: it beats, takes the waiting job and finishes it.
      const stop = new AbortController();
      const worker = runWorker(deps, system, {
        signal: stop.signal,
        pollMs: 20,
        heartbeatEveryMs: 50,
        cleanupEveryMs: 60_000,
        minFreeBytes: 1,
      });
      for (let i = 0; i < 200; i += 1) {
        const job = await system.creatorJob.findFirstOrThrow({ where: { kind: "ANALYZE" } });
        if (job.state === "SUCCEEDED") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      stop.abort();
      expect(await worker).toEqual({ jobs: 1 });

      // The next tick finds a fresh worker: the check is ok and nothing new is raised
      // (not even counted as suppressed by the throttle).
      sent.length = 0;
      await runtime.runScheduledAutomationTick(() => new Date(), idle);
      expect(sent.map((entry) => entry.key)).not.toContain(KEY);
      expect(await system.alertThrottle.findUniqueOrThrow({ where: { key: KEY } })).toMatchObject({
        suppressedCount: 0,
      });
      const status = await collectOpsStatus(system, new Date());
      expect(
        status.checks.find((entry) => entry.name === "creator_worker_last_seen_age_seconds"),
      ).toMatchObject({ level: "ok" });
    } finally {
      vi.unstubAllGlobals();
      vi.stubEnv("ALERT_WEBHOOK_URL", "");
      vi.resetModules();
    }
  }, 90_000);
});

describe("operational status additions", () => {
  it("reports failed alert deliveries until a later delivery succeeds", async () => {
    const at = new Date();
    const level = async (when: Date) =>
      (await collectOpsStatus(system, when)).checks.find(
        (entry) => entry.name === "alert_delivery_failed",
      );
    expect(await level(at)).toMatchObject({ value: 0, level: "ok" });
    await recordAlertDelivery(system, ["sent", "failed", "throttled"], at);
    expect(await level(at)).toMatchObject({ value: 1, level: "warning" });
    // Nothing delivered (logged or throttled only): the last real outcome stands.
    await recordAlertDelivery(system, ["logged", "throttled"], new Date(at.getTime() + 1000));
    expect(await level(new Date(at.getTime() + 2000))).toMatchObject({ level: "warning" });
    // An old failure no longer warns; a success clears it at once.
    expect(await level(new Date(at.getTime() + 3 * 3_600_000))).toMatchObject({ level: "ok" });
    await recordAlertDelivery(system, ["sent"], new Date(at.getTime() + 5000));
    expect(await level(new Date(at.getTime() + 6000))).toMatchObject({ value: 0, level: "ok" });
    const row = await system.opsCheckResult.findUniqueOrThrow({
      where: { name: "alert-delivery" },
    });
    expect(row.counts).toEqual({ sent: 1, failed: 0 });
  });

  it("a deleted project whose files are not all removed after a day is reported", async () => {
    const ctx = await createTenant(system);
    const { deps } = harness();
    const { projectId } = await verifiedProject(deps, ctx);
    await deleteProject(deps, ctx, projectId, { confirmName: "Interview" });
    const check = async (when: Date) =>
      (await collectOpsStatus(system, when)).checks.find(
        (entry) => entry.name === "creator_project_deletions_stuck",
      );
    expect(await check(new Date())).toMatchObject({ value: 0, level: "ok" });
    expect(await check(new Date(Date.now() + 25 * 3_600_000))).toMatchObject({
      value: 1,
      level: "warning",
    });
  }, 60_000);
});

describe("retention report (read only)", () => {
  it("counts what a proposed policy would remove, deletes nothing and names nothing", async () => {
    const ctx = await createTenant(system);
    const { deps, storage } = harness();
    await verifiedProject(deps, ctx);
    const source = await system.creatorSource.findFirstOrThrow();
    const now = new Date(Date.now() + 40 * 86_400_000);

    const kept = await retentionReport(system, { sourceDays: null, exportDays: null }, now);
    expect(kept).toMatchObject({
      enforced: false,
      sources: { files: 1, bytes: small.byteLength, beyondPolicy: null },
      exports: { files: 0, bytes: 0, beyondPolicy: null },
    });
    const proposed = await retentionReport(system, { sourceDays: 30, exportDays: 30 }, now);
    expect(proposed.sources.beyondPolicy).toEqual({ files: 1, bytes: small.byteLength });
    const shorter = await retentionReport(system, { sourceDays: 90, exportDays: null }, now);
    expect(shorter.sources.beyondPolicy).toEqual({ files: 0, bytes: 0 });

    const text = JSON.stringify(proposed);
    for (const secret of [source.id, source.storageKey, ctx.workspaceId, "private-board"]) {
      expect(text).not.toContain(secret);
    }
    // Nothing was removed or queued.
    expect(await storage.getObject(source.storageKey)).not.toBeNull();
    expect(await system.creatorStorageDeletion.count()).toBe(0);
    expect(
      await system.creatorSource.findUniqueOrThrow({ where: { id: source.id } }),
    ).toMatchObject({
      status: "VERIFIED",
    });
  }, 60_000);
});
