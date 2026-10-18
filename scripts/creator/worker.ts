// The Creator Studio media worker: claims queued jobs (analysis, transcription,
// translation, exports) with a lease and runs them with FFmpeg — never inside a web
// request. One job at a time per process; run more processes to scale.
//
//   pnpm creator:worker
//
// Needs the server environment (DATABASE_URL, storage, CREATOR_*) and FFmpeg/ffprobe on
// PATH (or CREATOR_FFMPEG_PATH / CREATOR_FFPROBE_PATH). SIGTERM/SIGINT stop it between
// jobs; a job in progress finishes or, if the process is killed, is resumed by another
// worker once its lease expires. Run it with a memory limit and a private scratch
// directory (CREATOR_WORK_DIR): docs/runbooks/CREATOR_STUDIO.md.

import { runWorker } from "@/server/creator/worker";
import { getCreatorDeps } from "@/server/creator/runtime";
import { getSystemDb } from "@/server/db/client";
import { logger } from "@/server/logger";

async function main(): Promise<void> {
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "Creator worker stopping after the current job");
      stop.abort();
    });
  }
  const { jobs } = await runWorker(getCreatorDeps(), getSystemDb(), { signal: stop.signal });
  logger.info({ jobs }, "Creator worker stopped");
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Creator worker failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([Promise.resolve().then(() => getSystemDb().$disconnect())]);
  });
