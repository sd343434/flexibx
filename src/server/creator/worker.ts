import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";

import type { PrismaClient } from "@/generated/prisma/client";

import { recordJobFinished, recordJobStarted } from "../monitoring/heartbeat";

import type { CreatorDeps } from "./config";
import { processStorageDeletions } from "./deletions";
import { SCRATCH_MARGIN_BYTES, workOnce } from "./jobs";
import { freeBytes } from "./media/files";
import { sweepStaleWorkDirs } from "./media/workdir";
import { cleanupExpiredUploads } from "./project-service";

// The media worker loop (`pnpm creator:worker`): one job at a time per process (scale
// by running more processes; each claims with a lease). Between jobs it expires
// abandoned uploads and works through the storage-deletion queue; at start it removes
// scratch directories a crashed run left behind. It records a heartbeat
// (system_heartbeats `creator-worker`) so ops-status can tell when no worker is running —
// from its own timer, so a long job (up to its 60-minute deadline) does not make a live
// worker look dead. Each beat also checks the scratch disk: less free space than the
// largest job needs is reported as the failed phase `disk_low`, with the clean-up phases
// that failed since the previous beat.
// When `signal` aborts (SIGTERM / SIGINT, a container stop) the job in progress is
// interrupted: its FFmpeg process is killed, its credit hold released and the job handed
// back to the queue for the next worker (a step whose paid provider outcome is unknown
// is not re-run: it fails as usual). Pure.

export interface WorkerOptions {
  readonly signal: AbortSignal;
  /** Wait between polls when nothing is due (default 5 s). */
  readonly pollMs?: number;
  /** How often abandoned uploads and queued storage deletions are processed (default 1 minute). */
  readonly cleanupEveryMs?: number;
  /** How often the heartbeat is written (default 1 minute). */
  readonly heartbeatEveryMs?: number;
  /**
   * Free scratch space below which the heartbeat reports `disk_low` (default: what the
   * largest allowed source needs — twice its size plus the step margin, as a job checks).
   */
  readonly minFreeBytes?: number;
  /**
   * Pass 42: whether FFmpeg can run now (the isolated media runner answers). While it says
   * no, the worker claims nothing — a job is not burnt through its attempts by a runner
   * that is down — and the heartbeat reports the failed phase `media_runner`.
   */
  readonly mediaReady?: () => Promise<boolean>;
}

// Ends early on abort and leaves no listener behind (Pass 42: the hand-made version kept
// one abort listener per poll, the leak Pass 41 fixed in the watchdog).
const sleep = (ms: number, signal: AbortSignal) =>
  wait(ms, undefined, { signal }).catch(() => undefined);

export async function runWorker(
  deps: CreatorDeps,
  system: PrismaClient,
  options: WorkerOptions,
): Promise<{ readonly jobs: number }> {
  const swept = await sweepStaleWorkDirs(deps.workDir);
  if (swept > 0) deps.logger?.info({ swept }, "Removed stale creator scratch directories");
  let jobs = 0;
  let lastCleanup = 0;
  const failedPhases = new Set<string>();
  const minFreeBytes =
    options.minFreeBytes ?? 2 * deps.limits.maxUploadBytes + SCRATCH_MARGIN_BYTES;
  let diskLow = false;
  let mediaReady = true;
  const beat = async () => {
    const failed = [...failedPhases];
    failedPhases.clear();
    const free = await freeBytes(deps.workDir ?? tmpdir()).catch(() => null);
    const low = free !== null && free < minFreeBytes;
    if (low) failed.push("disk_low");
    if (low !== diskLow) {
      diskLow = low;
      if (low) deps.logger?.warn({ freeBytes: free, minFreeBytes }, "Creator scratch disk low");
      else deps.logger?.info({ freeBytes: free }, "Creator scratch disk recovered");
    }
    const now = new Date();
    // Best effort: a missed heartbeat never stops the worker.
    await recordJobStarted(system, "creator-worker", now)
      .then(() => recordJobFinished(system, "creator-worker", failed, now))
      .catch(() => undefined);
  };
  const heartbeat = (async () => {
    while (!options.signal.aborted) {
      await beat().catch(() => undefined);
      await sleep(options.heartbeatEveryMs ?? 60_000, options.signal);
    }
  })();
  while (!options.signal.aborted) {
    if (Date.now() - lastCleanup >= (options.cleanupEveryMs ?? 60_000)) {
      lastCleanup = Date.now();
      try {
        const cleaned = await cleanupExpiredUploads(deps, system);
        if (cleaned > 0) deps.logger?.info({ cleaned }, "Expired abandoned creator uploads");
      } catch (error) {
        failedPhases.add("upload_cleanup");
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
        failedPhases.add("storage_deletions");
        deps.logger?.error(
          { error: error instanceof Error ? error.name : "unknown" },
          "Storage deletion sweep failed",
        );
      }
    }
    const ready = options.mediaReady === undefined ? true : await options.mediaReady();
    if (ready !== mediaReady) {
      mediaReady = ready;
      if (ready) deps.logger?.info({}, "Media runner reachable: claiming jobs again");
      else deps.logger?.error({}, "Media runner unreachable: no job is claimed until it answers");
    }
    if (!ready) {
      failedPhases.add("media_runner");
      await sleep(options.pollMs ?? 5000, options.signal);
      continue;
    }
    let worked;
    try {
      worked = await workOnce(deps, system, { shutdown: options.signal });
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
  await heartbeat;
  return { jobs };
}
