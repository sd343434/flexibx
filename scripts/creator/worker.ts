// The Creator Studio media worker: claims queued jobs (analysis, transcription,
// translation, exports) with a lease and runs them with FFmpeg — never inside a web
// request. One job at a time per process; run more processes to scale.
//
//   pnpm creator:worker
//
// Needs the server environment (DATABASE_URL, storage, CREATOR_*) and FFmpeg/ffprobe on
// PATH (or CREATOR_FFMPEG_PATH / CREATOR_FFPROBE_PATH). SIGTERM/SIGINT interrupt the job
// in progress (its FFmpeg process is killed and the job handed back to the queue) and stop
// the worker; if the process is killed outright, another worker resumes the job once its
// lease expires. Signals must reach this process: pnpm does not pass SIGTERM on, so the
// container runs node directly (Dockerfile `worker`). Run it with a memory limit and a
// private scratch directory (CREATOR_WORK_DIR): docs/runbooks/CREATOR_STUDIO.md.
// It also runs the scheduler watchdog (Pass 38, src/server/monitoring/scheduler-watchdog.ts):
// every SCHEDULER_WATCHDOG_SECONDS (default 300; 0 = off) it alerts when the automation
// tick is stale or failed — the one condition the tick cannot report itself.

import { runWorker } from "@/server/creator/worker";
import { getCreatorDeps } from "@/server/creator/runtime";
import { getSystemDb } from "@/server/db/client";
import { logger } from "@/server/logger";
import { alert } from "@/server/monitoring/alerts";
import { collectOpsStatus } from "@/server/monitoring/ops-status";
import {
  checkScheduler,
  schedulerWatchdogIntervalMs,
} from "@/server/monitoring/scheduler-watchdog";

async function watchScheduler(signal: AbortSignal): Promise<void> {
  const everyMs = schedulerWatchdogIntervalMs(process.env.SCHEDULER_WATCHDOG_SECONDS);
  if (everyMs === 0) return;
  while (!signal.aborted) {
    try {
      const failing = await checkScheduler({
        collect: () => collectOpsStatus(getSystemDb(), new Date()),
        alert,
      });
      if (failing.length > 0) logger.warn({ checks: failing }, "Scheduler watchdog: alerting");
    } catch (error: unknown) {
      // Best effort: the watchdog never stops the worker.
      logger.warn({ err: error }, "Scheduler watchdog check failed");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, everyMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function main(): Promise<void> {
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "Creator worker stopping: the job in progress is handed back");
      stop.abort();
    });
  }
  const watchdog = watchScheduler(stop.signal);
  try {
    const { jobs } = await runWorker(getCreatorDeps(), getSystemDb(), { signal: stop.signal });
    logger.info({ jobs }, "Creator worker stopped");
  } finally {
    // Also when the worker fails: a pending watchdog timer must not keep the process alive.
    stop.abort();
    await watchdog;
  }
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Creator worker failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([Promise.resolve().then(() => getSystemDb().$disconnect())]);
  });
