import { describe, expect, it } from "vitest";

import { AppError } from "@/server/errors/app-error";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import type { StorageProviderId, StorageRouter } from "@/server/storage/storage";
import {
  MAX_PROVIDER_RESOLUTIONS_PER_RUN,
  resolveProvidersForRun,
  type RetentionResult,
} from "@/server/videos/retention-job";
import { summarizeRetentionRun } from "@/server/videos/retention-runtime";

// Retention and storage providers, without a database: how one run resolves providers
// (transient failures are retried, configuration failures are not), and how a run that
// hit both a storage problem and its deadline is summarized.

/** A router whose answers per provider are scripted, counting every resolution. */
function scriptedRouter(script: Record<StorageProviderId, (() => unknown)[]>) {
  const calls: StorageProviderId[] = [];
  const service = new MemoryStorageService();
  const router: StorageRouter = {
    forProvider: (provider) => {
      calls.push(provider);
      const next = script[provider].shift();
      if (next === undefined) return Promise.resolve(service);
      try {
        next();
        return Promise.resolve(service);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { router, calls, service };
}

const transient = () => {
  throw new Error("Can't reach database server (timeout)");
};
const notConfigured = () => {
  throw new AppError("SERVICE_UNAVAILABLE", {
    message: "Storage provider is not configured",
    metadata: { provider: "WASABI", missing: ["credentials"] },
  });
};
const ok = () => undefined;

async function outcome(promise: Promise<unknown>): Promise<"ok" | "failed"> {
  return promise.then(
    () => "ok",
    () => "failed",
  );
}

describe("provider resolution within one retention run", () => {
  it("retries after a transient failure instead of failing every later file", async () => {
    const { router, calls, service } = scriptedRouter({ WASABI: [transient, ok], LEGACY_S3: [] });
    const storageFor = resolveProvidersForRun(router);
    expect(await outcome(storageFor("WASABI"))).toBe("failed"); // file 1: transient error
    expect(await storageFor("WASABI")).toBe(service); // file 2: resolved
    expect(await storageFor("WASABI")).toBe(service); // file 3: reused, no new round trip
    expect(calls).toEqual(["WASABI", "WASABI"]);
  });

  it("remembers a configuration failure for the rest of the run (one round trip)", async () => {
    const { router, calls } = scriptedRouter({ WASABI: [notConfigured, ok], LEGACY_S3: [] });
    const storageFor = resolveProvidersForRun(router);
    const results = [];
    for (let file = 0; file < 5; file += 1) results.push(await outcome(storageFor("WASABI")));
    expect(results).toEqual(["failed", "failed", "failed", "failed", "failed"]);
    expect(calls).toEqual(["WASABI"]);
  });

  it("caps repeated transient failures per provider and run", async () => {
    const { router, calls } = scriptedRouter({
      WASABI: Array.from({ length: 10 }, () => transient),
      LEGACY_S3: [],
    });
    const storageFor = resolveProvidersForRun(router);
    const results = [];
    for (let file = 0; file < 8; file += 1) results.push(await outcome(storageFor("WASABI")));
    expect(results.every((result) => result === "failed")).toBe(true);
    expect(calls).toHaveLength(MAX_PROVIDER_RESOLUTIONS_PER_RUN);
    expect(MAX_PROVIDER_RESOLUTIONS_PER_RUN).toBe(3);
  });

  it("keeps providers independent: one failing never affects another", async () => {
    const { router, calls, service } = scriptedRouter({
      WASABI: [notConfigured],
      LEGACY_S3: [],
    });
    const storageFor = resolveProvidersForRun(router);
    expect(await outcome(storageFor("WASABI"))).toBe("failed");
    expect(await storageFor("LEGACY_S3")).toBe(service);
    expect(await outcome(storageFor("WASABI"))).toBe("failed");
    expect(calls).toEqual(["WASABI", "LEGACY_S3"]);
  });

  it("starts fresh in every run (a remembered failure never outlives its run)", async () => {
    const { router, service } = scriptedRouter({ WASABI: [notConfigured], LEGACY_S3: [] });
    expect(await outcome(resolveProvidersForRun(router)("WASABI"))).toBe("failed");
    expect(await resolveProvidersForRun(router)("WASABI")).toBe(service);
  });
});

describe("retention run summary", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");
  const backlog = { overdue: 2, oldestOverdueExpiresAt: null, alerting: 0 };
  const result = (overrides: Partial<RetentionResult>): RetentionResult => ({
    now,
    stoppedAtDeadline: false,
    reminders: { supported: true, sent: 0, skipped: 0, failed: 0 },
    deletion: { claimed: 1, deleted: 0, failed: 1, interrupted: 0 },
    storageUnavailableFiles: 0,
    purged: 0,
    ...overrides,
  });

  it("keeps the deadline information when storage was also unavailable", () => {
    expect(
      summarizeRetentionRun(
        result({ storageUnavailableFiles: 2, stoppedAtDeadline: true }),
        now,
        backlog,
      ),
    ).toMatchObject({
      status: "storage_unavailable",
      reason: "storage_provider_unavailable",
      stoppedAtDeadline: true,
      storageUnavailableFiles: 2,
    });
    expect(
      summarizeRetentionRun(result({ storageUnavailableFiles: 2 }), now, backlog),
    ).toMatchObject({ status: "storage_unavailable", stoppedAtDeadline: false });
  });

  it("reports partial and completed runs as before, now with stoppedAtDeadline", () => {
    expect(summarizeRetentionRun(result({ stoppedAtDeadline: true }), now, backlog)).toMatchObject({
      status: "partial",
      reason: "deadline",
      stoppedAtDeadline: true,
    });
    const completed = summarizeRetentionRun(
      result({ deletion: { claimed: 1, deleted: 1, failed: 0, interrupted: 0 } }),
      now,
      backlog,
    );
    expect(completed).toMatchObject({ status: "completed", stoppedAtDeadline: false });
    expect(completed).not.toHaveProperty("reason");
  });

  it("a skipped run (lock held elsewhere) carries no run fields", () => {
    expect(summarizeRetentionRun(null, now, backlog)).toEqual({
      status: "skipped",
      reason: "already_running",
      now: now.toISOString(),
      backlog: { overdue: 2, oldestOverdueExpiresAt: null, alerting: 0 },
    });
  });
});
