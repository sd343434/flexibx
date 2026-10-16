// Command-line entry point for one scheduler tick: exactly the work of
// POST /api/internal/automation-tick (runScheduledAutomationTick) — orchestration
// (recover stale tasks, start due scheduled runs, advance runs), the AI Social Manager
// sweep (publishing, drafts, unsent replies, stuck sends), abandoned credit holds and
// stopped video jobs.
//
//   pnpm automation:tick
//
// For development and for hosts with the full source tree; production schedulers call the
// endpoint. It needs the same server environment as the app; a local .env file is loaded
// when present. Exits non-zero when a phase failed (the other phases still ran); a tick
// skipped because another is running, or cut short by its time budget, exits 0 and is
// logged and alerted (runScheduledAutomationTick).

import { closeTickLockDb, getSystemDb } from "@/server/db/client";
import { logger } from "@/server/logger";
import { runScheduledAutomationTick } from "@/server/orchestration/runtime";

async function main(): Promise<void> {
  const summary = await runScheduledAutomationTick();
  logger.info({ ...summary }, "automation.tick");
  if (summary.failedPhases.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Automation tick failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([
      Promise.resolve().then(() => getSystemDb().$disconnect()),
      closeTickLockDb(),
    ]);
  });
