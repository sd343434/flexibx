// Command-line entry point for the generated-video retention job.
//
//   pnpm video:retention           # one run: reminders, expired-file deletion, metadata purge
//
// For development and for hosts that have the full source tree. The production Docker
// image (Next.js standalone) does not contain this script: production schedules
// POST /api/internal/video-retention instead (docs/AI_VIDEO_RETENTION_POLICY.md §4).
// It needs the same server environment as the app; a local .env file is loaded when
// present. Exit code 1 when the run itself fails, or when storage configuration prevented
// processing (status storage_unavailable); other failed deletions are retried by later
// runs and are visible in the audit log and the summary below.

import { closeBoundedRetentionDb, getSystemDb } from "@/server/db/client";
import { logger } from "@/server/logger";
import { runScheduledVideoRetention } from "@/server/videos/retention-runtime";

async function main(): Promise<void> {
  // Logs `video_retention.run` with the summary (single flight, graded severity).
  const summary = await runScheduledVideoRetention(logger);
  if (summary.status === "skipped") logger.info("Another retention run is in progress");
  if (summary.status === "partial") logger.info("Time budget reached; the next run continues");
  if (summary.status === "storage_unavailable") {
    logger.error("Storage provider unavailable: some files could not be processed");
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Video retention run failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close both pools whatever the outcome (completed, partial, skipped or failed), each
    // on its own so one failing cannot leave the other open. The run itself uses the
    // retention pool; an open pool would keep the process alive until it idles out.
    // getSystemDb() itself throws when the environment is invalid: nothing to close then.
    await Promise.allSettled([
      closeBoundedRetentionDb(),
      Promise.resolve().then(() => getSystemDb().$disconnect()),
    ]);
  });
