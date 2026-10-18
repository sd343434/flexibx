import type { PrismaClient } from "@/generated/prisma/client";

import type { CreatorDeps } from "./config";
import { workOnce } from "./jobs";
import { sweepStaleWorkDirs } from "./media/workdir";
import { cleanupExpiredUploads } from "./project-service";

// The media worker loop (`pnpm creator:worker`): one job at a time per process (scale
// by running more processes; each claims with a lease). Between jobs it expires
// abandoned uploads; at start it removes scratch directories a crashed run left behind.
// Stops between jobs when `signal` aborts; a job in progress keeps its lease until it
// ends or its lease expires (another worker then resumes it). Pure.

export interface WorkerOptions {
  readonly signal: AbortSignal;
  /** Wait between polls when nothing is due (default 5 s). */
  readonly pollMs?: number;
  /** How often abandoned uploads are cleaned up (default 5 minutes). */
  readonly cleanupEveryMs?: number;
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
  while (!options.signal.aborted) {
    if (Date.now() - lastCleanup >= (options.cleanupEveryMs ?? 5 * 60_000)) {
      lastCleanup = Date.now();
      try {
        const cleaned = await cleanupExpiredUploads(deps, system);
        if (cleaned > 0) deps.logger?.info({ cleaned }, "Expired abandoned creator uploads");
      } catch (error) {
        deps.logger?.error(
          { error: error instanceof Error ? error.name : "unknown" },
          "Upload cleanup failed",
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
