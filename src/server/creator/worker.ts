import type { PrismaClient } from "@/generated/prisma/client";

import { recordJobFinished, recordJobStarted } from "../monitoring/heartbeat";

import type { CreatorDeps } from "./config";
import { processStorageDeletions } from "./deletions";
import { workOnce } from "./jobs";
import { sweepStaleWorkDirs } from "./media/workdir";
import { cleanupExpiredUploads } from "./project-service";

// The media worker loop (`pnpm creator:worker`): one job at a time per process (scale
// by running more processes; each claims with a lease). Between jobs it expires
// abandoned uploads and works through the storage-deletion queue; at start it removes
// scratch directories a crashed run left behind. It records a heartbeat
// (system_heartbeats `creator-worker`) so ops-status can tell when no worker is running.
// Stops between jobs when `signal` aborts; a job in progress keeps its lease until it
// ends or its lease expires (another worker then resumes it). Pure.

export interface WorkerOptions {
  readonly signal: AbortSignal;
  /** Wait between polls when nothing is due (default 5 s). */
  readonly pollMs?: number;
  /** How often abandoned uploads and queued storage deletions are processed (default 1 minute). */
  readonly cleanupEveryMs?: number;
  /** How often the heartbeat is written (default 1 minute). */
  readonly heartbeatEveryMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function runWorker(
  deps: CreatorDeps,
  system: PrismaClient,
  options: WorkerOptions,
): Promise<{ readonly jobs: number }> {
  const swept = await sweepStaleWorkDirs(deps.workDir);
  if (swept > 0) deps.logger?.info({ swept }, "Removed stale creator scratch directories");
  let jobs = 0;
  let lastCleanup = 0;
  let lastBeat = 0;
  let failedPhases: string[] = [];
  while (!options.signal.aborted) {
    if (Date.now() - lastBeat >= (options.heartbeatEveryMs ?? 60_000)) {
      lastBeat = Date.now();
      const now = new Date();
      // Best effort: a missed heartbeat never stops the worker.
      await recordJobStarted(system, "creator-worker", now)
        .then(() => recordJobFinished(system, "creator-worker", failedPhases, now))
        .catch(() => undefined);
      failedPhases = [];
    }
    if (Date.now() - lastCleanup >= (options.cleanupEveryMs ?? 60_000)) {
      lastCleanup = Date.now();
      try {
        const cleaned = await cleanupExpiredUploads(deps, system);
        if (cleaned > 0) deps.logger?.info({ cleaned }, "Expired abandoned creator uploads");
      } catch (error) {
        failedPhases.push("upload_cleanup");
        deps.logger?.error(
          { error: error instanceof Error ? error.name : "unknown" },
          "Upload cleanup failed",
        );
      }
      try {
        const swept = await processStorageDeletions(deps, system);
        if (swept.deleted + swept.failed + swept.purgedProjects > 0) {
          deps.logger?.info({ ...swept }, "Creator storage deletions processed");
        }
      } catch (error) {
        failedPhases.push("storage_deletions");
        deps.logger?.error(
          { error: error instanceof Error ? error.name : "unknown" },
          "Storage deletion sweep failed",
        );
      }
    }
    let worked;
    try {
      worked = await workOnce(deps, system);
    } catch (error) {
      deps.logger?.error(
        { error: error instanceof Error ? error.name : "unknown" },
        "Creator job crashed",
      );
      worked = null;
    }
    if (worked === null) {
      await sleep(options.pollMs ?? 5000, options.signal);
      continue;
    }
    jobs += 1;
    deps.logger?.info({ jobId: worked.jobId, status: worked.outcome.status }, "Creator job ended");
  }
  return { jobs };
}
