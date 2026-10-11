// Generated video retention on the real database: database rules (168 h expiry from a
// server-side timestamp), expiration boundaries, deletion of every file kind, retries
// with backoff, crashed runs, duplicate concurrent cleanup jobs, tenant isolation,
// metadata retention and purge, and the 48 h / 24 h reminders.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeneratedVideoFileKind } from "@/generated/prisma/enums";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { AppError } from "@/server/errors/app-error";
import { MemoryMailer, type Mailer, type MailMessage } from "@/server/mail/mailer";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import {
  buildWorkspaceKey,
  type AllowedContentType,
  type StorageCategory,
  type StorageRouter,
  type StorageService,
} from "@/server/storage/storage";
import type { TenantContext } from "@/server/tenancy/context";
import { createBoundedPrismaClient, createGuardedClient } from "@/server/db/prisma";
import {
  databaseNow,
  measureRetentionBacklog,
  runVideoRetention,
  type RetentionDeps,
} from "@/server/videos/retention-job";
import { retentionRunSeverity } from "@/server/videos/retention-observability";
import {
  DELETION_ALERT_ATTEMPTS,
  METADATA_RETENTION_MS,
  VIDEO_RETENTION_MS,
} from "@/server/videos/retention-policy";
import {
  countVideosExpiringWithin,
  listGeneratedVideos,
  readGeneratedVideoFile,
  recordGeneratedVideo,
} from "@/server/videos/video-service";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const HOUR = 60 * 60 * 1000;
const APP_URL = "https://app.flexibx.test";

let storage: MemoryStorageService;
let mailer: MemoryMailer;

beforeEach(async () => {
  await resetDatabase(system);
  storage = new MemoryStorageService();
  mailer = new MemoryMailer();
});

afterAll(async () => {
  await system.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Counts deletes per key and can fail chosen keys a number of times. */
class RecordingStorage implements StorageService {
  readonly deletes = new Map<string, number>();
  readonly failures = new Map<string, number>();
  constructor(private readonly inner: StorageService) {}
  put: StorageService["put"] = (...args) => this.inner.put(...args);
  getSignedUploadUrl: StorageService["getSignedUploadUrl"] = (...args) =>
    this.inner.getSignedUploadUrl(...args);
  getSignedDownloadUrl: StorageService["getSignedDownloadUrl"] = (...args) =>
    this.inner.getSignedDownloadUrl(...args);
  publicUrl: StorageService["publicUrl"] = (key) => this.inner.publicUrl(key);
  getObject: StorageService["getObject"] = (key) => this.inner.getObject(key);
  async delete(key: string): Promise<void> {
    this.deletes.set(key, (this.deletes.get(key) ?? 0) + 1);
    const left = this.failures.get(key) ?? 0;
    if (left > 0) {
      this.failures.set(key, left - 1);
      throw new Error("simulated storage outage");
    }
    await this.inner.delete(key);
  }
}

/** Every provider resolves to one storage service (these tests use a single store). */
const onProvider = (service: StorageService): StorageRouter => ({
  forProvider: () => Promise.resolve(service),
});

const deps = ({
  storage: service,
  ...overrides
}: Partial<Omit<RetentionDeps, "storage">> & { storage?: StorageService } = {}): RetentionDeps => ({
  system,
  db,
  storage: onProvider(service ?? storage),
  mailer,
  appUrl: APP_URL,
  remindersEnabled: true,
  ...overrides,
});

const FILE_TYPES: Record<
  GeneratedVideoFileKind,
  { category: StorageCategory; contentType: AllowedContentType }
> = {
  VIDEO: { category: "generated-videos", contentType: "video/mp4" },
  THUMBNAIL: { category: "generated-images", contentType: "image/jpeg" },
  DERIVATIVE: { category: "generated-videos", contentType: "video/mp4" },
  TEMPORARY: { category: "generated-videos", contentType: "video/mp4" },
};

/** Stores the objects and inserts a video that succeeded at `succeededAt`. */
async function seedVideo(
  ctx: TenantContext,
  succeededAt: Date,
  kinds: readonly GeneratedVideoFileKind[] = ["VIDEO", "THUMBNAIL", "DERIVATIVE", "TEMPORARY"],
  target: StorageService = storage,
) {
  const files = [];
  for (const kind of kinds) {
    const { category, contentType } = FILE_TYPES[kind];
    const storageKey = buildWorkspaceKey(ctx.workspaceId, category, contentType);
    await target.put(storageKey, new Uint8Array([1, 2, 3, 4]), { contentType });
    files.push({ kind, storageKey, contentType, byteSize: 4 });
  }
  const video = await system.generatedVideo.create({
    data: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      title: "Launch teaser",
      provider: "fake",
      model: "fake-video-1",
      providerJobId: "job-123",
      durationSeconds: 4,
      width: 1280,
      height: 720,
      costMicros: 230_000n,
      succeededAt,
      files: {
        create: files.map((file) => ({
          ...file,
          workspaceId: ctx.workspaceId,
          storageProvider: "LEGACY_S3" as const,
        })),
      },
    },
  });
  return { video, keys: files.map((file) => file.storageKey) };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * HOUR);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The guarded client, except that looking up a video's files takes `delayMs` longer. */
function withSlowFileLookups(client: typeof db, delayMs: number): typeof db {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "generatedVideoFile") return value;
      const files = target.generatedVideoFile;
      return new Proxy(files, {
        get(delegate, name, delegateReceiver) {
          if (name !== "findMany") {
            const member: unknown = Reflect.get(delegate, name, delegateReceiver);
            return member;
          }
          return async (...args: Parameters<typeof files.findMany>) => {
            await sleep(delayMs);
            return files.findMany(...args);
          };
        },
      });
    },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
}

async function auditOf(action: string, entityId?: string) {
  return system.auditLog.findMany({
    where: { action, ...(entityId === undefined ? {} : { entityId }) },
    orderBy: { createdAt: "asc" },
  });
}

// ── database rules ───────────────────────────────────────────────────────────

