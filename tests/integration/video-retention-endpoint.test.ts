// The scheduler-facing endpoint POST /api/internal/video-retention: disabled without a
// secret, indistinguishable 404 for a wrong token, one real run with the right one, and
// the approved limit of 12 authorized requests per 10 minutes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbClient from "@/server/db/client";
import type { Logger } from "@/server/logger";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const SECRET = ["retention", "secret", "for", "tests", "0123456789abcdef"].join("-");
const { system } = createTestDb();

beforeAll(() => {
  vi.stubEnv("STORAGE_DRIVER", "test-memory");
  // The rate limiter runs through Better Auth, which needs a valid AUTH_SECRET (as in
  // auth-entry-points.test.ts); the local .env may hold a short placeholder.
  vi.stubEnv("AUTH_SECRET", "video-retention-endpoint-test-auth-secret-0123456789");
});

beforeEach(async () => {
  await resetDatabase(system);
  vi.resetModules();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await system.$disconnect();
});

async function call(method: "POST" | "GET", authorization?: string) {
  const route = await import("@/app/api/internal/video-retention/route");
  const init: RequestInit =
    authorization === undefined ? { method } : { method, headers: { authorization } };
  const request = new Request("http://localhost:3000/api/internal/video-retention", init);
  return method === "POST" ? route.POST(request) : route.GET(request);
}
const post = (authorization?: string) => call("POST", authorization);

async function seedExpired(workspaceId: string, daysAgo = 8) {
  return system.generatedVideo.create({
    data: {
      workspaceId,
      title: "Expired",
      provider: "fake",
      durationSeconds: 4,
      width: 1,
      height: 1,
      succeededAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    },
  });
}

