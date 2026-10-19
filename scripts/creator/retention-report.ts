// Creator Studio retention report (read-only): how many source and export files are
// stored, their total size, and — when CREATOR_RETENTION_SOURCE_DAYS /
// CREATOR_RETENTION_EXPORT_DAYS are set — how many a policy of that age would remove.
// It never deletes anything (runbook docs/runbooks/CREATOR_STUDIO.md § 11).
//
//   pnpm creator:retention-report
//
// Prints one JSON document of counts and bytes: no ids, names or storage keys.

import { retentionPolicyFromEnv, retentionReport } from "@/server/creator/retention";
import { getSystemDb } from "@/server/db/client";
import { getCreatorEnv } from "@/server/env";

async function main(): Promise<void> {
  const report = await retentionReport(
    getSystemDb(),
    retentionPolicyFromEnv(getCreatorEnv()),
    new Date(),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Retention report failed: ${error instanceof Error ? error.name : "unknown error"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([Promise.resolve().then(() => getSystemDb().$disconnect())]);
  });