describe("database rules", () => {
  it("sets expires_at to exactly succeeded_at + 168 h, whatever the writer sends", async () => {
    const ctx = await createTenant(system);
    const succeededAt = daysAgo(1);
    const { video } = await seedVideo(ctx, succeededAt, ["VIDEO"]);
    expect(video.expiresAt.getTime() - video.succeededAt.getTime()).toBe(VIDEO_RETENTION_MS);

    const forged = await system.generatedVideo.update({
      where: { id: video.id },
      data: { expiresAt: new Date("2099-01-01T00:00:00Z") },
    });
    expect(forged.expiresAt.getTime()).toBe(video.expiresAt.getTime());
  });

  it("defaults succeeded_at to the database clock and rejects future or changed timestamps", async () => {
    const ctx = await createTenant(system);
    const before = Date.now();
    const created = await recordGeneratedVideo(db, ctx, {
      title: "Server time",
      provider: "fake",
      durationSeconds: 4,
      width: 1280,
      height: 720,
      storageProvider: "LEGACY_S3",
      files: [
        {
          kind: "VIDEO",
          storageKey: buildWorkspaceKey(ctx.workspaceId, "generated-videos", "video/mp4"),
          contentType: "video/mp4",
          byteSize: 10,
        },
      ],
    });
    expect(Math.abs(created.succeededAt.getTime() - before)).toBeLessThan(5_000);
    expect(created.expiresAt.getTime() - created.succeededAt.getTime()).toBe(VIDEO_RETENTION_MS);

    await expect(
      system.generatedVideo.create({
        data: {
          workspaceId: ctx.workspaceId,
          title: "Future",
          provider: "fake",
          durationSeconds: 4,
          width: 1,
          height: 1,
          succeededAt: new Date(Date.now() + HOUR),
        },
      }),
    ).rejects.toThrow();
    await expect(
      system.generatedVideo.update({
        where: { id: created.id },
        data: { succeededAt: daysAgo(3) },
      }),
    ).rejects.toThrow();
  });

  it("keeps files inside their own workspace and video", async () => {
    const a = await createTenant(system);
    const b = await createTenant(system);
    const { video } = await seedVideo(a, daysAgo(1), ["VIDEO"]);
    // A key under workspace B's prefix on a workspace A row.
    await expect(
      system.generatedVideoFile.create({
        data: {
          workspaceId: a.workspaceId,
          videoId: video.id,
          kind: "THUMBNAIL",
          storageKey: buildWorkspaceKey(b.workspaceId, "generated-images", "image/jpeg"),
          contentType: "image/jpeg",
          byteSize: 1,
          storageProvider: "LEGACY_S3",
        },
      }),
    ).rejects.toThrow();
    // A workspace B file row pointing at workspace A's video.
    await expect(
      system.generatedVideoFile.create({
        data: {
          workspaceId: b.workspaceId,
          videoId: video.id,
          kind: "THUMBNAIL",
          storageKey: buildWorkspaceKey(b.workspaceId, "generated-images", "image/jpeg"),
          contentType: "image/jpeg",
          byteSize: 1,
          storageProvider: "LEGACY_S3",
        },
      }),
    ).rejects.toThrow();
    // DELETED requires files_deleted_at.
    await expect(
      system.generatedVideo.update({ where: { id: video.id }, data: { status: "DELETED" } }),
    ).rejects.toThrow();
  });

  it("refuses unscoped access through the application client", async () => {
    await expect(db.generatedVideo.findMany({})).rejects.toMatchObject({
      code: "TENANT_SCOPE_MISSING",
    });
    await expect(db.generatedVideoFile.findMany({})).rejects.toMatchObject({
      code: "TENANT_SCOPE_MISSING",
    });
  });
});

// ── recording ────────────────────────────────────────────────────────────────