describe("POST /api/internal/video-retention", () => {
  it("is a 404 when no secret is configured", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", "");
    expect((await post(`Bearer ${SECRET}`)).status).toBe(404);
  });

  it("is the same 404 for a missing or wrong token", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    expect((await post()).status).toBe(404);
    expect((await post("Bearer wrong-token-wrong-token-wrong-token")).status).toBe(404);
  });

  it("runs the job with the right token and returns counts only", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    const ctx = await createTenant(system);
    await seedExpired(ctx.workspaceId);
    const response = await post(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "completed",
      reminders: { supported: false },
      deletion: { claimed: 1, deleted: 1, failed: 0 },
      purged: 0,
      backlog: { overdue: 0, oldestOverdueExpiresAt: null, alerting: 0 },
    });
    expect(JSON.stringify(body)).not.toContain(ctx.workspaceId);
    const row = await system.generatedVideo.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(row.status).toBe("DELETED");
  });

  it("is single flight: a call while another run holds the lock is skipped and changes nothing", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    const { RETENTION_LOCK_KEY } = await import("@/server/videos/retention-runtime");
    const ctx = await createTenant(system);
    const video = await seedExpired(ctx.workspaceId);
    const body = await system.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RETENTION_LOCK_KEY}::bigint)`;
        const response = await post(`Bearer ${SECRET}`);
        expect(response.status).toBe(200);
        return (await response.json()) as Record<string, unknown>;
      },
      { timeout: 20_000 },
    );
    expect(body).toMatchObject({
      status: "skipped",
      reason: "already_running",
      backlog: { overdue: 1, alerting: 0 },
    });
    expect(
      (await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } })).status,
    ).toBe("AVAILABLE");
    // Lock released: the next call runs.
    expect(await (await post(`Bearer ${SECRET}`)).json()).toMatchObject({ status: "completed" });
  });

  it("takes its lock and runs entirely on the bounded retention pool, never the application pool", async () => {
    // The application pool's accessors throw for this test: if the lock, the job or the
    // backlog read used them, the run would fail.
    vi.doMock("@/server/db/client", async (importOriginal) => {
      const actual = await importOriginal<typeof DbClient>();
      const forbidden = () => {
        throw new Error("the retention run used the application pool");
      };
      return { ...actual, getDb: forbidden, getSystemDb: forbidden };
    });
    try {
      const { runScheduledVideoRetention } = await import("@/server/videos/retention-runtime");
      const { getBoundedRetentionDb } = await import("@/server/db/client");
      const { RETENTION_STATEMENT_TIMEOUT_MS, RETENTION_CONNECT_TIMEOUT_MS } =
        await import("@/server/videos/retention-policy");
      const ctx = await createTenant(system);
      const video = await seedExpired(ctx.workspaceId);
      const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const summary = await runScheduledVideoRetention(quiet as unknown as Logger);
      expect(summary).toMatchObject({ status: "completed", deletion: { claimed: 1, deleted: 1 } });
      expect(
        (await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } })).status,
      ).toBe("DELETED");
      // ...and that pool's sessions carry the 3 s statement timeout.
      const pool = getBoundedRetentionDb({
        statementTimeoutMs: RETENTION_STATEMENT_TIMEOUT_MS,
        connectionTimeoutMs: RETENTION_CONNECT_TIMEOUT_MS,
      });
      const [setting] = await pool.system.$queryRaw<{ statement_timeout: string }[]>`
        SHOW statement_timeout`;
      expect(setting?.statement_timeout).toBe(`${RETENTION_STATEMENT_TIMEOUT_MS / 1000}s`);
    } finally {
      vi.doUnmock("@/server/db/client");
    }
  });

  it("reports a run that reached its time budget as partial, never as completed", async () => {
    const { runScheduledVideoRetention } = await import("@/server/videos/retention-runtime");
    const ctx = await createTenant(system);
    // Expired 30 min ago: not yet overdue, so the deadline is the only reason to warn.
    const video = await seedExpired(ctx.workspaceId, 7 + 0.5 / 24);
    const lines: { level: string; fields: Record<string, unknown> }[] = [];
    const record = (level: string) => (fields: Record<string, unknown>) => {
      lines.push({ level, fields });
    };
    const logger = {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    } as unknown as Logger;
    // Test-only budget of 0: out of time before any new work starts.
    const summary = await runScheduledVideoRetention(logger, { timeBudgetMs: 0 });
    expect(summary).toMatchObject({
      status: "partial",
      reason: "deadline",
      deletion: { claimed: 0, deleted: 0, failed: 0, interrupted: 0 },
      purged: 0,
    });
    expect(lines).toEqual([
      { level: "warn", fields: expect.objectContaining({ severity: "warn" }) as unknown },
    ]);
    expect(
      (await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } })).status,
    ).toBe("AVAILABLE");
    // The normal budget completes the same work.
    expect(await runScheduledVideoRetention(logger)).toMatchObject({
      status: "completed",
      deletion: { claimed: 1, deleted: 1 },
    });
  });
});

describe("storage provider unavailable", () => {
  it("is never reported as completed: 503, status storage_unavailable, error severity", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    vi.stubEnv("WASABI_ACCESS_KEY_ID", "");
    vi.stubEnv("WASABI_SECRET_ACCESS_KEY", "");
    await system.$executeRaw`DELETE FROM platform_storage_settings`;
    const ctx = await createTenant(system);
    const video = await seedExpired(ctx.workspaceId);
    // A file recorded on Wasabi, which is not configured (no settings, no keys).
    await system.generatedVideoFile.create({
      data: {
        workspaceId: ctx.workspaceId,
        videoId: video.id,
        kind: "VIDEO",
        storageKey: `workspaces/${ctx.workspaceId}/generated-videos/00000000-0000-4000-8000-000000000001.mp4`,
        storageProvider: "WASABI",
        contentType: "video/mp4",
        byteSize: 1,
      },
    });
    const response = await post(`Bearer ${SECRET}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "storage_unavailable",
      reason: "storage_provider_unavailable",
      storageUnavailableFiles: 1,
      deletion: { claimed: 1, deleted: 0, failed: 1, interrupted: 0 },
    });
    // Retried later, never deleted elsewhere, never marked deleted.
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(row).toMatchObject({
      status: "DELETING",
      lastDeletionError: "storage_provider_unavailable",
    });

    // The run's log line is graded error (operator action needed now).
    const { runScheduledVideoRetention } = await import("@/server/videos/retention-runtime");
    await system.generatedVideo.update({
      where: { id: video.id },
      data: { nextDeletionAttemptAt: null },
    });
    const lines: { level: string; message: unknown }[] = [];
    const record = (level: string) => (_fields: unknown, message: unknown) => {
      lines.push({ level, message });
    };
    const logger = {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    } as unknown as Logger;
    expect(await runScheduledVideoRetention(logger)).toMatchObject({
      status: "storage_unavailable",
    });
    // Per-file warnings from the job, then the run summary graded error.
    expect(lines.filter((line) => line.message === "video_retention.run")).toEqual([
      { level: "error", message: "video_retention.run" },
    ]);
  });
});

