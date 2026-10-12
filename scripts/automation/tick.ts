// Command-line entry point for one AI Marketing Manager scheduler tick.
//
//   pnpm automation:tick     # recover stale tasks, start due scheduled runs, advance runs
//
// For development and for hosts with the full source tree; production schedulers call
// POST /api/internal/automation-tick (docs/ARCHITECTURE.md, Scheduling). It needs
// the same server environment as the app; a local .env file is loaded when present.
// The AI provider follows AI_PROVIDER (disabled by default; never a paid provider today).

import { getSystemDb } from "@/server/db/client";
import { logger } from "@/server/logger";
import { getOrchestrationDeps } from "@/server/orchestration/runtime";
import { automationTick } from "@/server/orchestration/scheduler";

async function main(): Promise<void> {
  const summary = await automationTick({ ...getOrchestrationDeps(), system: getSystemDb() });
  logger.info(
    {
      recovered: summary.recovered,
      scheduled: summary.scheduled,
      skippedNoDelegate: summary.skippedNoDelegate,
      runs: summary.executed.length,
    },
    "automation.tick",
  );
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Automation tick failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([Promise.resolve().then(() => getSystemDb().$disconnect())]);
  });