describe("recordGeneratedVideo", () => {
  it("needs exactly one VIDEO file, own-workspace keys and content.create", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const base = {
      title: "x",
      provider: "fake",
      durationSeconds: 4,
      width: 1280,
      height: 720,
      storageProvider: "LEGACY_S3" as const,
    };
    const ownKey = () => buildWorkspaceKey(ctx.workspaceId, "generated-videos", "video/mp4");
    await expect(recordGeneratedVideo(db, ctx, { ...base, files: [] })).rejects.toBeInstanceOf(
      AppError,
    );
    const foreign = await rejection(
      recordGeneratedVideo(db, ctx, {
        ...base,
        files: [
          {
            kind: "VIDEO",
            storageKey: buildWorkspaceKey(other.workspaceId, "generated-videos", "video/mp4"),
            contentType: "video/mp4",
            byteSize: 1,
          },
        ],
      }),
    );
    expect(foreign).toMatchObject({ code: "NOT_FOUND" });
    const viewer = await createTenant(system, { role: WorkspaceRole.VIEWER });
    await expect(
      recordGeneratedVideo(db, viewer, {
        ...base,
        files: [{ kind: "VIDEO", storageKey: ownKey(), contentType: "video/mp4", byteSize: 1 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await recordGeneratedVideo(db, ctx, {
      ...base,
      costMicros: 230_000n,
      files: [{ kind: "VIDEO", storageKey: ownKey(), contentType: "video/mp4", byteSize: 1 }],
    });
    const [audit] = await auditOf("video.generated", created.id);
    expect(audit?.workspaceId).toBe(ctx.workspaceId);
    expect(JSON.stringify(audit?.metadata)).not.toContain("workspaces/");
  });
});

// ── expiration boundaries ────────────────────────────────────────────────────

describe("expiration boundaries", () => {
  it("keeps files until the exact expiry instant and deletes them from it", async () => {
    const ctx = await createTenant(system);
    const { video, keys } = await seedVideo(ctx, daysAgo(2));
    const expiresAt = video.expiresAt;
    const justBefore = new Date(expiresAt.getTime() - 1);

    // 1 ms before expiry: downloadable, not claimed.
    const file = await readGeneratedVideoFile(
      db,
      onProvider(storage),
      ctx,
      video.id,
      "VIDEO",
      justBefore,
    );
    expect(file.contentType).toBe("video/mp4");
    const early = await runVideoRetention(deps(), { now: justBefore });
    expect(early.deletion.claimed).toBe(0);
    for (const key of keys) expect(await storage.getObject(key)).not.toBeNull();

    // At expiry: refused for download even before the job runs, then deleted.
    await expect(
      readGeneratedVideoFile(db, onProvider(storage), ctx, video.id, "VIDEO", expiresAt),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const due = await runVideoRetention(deps(), { now: expiresAt });
    expect(due.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
    for (const key of keys) expect(await storage.getObject(key)).toBeNull();
  });
});

// ── deletion and metadata retention ──────────────────────────────────────────

describe("deletion", () => {
  it("deletes video, thumbnail, derivatives and temporary files but keeps the metadata", async () => {
    const ctx = await createTenant(system);
    const { video, keys } = await seedVideo(ctx, daysAgo(8));
    const now = new Date(video.expiresAt.getTime() + HOUR);
    await runVideoRetention(deps(), { now });

    for (const key of keys) expect(await storage.getObject(key)).toBeNull();
    const after = await system.generatedVideo.findUniqueOrThrow({
      where: { id: video.id },
      include: { files: true },
    });
    expect(after.status).toBe("DELETED");
    expect(after.filesDeletedAt?.getTime()).toBe(now.getTime());
    // Job, cost and timing metadata survive the files.
    expect(after).toMatchObject({
      provider: "fake",
      model: "fake-video-1",
      providerJobId: "job-123",
      durationSeconds: 4,
      costMicros: 230_000n,
    });
    expect(after.succeededAt.getTime()).toBe(video.succeededAt.getTime());
    expect(after.files).toHaveLength(4);
    expect(after.files.every((file) => file.deletedAt !== null)).toBe(true);

    const [audit] = await auditOf("video.files_deleted", video.id);
    expect(audit?.workspaceId).toBe(ctx.workspaceId);
    expect(audit?.actorUserId).toBeNull();
    expect(audit?.metadata).toMatchObject({ filesDeleted: 4, bytesDeleted: 16, attempts: 1 });
    expect(JSON.stringify(audit?.metadata)).not.toContain("workspaces/");

    // The list still shows it as deleted; downloads stay refused.
    const [listed] = await listGeneratedVideos(db, ctx);
    expect(listed).toMatchObject({ id: video.id, status: "DELETED", hasThumbnail: false });
    await expect(
      readGeneratedVideoFile(db, onProvider(storage), ctx, video.id, "VIDEO", now),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is idempotent: later runs do nothing and audit nothing more", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(8));
    const now = new Date(video.expiresAt.getTime() + HOUR);
    await runVideoRetention(deps(), { now });
    const again = await runVideoRetention(deps(), { now: new Date(now.getTime() + 24 * HOUR) });
    expect(again.deletion.claimed).toBe(0);
    expect(await auditOf("video.files_deleted", video.id)).toHaveLength(1);
  });

  it("retries failed deletions with backoff and only re-deletes what is left", async () => {
    const ctx = await createTenant(system);
    const recording = new RecordingStorage(storage);
    const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO", "THUMBNAIL"], recording);
    const [videoKey, thumbKey] = keys as [string, string];
    recording.failures.set(thumbKey, 1);
    const now = new Date(video.expiresAt.getTime() + HOUR);

    const first = await runVideoRetention(deps({ storage: recording }), { now });
    expect(first.deletion).toEqual({ claimed: 1, deleted: 0, failed: 1, interrupted: 0 });
    const pending = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(pending).toMatchObject({
      status: "DELETING",
      deletionAttempts: 1,
      lastDeletionError: "storage_delete_failed",
    });
    expect(pending.nextDeletionAttemptAt?.getTime()).toBe(now.getTime() + 5 * 60 * 1000);
    expect(await storage.getObject(videoKey)).toBeNull();
    expect(await storage.getObject(thumbKey)).not.toBeNull();
    const [failure] = await auditOf("video.deletion_failed", video.id);
    expect(failure?.metadata).toMatchObject({ attempts: 1, failedFiles: 1, alert: false });

    // Before the backoff elapses nothing happens.
    const tooSoon = await runVideoRetention(deps({ storage: recording }), {
      now: new Date(now.getTime() + 60 * 1000),
    });
    expect(tooSoon.deletion.claimed).toBe(0);

    const retry = await runVideoRetention(deps({ storage: recording }), {
      now: new Date(now.getTime() + 5 * 60 * 1000),
    });
    expect(retry.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
    expect(await storage.getObject(thumbKey)).toBeNull();
    // The already-deleted video object was not deleted again.
    expect(recording.deletes.get(videoKey)).toBe(1);
    expect(recording.deletes.get(thumbKey)).toBe(2);
    const done = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(done).toMatchObject({ status: "DELETED", deletionAttempts: 2, lastDeletionError: null });
    expect(await auditOf("video.files_deleted", video.id)).toHaveLength(1);
  });

  it("picks up a crashed run's claim only after its lease expires", async () => {
    const ctx = await createTenant(system);
    const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO"]);
    const now = new Date(video.expiresAt.getTime() + HOUR);
    // A run claimed it and died before deleting anything.
    await system.generatedVideo.update({
      where: { id: video.id },
      data: {
        status: "DELETING",
        deletionAttempts: 1,
        nextDeletionAttemptAt: new Date(now.getTime() + 10 * 60 * 1000),
      },
    });
    expect((await runVideoRetention(deps(), { now })).deletion.claimed).toBe(0);
    const later = await runVideoRetention(deps(), {
      now: new Date(now.getTime() + 10 * 60 * 1000),
    });
    expect(later.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
    expect(await storage.getObject(keys[0] ?? "")).toBeNull();
  });

  it("lets concurrent duplicate jobs delete each video exactly once", async () => {
    const ctx = await createTenant(system);
    const recording = new RecordingStorage(storage);
    const seeded = [];
    for (let i = 0; i < 6; i += 1) {
      seeded.push(await seedVideo(ctx, daysAgo(8), ["VIDEO", "THUMBNAIL"], recording));
    }
    const now = new Date(Date.now() + HOUR);
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        runVideoRetention(deps({ storage: recording }), { now, batchSize: 2 }),
      ),
    );
    // Whatever the interleaving, the claims never overlap.
    expect(runs.reduce((sum, run) => sum + run.deletion.claimed, 0)).toBeLessThanOrEqual(6);
    // Finish anything the batch size left over, then check exactly-once effects.
    await runVideoRetention(deps({ storage: recording }), { now });
    for (const { video, keys } of seeded) {
      const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
      expect(row.status).toBe("DELETED");
      expect(await auditOf("video.files_deleted", video.id)).toHaveLength(1);
      for (const key of keys) expect(recording.deletes.get(key)).toBe(1);
    }
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("deletes only expired videos, never another workspace's, and hides foreign videos", async () => {
    const a = await createTenant(system);
    const b = await createTenant(system);
    const expired = await seedVideo(a, daysAgo(8), ["VIDEO"]);
    const fresh = await seedVideo(b, daysAgo(1), ["VIDEO"]);

    await runVideoRetention(deps(), { now: new Date() });

    expect(await storage.getObject(expired.keys[0] ?? "")).toBeNull();
    expect(await storage.getObject(fresh.keys[0] ?? "")).not.toBeNull();
    const freshRow = await system.generatedVideo.findUniqueOrThrow({
      where: { id: fresh.video.id },
    });
    expect(freshRow.status).toBe("AVAILABLE");
    const [audit] = await auditOf("video.files_deleted", expired.video.id);
    expect(audit?.workspaceId).toBe(a.workspaceId);

    expect((await listGeneratedVideos(db, b)).map((video) => video.id)).toEqual([fresh.video.id]);
    expect((await listGeneratedVideos(db, a)).map((video) => video.id)).toEqual([expired.video.id]);
    await expect(
      readGeneratedVideoFile(db, onProvider(storage), a, fresh.video.id, "VIDEO"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await readGeneratedVideoFile(db, onProvider(storage), b, fresh.video.id, "VIDEO")).body,
    ).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("never deletes an object outside the video's workspace even if a row were corrupted", async () => {
    const a = await createTenant(system);
    const b = await createTenant(system);
    const { video } = await seedVideo(a, daysAgo(8), ["VIDEO"]);
    const foreignKey = buildWorkspaceKey(b.workspaceId, "generated-videos", "video/mp4");
    await storage.put(foreignKey, new Uint8Array([9]), { contentType: "video/mp4" });
    // Simulate a corrupted row: drop the key-prefix CHECK just long enough to insert it.
    await system.$executeRaw`
      ALTER TABLE generated_video_files DROP CONSTRAINT generated_video_files_key_prefix_check`;
    try {
      await system.$executeRaw`
        INSERT INTO generated_video_files (workspace_id, video_id, kind, storage_key, storage_provider, content_type, byte_size)
        VALUES (${a.workspaceId}::uuid, ${video.id}::uuid, 'DERIVATIVE', ${foreignKey}, 'LEGACY_S3', 'video/mp4', 1)`;
      const result = await runVideoRetention(deps(), { now: new Date() });
      expect(result.deletion).toMatchObject({ claimed: 1, failed: 1 });
      expect(await storage.getObject(foreignKey)).not.toBeNull();
    } finally {
      // Tombstone first: the delete guard refuses to drop a row whose object may exist.
      await system.$executeRaw`
        UPDATE generated_video_files SET deleted_at = now()
        WHERE storage_key = ${foreignKey} AND deleted_at IS NULL`;
      await system.$executeRaw`DELETE FROM generated_video_files WHERE storage_key = ${foreignKey}`;
      await system.$executeRaw`
        ALTER TABLE generated_video_files ADD CONSTRAINT generated_video_files_key_prefix_check
        CHECK (left(storage_key, 48) = 'workspaces/' || workspace_id::text || '/')`;
    }
  });
});

// ── metadata retention ───────────────────────────────────────────────────────

describe("metadata retention", () => {
  it("purges video rows only after the metadata period, and keeps the audit trail", async () => {
    const ctx = await createTenant(system);
    const old = await seedVideo(ctx, daysAgo(800), ["VIDEO"]);
    const recent = await seedVideo(ctx, daysAgo(30), ["VIDEO"]);
    const now = new Date();
    // The old video's files were deleted at its expiry, about 793 days ago.
    await runVideoRetention(deps(), { now: new Date(old.video.expiresAt.getTime()) });
    // Today's run deletes the recent video's files and purges only the old metadata.
    const result = await runVideoRetention(deps(), { now });
    expect(result.deletion.deleted).toBe(1);
    expect(result.purged).toBe(1);
    expect(await system.generatedVideo.findUnique({ where: { id: old.video.id } })).toBeNull();
    expect(await system.generatedVideoFile.count({ where: { videoId: old.video.id } })).toBe(0);
    expect(
      await system.generatedVideo.findUnique({ where: { id: recent.video.id } }),
    ).not.toBeNull();
    expect(await auditOf("video.metadata_purged", old.video.id)).toHaveLength(1);
    // The deletion audit of the purged video remains.
    expect(await auditOf("video.files_deleted", old.video.id)).toHaveLength(1);
    expect(now.getTime() - old.video.expiresAt.getTime()).toBeGreaterThan(METADATA_RETENTION_MS);
  });

  it("purges exactly 30 days after the files were deleted, not a millisecond earlier", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(60), ["VIDEO"]);
    const deletedAt = video.expiresAt; // files deleted at the expiry instant
    await runVideoRetention(deps(), { now: deletedAt });
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(row.filesDeletedAt?.getTime()).toBe(deletedAt.getTime());

    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(METADATA_RETENTION_MS).toBe(thirtyDays);
    const before = await runVideoRetention(deps(), {
      now: new Date(deletedAt.getTime() + thirtyDays - 1),
    });
    expect(before.purged).toBe(0);
    expect(await system.generatedVideo.count({ where: { id: video.id } })).toBe(1);

    const at = await runVideoRetention(deps(), { now: new Date(deletedAt.getTime() + thirtyDays) });
    expect(at.purged).toBe(1);
    expect(await system.generatedVideo.count({ where: { id: video.id } })).toBe(0);
    expect(await system.generatedVideoFile.count({ where: { videoId: video.id } })).toBe(0);
  });
});

// ── bounded runs (time budget, storage timeouts, overlapping runs) ───────────

/**
 * Storage whose deletes take `delayMs` (per key, or a default), optionally ignoring the
 * abort signal like a hung adapter. Records when each delete started and whether it was
 * aborted; `settled()` waits for every delete, so no test leaves work running.
 */
class SlowStorage implements StorageService {
  readonly starts: { key: string; at: number }[] = [];
  readonly aborted: string[] = [];
  /** In order: `abort:<key>` when the signal fires, `done:<key>` when the object is gone. */
  readonly events: string[] = [];
  readonly delays = new Map<string, number>();
  readonly gates = new Map<string, () => Promise<void>>();
  private readonly pending: Promise<unknown>[] = [];
  constructor(
    private readonly inner: StorageService,
    private readonly delayMs: number,
    private readonly honorAbort = true,
  ) {}
  put: StorageService["put"] = (...args) => this.inner.put(...args);
  getSignedUploadUrl: StorageService["getSignedUploadUrl"] = (...args) =>
    this.inner.getSignedUploadUrl(...args);
  getSignedDownloadUrl: StorageService["getSignedDownloadUrl"] = (...args) =>
    this.inner.getSignedDownloadUrl(...args);
  publicUrl: StorageService["publicUrl"] = (key) => this.inner.publicUrl(key);
  getObject: StorageService["getObject"] = (key) => this.inner.getObject(key);
  delete(key: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    this.starts.push({ key, at: performance.now() });
    const gate = this.gates.get(key);
    const work = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const before = gate === undefined ? Promise.resolve() : gate();
          before
            .then(() => this.inner.delete(key))
            .then(() => {
              this.events.push(`done:${key}`);
              resolve();
            }, reject);
        },
        this.delays.get(key) ?? this.delayMs,
      );
      options.signal?.addEventListener(
        "abort",
        () => {
          this.events.push(`abort:${key}`);
          if (!this.honorAbort) return;
          clearTimeout(timer);
          this.aborted.push(key);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    this.pending.push(work.catch(() => undefined));
    return work;
  }
  settled(): Promise<unknown> {
    return Promise.all(this.pending);
  }
}

describe("bounded runs", () => {
  it("stops starting new work once the time budget is used up, and says so", async () => {
    const ctx = await createTenant(system);
    // A video whose files were deleted long ago: due for the metadata purge.
    const old = await seedVideo(ctx, daysAgo(60), ["VIDEO"]);
    const firstRun = new Date(old.video.expiresAt.getTime() + HOUR);
    await runVideoRetention(deps(), { now: firstRun });
    const now = new Date(firstRun.getTime() + METADATA_RETENTION_MS + HOUR);

    const slow = new SlowStorage(storage, 60);
    for (let i = 0; i < 5; i += 1) await seedVideo(ctx, daysAgo(40), ["VIDEO"], slow);
    const startedAt = performance.now();
    const result = await runVideoRetention(deps({ storage: slow }), { now, timeBudgetMs: 150 });

    expect(result.stoppedAtDeadline).toBe(true);
    expect(result.deletion.claimed).toBeGreaterThan(0);
    expect(result.deletion.claimed).toBeLessThan(5);
    expect(result.deletion.deleted + result.deletion.failed + result.deletion.interrupted).toBe(
      result.deletion.claimed,
    );
    // No delete started after the budget ran out (small allowance for timer jitter).
    for (const start of slow.starts) expect(start.at - startedAt).toBeLessThan(150 + 20);
    // Nothing beyond what was claimed was touched, and the purge did not start.
    expect(await system.generatedVideo.count({ where: { status: "DELETING" } })).toBe(
      result.deletion.interrupted,
    );
    expect(await system.generatedVideo.count({ where: { status: "AVAILABLE" } })).toBe(
      5 - result.deletion.claimed,
    );
    expect(result.purged).toBe(0);
    expect(await system.generatedVideo.count({ where: { id: old.video.id } })).toBe(1);
    await slow.settled();

    // The next run (no budget) finishes the rest, including the purge.
    const next = await runVideoRetention(deps({ storage: slow }), {
      now: new Date(now.getTime() + 11 * 60 * 1000),
    });
    expect(next.stoppedAtDeadline).toBe(false);
    expect(next.purged).toBe(1);
    expect(await system.generatedVideo.count({ where: { status: { not: "DELETED" } } })).toBe(0);
    for (const row of await system.generatedVideo.findMany()) {
      expect(await auditOf("video.files_deleted", row.id)).toHaveLength(1);
    }
  });

  it("never reports a timed-out storage delete as success, and retries it later", async () => {
    const ctx = await createTenant(system);
    for (const honorAbort of [true, false]) {
      const slow = new SlowStorage(storage, 0, honorAbort);
      const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO", "THUMBNAIL"], slow);
      const [videoKey, thumbKey] = keys as [string, string];
      slow.delays.set(thumbKey, 300); // longer than the 50 ms storage timeout
      const now = new Date(video.expiresAt.getTime() + HOUR);

      const first = await runVideoRetention(deps({ storage: slow }), {
        now,
        storageTimeoutMs: 50,
      });
      expect(first.deletion).toEqual({ claimed: 1, deleted: 0, failed: 1, interrupted: 0 });
      expect(first.stoppedAtDeadline).toBe(false);
      // Abort is reported only by an adapter that honoured it.
      expect(slow.aborted).toEqual(honorAbort ? [thumbKey] : []);
      const row = await system.generatedVideo.findUniqueOrThrow({
        where: { id: video.id },
        include: { files: true },
      });
      expect(row).toMatchObject({
        status: "DELETING",
        filesDeletedAt: null,
        lastDeletionError: "storage_delete_timeout",
      });
      expect(row.nextDeletionAttemptAt?.getTime()).toBe(now.getTime() + 5 * 60 * 1000);
      // Unconfirmed: the thumbnail stays un-tombstoned even if the hung delete lands later.
      expect(row.files.find((file) => file.storageKey === thumbKey)?.deletedAt).toBeNull();
      expect(row.files.find((file) => file.storageKey === videoKey)?.deletedAt).not.toBeNull();
      const [failure] = await auditOf("video.deletion_failed", video.id);
      expect(failure?.metadata).toMatchObject({ failedFiles: 0, timedOutFiles: 1 });
      await slow.settled();

      // After the backoff the delete is simply repeated (idempotent) and confirmed.
      slow.delays.delete(thumbKey);
      const retry = await runVideoRetention(deps({ storage: slow }), {
        now: new Date(now.getTime() + 5 * 60 * 1000),
        storageTimeoutMs: 50,
      });
      expect(retry.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
      expect(await storage.getObject(thumbKey)).toBeNull();
      expect(await auditOf("video.files_deleted", video.id)).toHaveLength(1);
    }
  });

  it("leases from the claim time: a later run cannot take a video another run is working on", async () => {
    const ctx = await createTenant(system);
    const slow = new SlowStorage(storage, 300);
    const { video } = await seedVideo(ctx, daysAgo(8), ["VIDEO"], slow);
    const runStart = new Date(video.expiresAt.getTime() + HOUR);
    // Run A started at runStart but claims the video 9 minutes into its run.
    const claimedAt = new Date(runStart.getTime() + 9 * 60 * 1000);
    const runA = runVideoRetention(deps({ storage: slow }), {
      now: runStart,
      clock: () => Promise.resolve(claimedAt),
    });
    while (slow.starts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const leased = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(leased.nextDeletionAttemptAt?.getTime()).toBe(claimedAt.getTime() + 10 * 60 * 1000);

    // Run B, 10 minutes after A started (a lease counted from A's start would be over).
    const runB = await runVideoRetention(deps({ storage: slow }), {
      now: new Date(runStart.getTime() + 10 * 60 * 1000),
    });
    expect(runB.deletion.claimed).toBe(0);
    expect((await runA).deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
    expect(slow.starts).toHaveLength(1);
    expect(await auditOf("video.files_deleted", video.id)).toHaveLength(1);
  });

  it("records no deletion failure for a video another run has claimed meanwhile", async () => {
    const ctx = await createTenant(system);
    const slow = new SlowStorage(storage, 0);
    const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO"], slow);
    const now = new Date(video.expiresAt.getTime() + HOUR);
    const otherLease = new Date(now.getTime() + 30 * 60 * 1000);
    // While this run's delete is in flight, another run claims the video (next attempt)
    // after this run's lease; then this run's delete fails.
    slow.gates.set(keys[0] ?? "", async () => {
      await system.generatedVideo.update({
        where: { id: video.id },
        data: { deletionAttempts: { increment: 1 }, nextDeletionAttemptAt: otherLease },
      });
      throw new Error("simulated storage outage");
    });

    const result = await runVideoRetention(deps({ storage: slow }), { now });
    expect(result.deletion).toEqual({ claimed: 1, deleted: 0, failed: 1, interrupted: 0 });
    expect(await auditOf("video.deletion_failed", video.id)).toHaveLength(0);
    // The other run's claim is left as it was.
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(row).toMatchObject({ status: "DELETING", deletionAttempts: 2, lastDeletionError: null });
    expect(row.nextDeletionAttemptAt?.getTime()).toBe(otherLease.getTime());
  });

  it("records deletion times on the database clock, only after storage confirmed them", async () => {
    const ctx = await createTenant(system);
    const slow = new SlowStorage(storage, 150);
    const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO", "THUMBNAIL"], slow);
    const [videoKey, thumbKey] = keys as [string, string];
    const before = await databaseNow(system);

    // No injected instant: the production path (database clock at each step).
    const result = await runVideoRetention(deps({ storage: slow }));
    expect(result.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
    const row = await system.generatedVideo.findUniqueOrThrow({
      where: { id: video.id },
      include: { files: true },
    });
    const deletedAt = (key: string) =>
      row.files.find((file) => file.storageKey === key)?.deletedAt?.getTime() ?? 0;
    // Each 150 ms delete finished before its tombstone; the video's last.
    expect(deletedAt(videoKey) - before.getTime()).toBeGreaterThanOrEqual(140);
    expect(deletedAt(thumbKey) - deletedAt(videoKey)).toBeGreaterThanOrEqual(140);
    expect(row.filesDeletedAt?.getTime()).toBeGreaterThanOrEqual(deletedAt(thumbKey));
    // The lease was taken at the claim, before any delete finished.
    const [audit] = await auditOf("video.files_deleted", video.id);
    expect(audit?.metadata).toMatchObject({ filesDeleted: 2, attempts: 1 });
  });

  it("hands unsent reminders back when the time budget runs out", async () => {
    const ctx = await createTenant(system);
    const succeededAt = new Date(Date.now() - 140 * HOUR);
    const first = await seedVideo(ctx, succeededAt, ["VIDEO"]);
    await seedVideo(ctx, succeededAt, ["VIDEO"]);
    const now = new Date(first.video.expiresAt.getTime() - 10 * HOUR); // both in the 24 h window
    // Each email takes 100 ms; the budget runs out during the first one.
    const slowMailer: Mailer = {
      transport: mailer.transport,
      send: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return mailer.send(message);
      },
    };
    const result = await runVideoRetention(deps({ mailer: slowMailer }), {
      now,
      timeBudgetMs: 50,
    });
    expect(result).toMatchObject({
      stoppedAtDeadline: true,
      purged: 0,
      deletion: { claimed: 0 },
    });
    expect(result.reminders.sent).toBe(1);
    expect(mailer.outbox).toHaveLength(1);
    // The second claim was handed back, not lost.
    expect(await system.generatedVideo.count({ where: { reminder24hAt: null } })).toBe(1);
    const next = await runVideoRetention(deps(), { now });
    expect(next.reminders.sent).toBe(1);
    expect(mailer.outbox).toHaveLength(2);
    expect(await system.generatedVideo.count({ where: { reminder24hAt: null } })).toBe(0);
  });

  it("starts no claim after the deadline, even when reading the clock takes longer", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(8), ["VIDEO"]);
    const now = new Date(video.expiresAt.getTime() + HOUR);
    // The deadline passes while the run is reading the clock for its first claim.
    const slowClock = async () => {
      await sleep(100);
      return now;
    };
    const result = await runVideoRetention(deps(), { now, clock: slowClock, timeBudgetMs: 50 });
    expect(result).toMatchObject({
      stoppedAtDeadline: true,
      deletion: { claimed: 0, deleted: 0, failed: 0, interrupted: 0 },
    });
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(row).toMatchObject({
      status: "AVAILABLE",
      deletionAttempts: 0,
      nextDeletionAttemptAt: null,
    });
  });

  it("never lets deadline interruptions alone raise the repeated-failure alert", async () => {
    const ctx = await createTenant(system);
    const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO", "THUMBNAIL"]);
    const now = new Date(video.expiresAt.getTime() + 2 * HOUR);
    // Looking up the video's files takes 60 ms, so a 30 ms budget always runs out after
    // the claim and before the first delete: an interruption with no work done.
    const slowLookups = withSlowFileLookups(db, 60);
    for (let run = 0; run < DELETION_ALERT_ATTEMPTS + 2; run += 1) {
      const result = await runVideoRetention(deps({ db: slowLookups }), {
        now,
        timeBudgetMs: 30,
      });
      expect(result.deletion).toEqual({ claimed: 1, deleted: 0, failed: 0, interrupted: 1 });
      const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
      // The claim was handed back: no attempt counted, no lease, no backoff, no audit.
      expect(row).toMatchObject({ deletionAttempts: 0, nextDeletionAttemptAt: null });
      expect((await measureRetentionBacklog(system, now)).alerting).toBe(0);
    }
    expect(await auditOf("video.deletion_failed", video.id)).toHaveLength(0);
    for (const key of keys) expect(await storage.getObject(key)).not.toBeNull();

    // The next run without the deadline deletes it, as its first counted attempt.
    const done = await runVideoRetention(deps(), { now });
    expect(done.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
    const [audit] = await auditOf("video.files_deleted", video.id);
    expect(audit?.metadata).toMatchObject({ attempts: 1 });
  });

  it("still counts genuine failures and timeouts, and alerts on repeated ones", async () => {
    const ctx = await createTenant(system);
    const recording = new RecordingStorage(storage);
    const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO"], recording);
    recording.failures.set(keys[0] ?? "", 100);
    let now = new Date(video.expiresAt.getTime() + HOUR);
    for (let attempt = 1; attempt <= DELETION_ALERT_ATTEMPTS; attempt += 1) {
      const result = await runVideoRetention(deps({ storage: recording }), { now });
      expect(result.deletion).toEqual({ claimed: 1, deleted: 0, failed: 1, interrupted: 0 });
      const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
      expect(row.deletionAttempts).toBe(attempt);
      now = row.nextDeletionAttemptAt ?? now; // run again once the backoff is over
    }
    const backlog = await measureRetentionBacklog(system, now);
    expect(backlog.alerting).toBe(1);
    expect(retentionRunSeverity({ deletionFailed: 1, backlog, now })).toBe("error");
    const failures = await auditOf("video.deletion_failed", video.id);
    expect(failures).toHaveLength(DELETION_ALERT_ATTEMPTS);
    expect(failures.at(-1)?.metadata).toMatchObject({ alert: true });

    // A timeout followed by the deadline in the same attempt is a genuine failure too.
    const slow = new SlowStorage(storage, 0, false);
    const other = await seedVideo(ctx, daysAgo(8), ["VIDEO", "THUMBNAIL"], slow);
    slow.delays.set(other.keys[0] ?? "", 200);
    const at = new Date(other.video.expiresAt.getTime() + HOUR);
    const result = await runVideoRetention(deps({ storage: slow }), {
      now: at,
      timeBudgetMs: 20,
      storageTimeoutMs: 40,
    });
    expect(result).toMatchObject({
      stoppedAtDeadline: true,
      deletion: { claimed: 1, deleted: 0, failed: 1, interrupted: 0 },
    });
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: other.video.id } });
    expect(row).toMatchObject({
      status: "DELETING",
      deletionAttempts: 1,
      lastDeletionError: "storage_delete_timeout",
    });
    expect(await auditOf("video.deletion_failed", other.video.id)).toHaveLength(1);
    await slow.settled();
  });

  it("never records an uncertain delete as confirmed when storage finishes as the timeout fires", async () => {
    // Deterministic ordering, not timing luck: only setTimeout/clearTimeout are faked
    // (database I/O stays real). Once storage has been called, both timers — the job's
    // timeout and the storage's completion — exist on the fake clock; advancing it fires
    // them in time order, equal times in creation order (the job's timer is armed first),
    // and settles promises between them. So timeout − 1 ms always settles first, and
    // exactly the timeout always completes immediately after the timeout fired.
    const ctx = await createTenant(system);
    const timeoutMs = 40;
    const cases = [
      { name: "storage settles just before", delay: timeoutMs - 1, honorAbort: true },
      { name: "storage settles just before", delay: timeoutMs - 1, honorAbort: false },
      { name: "timeout fires first; the abort stops storage", delay: timeoutMs, honorAbort: true },
      {
        name: "timeout fires first; storage finishes just after",
        delay: timeoutMs,
        honorAbort: false,
      },
    ] as const;
    const outcomes: string[] = [];
    for (const { name, delay, honorAbort } of cases) {
      const slow = new SlowStorage(storage, delay, honorAbort);
      const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO"], slow);
      const key = keys[0] ?? "";
      const now = new Date(video.expiresAt.getTime() + HOUR);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let result: Awaited<ReturnType<typeof runVideoRetention>>;
      try {
        const running = runVideoRetention(deps({ storage: slow }), {
          now,
          storageTimeoutMs: timeoutMs,
        });
        // Real I/O until storage is called (setImmediate is not faked).
        while (slow.starts.length === 0) await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(timeoutMs);
        result = await running;
      } finally {
        vi.useRealTimers();
      }
      await slow.settled();
      const row = await system.generatedVideo.findUniqueOrThrow({
        where: { id: video.id },
        include: { files: true },
      });
      const stored = (await storage.getObject(key)) !== null;
      const tombstoned = row.files[0]?.deletedAt !== null;
      // In every case: never a tombstone or DELETED while the object may still exist.
      if (stored) {
        expect({ name, tombstoned }).toEqual({ name, tombstoned: false });
        expect(row.status).not.toBe("DELETED");
      }

      if (delay < timeoutMs) {
        // Storage confirmed before the timeout: a real, recorded deletion; no abort.
        expect(slow.events).toEqual([`done:${key}`]);
        expect(result.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
        expect({ stored, tombstoned, status: row.status }).toEqual({
          stored: false,
          tombstoned: true,
          status: "DELETED",
        });
        outcomes.push("confirmed");
        continue;
      }
      // The timeout won: the outcome is unknown, so nothing is recorded as deleted.
      expect(result.deletion).toEqual({ claimed: 1, deleted: 0, failed: 1, interrupted: 0 });
      expect(row).toMatchObject({
        status: "DELETING",
        filesDeletedAt: null,
        lastDeletionError: "storage_delete_timeout",
      });
      expect(tombstoned).toBe(false);
      if (honorAbort) {
        // Aborted in time: storage never deleted the object.
        expect(slow.events).toEqual([`abort:${key}`]);
        expect(stored).toBe(true);
      } else {
        // Storage finished right after the timeout: the object is gone, yet unconfirmed.
        expect(slow.events).toEqual([`abort:${key}`, `done:${key}`]);
        expect(stored).toBe(false);
      }
      outcomes.push(honorAbort ? "timeout-aborted" : "timeout-then-completed");
      // The retry after the backoff confirms the (repeated, harmless) delete.
      slow.delays.set(key, 0);
      const retry = await runVideoRetention(deps({ storage: slow }), {
        now: new Date(now.getTime() + 5 * 60 * 1000),
        storageTimeoutMs: timeoutMs,
      });
      expect(retry.deletion).toEqual({ claimed: 1, deleted: 1, failed: 0, interrupted: 0 });
      expect(await storage.getObject(key)).toBeNull();
    }
    // Every outcome actually occurred.
    expect(outcomes).toEqual([
      "confirmed",
      "confirmed",
      "timeout-aborted",
      "timeout-then-completed",
    ]);
  });
});

// ── bounded database clients (retention run) ─────────────────────────────────

describe("bounded database clients", () => {
  const url = process.env.DATABASE_URL ?? "";

  it("bound statements on their own pool only, not the application's", async () => {
    const bounded = createBoundedPrismaClient(url, {
      statementTimeoutMs: 200,
      connectionTimeoutMs: 1_000,
    });
    try {
      const show = (client: typeof system) =>
        client.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`;
      expect((await show(bounded))[0]?.statement_timeout).toBe("200ms");
      expect((await show(system))[0]?.statement_timeout).toBe("0");
      const started = performance.now();
      await expect(bounded.$executeRaw`SELECT pg_sleep(2)`).rejects.toThrow(/statement timeout/i);
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      await bounded.$disconnect();
    }
  });

  it("stop waiting for a pooled connection after the connection timeout", async () => {
    const bounded = createBoundedPrismaClient(url, {
      statementTimeoutMs: 5_000,
      connectionTimeoutMs: 200,
      maxConnections: 1,
    });
    try {
      await bounded.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`; // the only connection is now held
          const started = performance.now();
          await expect(bounded.$queryRaw`SELECT 1`).rejects.toThrow();
          expect(performance.now() - started).toBeLessThan(1_500);
        },
        { timeout: 10_000 },
      );
    } finally {
      await bounded.$disconnect();
    }
  });

  it("fail a timed-out retention statement safely: nothing is recorded as deleted", async () => {
    const bounded = createBoundedPrismaClient(url, {
      statementTimeoutMs: 300,
      connectionTimeoutMs: 1_000,
    });
    try {
      const ctx = await createTenant(system);
      const { video, keys } = await seedVideo(ctx, daysAgo(8), ["VIDEO"]);
      const file = await system.generatedVideoFile.findFirstOrThrow({
        where: { videoId: video.id },
      });
      const now = new Date(video.expiresAt.getTime() + HOUR);
      // Another session holds the file row, so the tombstone UPDATE waits until its
      // statement timeout cancels it.
      const result = await system.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "generated_video_files" WHERE "id" = ${file.id}::uuid FOR UPDATE`;
          return runVideoRetention(deps({ system: bounded, db: createGuardedClient(bounded) }), {
            now,
          });
        },
        { timeout: 20_000 },
      );
      expect(result.deletion).toEqual({ claimed: 1, deleted: 0, failed: 1, interrupted: 0 });
      // Storage did delete the object, but the database never claims it: the file is not
      // tombstoned and the video is not DELETED; the next attempt repeats the delete.
      expect(await storage.getObject(keys[0] ?? "")).toBeNull();
      const row = await system.generatedVideo.findUniqueOrThrow({
        where: { id: video.id },
        include: { files: true },
      });
      expect(row).toMatchObject({
        status: "DELETING",
        filesDeletedAt: null,
        lastDeletionError: "storage_delete_failed",
      });
      expect(row.files[0]?.deletedAt).toBeNull();
      const retry = await runVideoRetention(deps(), {
        now: new Date(now.getTime() + 5 * 60 * 1000),
      });
      expect(retry.deletion).toMatchObject({ deleted: 1 });
    } finally {
      await bounded.$disconnect();
    }
  });
});

// ── reminders ────────────────────────────────────────────────────────────────

describe("reminders", () => {
  const sentTo = (box: MemoryMailer) =>
    box.outbox.map((mail) => {
      const message = mail.message as Extract<MailMessage, { template: "video_expiry_reminder" }>;
      return { to: mail.to, hours: message.data.hoursLeft, url: message.data.url };
    });

  it("sends one 48 h and one 24 h reminder to the requester, with the workspace link", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    const at = (hoursBefore: number) => new Date(video.expiresAt.getTime() - hoursBefore * HOUR);

    expect((await runVideoRetention(deps(), { now: at(49) })).reminders.sent).toBe(0);
    await runVideoRetention(deps(), { now: at(48) });
    await runVideoRetention(deps(), { now: at(47) }); // duplicate run: no second email
    await runVideoRetention(deps(), { now: at(24) });
    await runVideoRetention(deps(), { now: at(1) });

    const user = await system.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const mails = sentTo(mailer);
    expect(mails.map((mail) => mail.hours)).toEqual([48, 24]);
    expect(mails.every((mail) => mail.to === user.email)).toBe(true);
    expect(mails[0]?.url).toBe(`${APP_URL}/ar/w/${ctx.slug}/ai/videos`);
    const audits = await auditOf("video.expiry_reminder", video.id);
    expect(audits.map((audit) => (audit.metadata as { hours: number }).hours)).toEqual([48, 24]);
    expect(JSON.stringify(audits.map((audit) => audit.metadata))).not.toContain("@");
  });

  it("sends only the 24 h reminder when the 48 h window was missed, and none after expiry", async () => {
    const ctx = await createTenant(system);
    const late = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    // Expires two days before `late`: already past deletion at the run below.
    const gone = await seedVideo(ctx, daysAgo(3), ["VIDEO"]);
    await runVideoRetention(deps(), { now: new Date(late.video.expiresAt.getTime() - 2 * HOUR) });
    expect(sentTo(mailer).map((mail) => mail.hours)).toEqual([24]);
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: late.video.id } });
    expect(row.reminder48hAt).not.toBeNull();
    const expired = await system.generatedVideo.findUniqueOrThrow({ where: { id: gone.video.id } });
    expect(expired).toMatchObject({ reminder48hAt: null, reminder24hAt: null, status: "DELETED" });
  });

  it("retries a reminder whose email failed, while the window is open", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    const failing: Mailer = {
      transport: "flaky",
      send: () => Promise.reject(new Error("smtp down")),
    };
    const now = new Date(video.expiresAt.getTime() - 30 * HOUR);
    const failed = await runVideoRetention(deps({ mailer: failing }), { now });
    expect(failed.reminders).toMatchObject({ failed: 1, sent: 0 });
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(row.reminder48hAt).toBeNull();

    const ok = await runVideoRetention(deps(), { now: new Date(now.getTime() + HOUR) });
    expect(ok.reminders.sent).toBe(1);
  });

  it("does nothing without an email provider, and skips former members", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    const now = new Date(video.expiresAt.getTime() - 30 * HOUR);
    const none: Mailer = { transport: "none", send: () => Promise.reject(new Error("no")) };
    const unsupported = await runVideoRetention(deps({ mailer: none }), { now });
    expect(unsupported.reminders).toEqual({ supported: false, sent: 0, skipped: 0, failed: 0 });
    expect(
      (await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } })).reminder48hAt,
    ).toBeNull();

    await system.workspaceMember.deleteMany({ where: { workspaceId: ctx.workspaceId } });
    const skipped = await runVideoRetention(deps(), { now });
    expect(skipped.reminders).toMatchObject({ sent: 0, skipped: 1 });
    expect(mailer.outbox).toHaveLength(0);
    const [audit] = await auditOf("video.expiry_reminder", video.id);
    expect(audit?.metadata).toMatchObject({ outcome: "no_recipient" });
  });
});

// ── hardening ────────────────────────────────────────────────────────────────

describe("hardening", () => {
  it("timestamps with the database clock even late in a long transaction", async () => {
    const ctx = await createTenant(system);
    const created = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_sleep(1.5)`;
        return recordGeneratedVideo(tx, ctx, {
          title: "Slow pipeline",
          provider: "fake",
          durationSeconds: 4,
          width: 1280,
          height: 720,
          storageProvider: "LEGACY_S3",
          files: [
            {
              kind: "VIDEO",
              storageKey: buildWorkspaceKey(ctx.workspaceId, "generated-videos", "video/mp4"),
              contentType: "video/mp4",
              byteSize: 1,
            },
          ],
        });
      },
      { timeout: 10_000 },
    );
    expect(created.expiresAt.getTime() - created.succeededAt.getTime()).toBe(VIDEO_RETENTION_MS);
  });

  it("refuses files for a video that is being or has been deleted", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(8), ["VIDEO"]);
    await runVideoRetention(deps(), { now: new Date() });
    await expect(
      system.generatedVideoFile.create({
        data: {
          workspaceId: ctx.workspaceId,
          videoId: video.id,
          kind: "DERIVATIVE",
          storageKey: buildWorkspaceKey(ctx.workspaceId, "generated-videos", "video/mp4"),
          contentType: "video/mp4",
          byteSize: 1,
          storageProvider: "LEGACY_S3",
        },
      }),
    ).rejects.toThrow();
  });

  it("never drops a record whose stored objects have not been deleted", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    await expect(system.generatedVideo.delete({ where: { id: video.id } })).rejects.toThrow();
    await expect(
      system.generatedVideoFile.deleteMany({ where: { videoId: video.id } }),
    ).rejects.toThrow();
    // A workspace hard delete would cascade to the video: it is refused too.
    await expect(
      system.$executeRaw`DELETE FROM workspaces WHERE id = ${ctx.workspaceId}::uuid`,
    ).rejects.toThrow();
    expect(await system.generatedVideo.count({ where: { id: video.id } })).toBe(1);
  });

  it("refuses downloads by the database clock when no instant is given", async () => {
    const ctx = await createTenant(system);
    const expired = await seedVideo(ctx, daysAgo(8), ["VIDEO"]);
    const fresh = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    await expect(
      readGeneratedVideoFile(db, onProvider(storage), ctx, expired.video.id, "VIDEO"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await readGeneratedVideoFile(db, onProvider(storage), ctx, fresh.video.id, "VIDEO"))
        .filename,
    ).toBe("Launch teaser.mp4");
  });

  it("lists every video whose files still exist, soonest deletion first, then recent deletions", async () => {
    const ctx = await createTenant(system);
    const gone = await seedVideo(ctx, daysAgo(9), ["VIDEO"]);
    await runVideoRetention(deps(), { now: new Date() });
    const later = await seedVideo(ctx, daysAgo(1), ["VIDEO", "THUMBNAIL"]);
    const sooner = await seedVideo(ctx, daysAgo(4), ["VIDEO"]);
    const listed = await listGeneratedVideos(db, ctx);
    expect(listed.map((video) => video.id)).toEqual([
      sooner.video.id,
      later.video.id,
      gone.video.id,
    ]);
    expect(listed[1]?.hasThumbnail).toBe(true);
    expect((await listGeneratedVideos(db, ctx, { deletedLimit: 0 })).map((v) => v.id)).toEqual([
      sooner.video.id,
      later.video.id,
    ]);
    expect(await countVideosExpiringWithin(db, ctx, 48, new Date())).toBe(0);
    expect(
      await countVideosExpiringWithin(
        db,
        ctx,
        48,
        new Date(sooner.video.expiresAt.getTime() - HOUR),
      ),
    ).toBe(1);
  });

  it("sends no reminder emails unless they are explicitly enabled", async () => {
    const ctx = await createTenant(system);
    const { video } = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    const now = new Date(video.expiresAt.getTime() - 30 * HOUR);
    const off = await runVideoRetention(deps({ remindersEnabled: false }), { now });
    expect(off.reminders).toEqual({ supported: false, sent: 0, skipped: 0, failed: 0 });
    expect(mailer.outbox).toHaveLength(0);
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(row.reminder48hAt).toBeNull();
  });

  it("formats the reminder in the default zone when the workspace zone is invalid", async () => {
    const ctx = await createTenant(system);
    await system.workspace.update({
      where: { id: ctx.workspaceId },
      data: { timezone: "Mars/Olympus_Mons" },
    });
    const { video } = await seedVideo(ctx, daysAgo(1), ["VIDEO"]);
    const result = await runVideoRetention(deps(), {
      now: new Date(video.expiresAt.getTime() - 30 * HOUR),
    });
    expect(result.reminders).toMatchObject({ sent: 1, failed: 0 });
  });
});