describe("GET /api/internal/video-retention (monitoring probe)", () => {
  it("reports the overdue backlog without changing anything, behind the same secret", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    expect((await call("GET")).status).toBe(404);
    const ctx = await createTenant(system);
    const video = await seedExpired(ctx.workspaceId, 9);
    await system.generatedVideo.update({
      where: { id: video.id },
      data: { status: "DELETING", deletionAttempts: 6 },
    });
    const response = await call("GET", `Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { backlog: Record<string, unknown> };
    expect(body.backlog).toMatchObject({ overdue: 1, alerting: 1 });
    expect(body.backlog.oldestOverdueExpiresAt).toBe(video.expiresAt.toISOString());
    expect(
      (await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } })).deletionAttempts,
    ).toBe(6);
  });
});

describe("rate limit: 12 requests per 10 minutes (approved)", () => {
  const AUTH = `Bearer ${SECRET}`;
  const WINDOW_MS = 10 * 60 * 1000;
  const bucketRow = () =>
    system.rateLimit.findFirstOrThrow({
      where: { key: { contains: "/flexibx/rate-limit/video-retention/" } },
    });

  it("allows 12 authorized requests (POST and GET combined), then answers 429 without running", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    for (let i = 0; i < 11; i += 1) expect((await call("GET", AUTH)).status).toBe(200);
    expect((await post(AUTH)).status).toBe(200); // 12th
    const ctx = await createTenant(system);
    const video = await seedExpired(ctx.workspaceId);
    const limited = await post(AUTH);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(JSON.stringify(body)).not.toMatch(/backlog|deletion|workspace/i);
    expect((await call("GET", AUTH)).status).toBe(429);
    // The limited POST did not run the job.
    expect(
      (await system.generatedVideo.findUniqueOrThrow({ where: { id: video.id } })).status,
    ).toBe("AVAILABLE");
  });

  it("checks the secret first: wrong or missing tokens are 404s and consume no quota", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    for (let i = 0; i < 30; i += 1) {
      expect(
        (await call("GET", i % 2 === 0 ? undefined : "Bearer wrong-wrong-wrong-wrong-wrong-wrong"))
          .status,
      ).toBe(404);
    }
    expect(await system.rateLimit.count({ where: { key: { contains: "video-retention" } } })).toBe(
      0,
    );
    for (let i = 0; i < 12; i += 1) expect((await call("GET", AUTH)).status).toBe(200);
    // Over the quota, a wrong token is still the same 404 (no 429 that would reveal the route).
    expect((await call("GET", "Bearer wrong-wrong-wrong-wrong-wrong-wrong")).status).toBe(404);
    expect((await call("GET", AUTH)).status).toBe(429);
  });

  it("is concurrency-safe: 20 simultaneous authorized requests let exactly 12 through", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () => call("GET", AUTH).then((response) => response.status)),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(12);
    expect(statuses.filter((status) => status === 429)).toHaveLength(8);
    expect((await bucketRow()).count).toBe(12);
  });

  it("stays limited inside the 10-minute window and resets once it has passed", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    for (let i = 0; i < 12; i += 1) expect((await call("GET", AUTH)).status).toBe(200);
    const row = await bucketRow();
    // Last allowed request 9 min 55 s ago: still inside the window.
    await system.rateLimit.update({
      where: { id: row.id },
      data: { lastRequest: BigInt(Date.now() - WINDOW_MS + 5_000) },
    });
    expect((await call("GET", AUTH)).status).toBe(429);
    // Last allowed request just over 10 minutes ago: the window has passed.
    await system.rateLimit.update({
      where: { id: row.id },
      data: { lastRequest: BigInt(Date.now() - WINDOW_MS - 1_000) },
    });
    expect((await call("GET", AUTH)).status).toBe(200);
    expect((await bucketRow()).count).toBe(1);
  });

  it("does not replace the single-flight lock: a skipped run still counts as one request", async () => {
    vi.stubEnv("VIDEO_RETENTION_CRON_SECRET", SECRET);
    const { RETENTION_LOCK_KEY } = await import("@/server/videos/retention-runtime");
    await system.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RETENTION_LOCK_KEY}::bigint)`;
        const response = await post(AUTH);
        expect(await response.json()).toMatchObject({ status: "skipped" });
      },
      { timeout: 20_000 },
    );
    expect((await bucketRow()).count).toBe(1);
  });
});
