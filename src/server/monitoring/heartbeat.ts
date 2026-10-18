import type { PrismaClient } from "@/generated/prisma/client";

// Scheduled-job heartbeats (system_heartbeats). Best effort by design: a failed write is
// logged by the caller and never fails the job. Pure (no `server-only`) for tests.

export type HeartbeatJob = "automation-tick" | "video-retention" | "creator-worker";

export async function recordJobStarted(
  system: PrismaClient,
  name: HeartbeatJob,
  now: Date,
): Promise<void> {
  await system.systemHeartbeat.upsert({
    where: { name },
    create: { name, lastStartedAt: now },
    update: { lastStartedAt: now },
  });
}

export async function recordJobFinished(
  system: PrismaClient,
  name: HeartbeatJob,
  failedPhases: readonly string[],
  now: Date,
  options: { readonly partial?: boolean } = {},
): Promise<void> {
  const ok = failedPhases.length === 0;
  // partial: nothing failed, but the run stopped at its time budget with work left over
  // (it still counts as a successful run; ops-status warns on it).
  const data = {
    lastFinishedAt: now,
    lastStatus: ok ? (options.partial === true ? "partial" : "ok") : "failed",
    failedPhases: [...failedPhases],
    ...(ok ? { lastSucceededAt: now } : {}),
  };
  await system.systemHeartbeat.upsert({
    where: { name },
    create: { name, ...data },
    update: data,
  });
}
