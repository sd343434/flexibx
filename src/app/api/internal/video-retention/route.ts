import { getRateLimiter } from "@/server/auth/auth";
import { AppError } from "@/server/errors/app-error";
import { withRoute } from "@/server/http/route-handler";
import { isAuthorizedRetentionTrigger } from "@/server/videos/retention-trigger-auth";
import {
  getVideoRetentionEnv,
  getVideoRetentionStatus,
  runScheduledVideoRetention,
} from "@/server/videos/retention-runtime";

export const dynamic = "force-dynamic";

// Scheduler-facing endpoints for the generated-video retention job
// (docs/AI_VIDEO_RETENTION_POLICY.md §4, runbook docs/runbooks/VIDEO_RETENTION_RUNBOOK.md).
//
// Both require `Authorization: Bearer $VIDEO_RETENTION_CRON_SECRET` and are a 404 when the
// secret is unset or the token is missing/wrong, so their existence is not revealed.
// Authorized calls share one limit of 12 per 10 minutes (429 above it). Responses hold
// counts and timestamps only.

/** One quota for every authorized caller (rate-limit-policy.ts, bucket `video-retention`). */
const RATE_LIMIT_SUBJECT = "internal-video-retention";

/**
 * Secret first, quota second: a missing or wrong token is a 404 that consumes nothing,
 * so unauthenticated traffic cannot exhaust the scheduler's 12-per-10-minutes quota.
 * Over the quota: the standard 429 RATE_LIMITED response.
 */
async function authorize(request: Request): Promise<void> {
  const { VIDEO_RETENTION_CRON_SECRET: secret } = getVideoRetentionEnv();
  if (!isAuthorizedRetentionTrigger(request.headers.get("authorization"), secret)) {
    throw new AppError("NOT_FOUND", { metadata: { resource: "route" } });
  }
  await getRateLimiter()({
    bucket: "video-retention",
    requestHeaders: request.headers,
    subject: RATE_LIMIT_SUBJECT,
  });
}

/**
 * POST — one run (reminders, deletion of expired files, metadata purge), every 15
 * minutes. Single flight across all instances: a call while another run is in progress
 * returns 200 with `status: "skipped"`. A run that reaches its time budget stops starting
 * new work and returns 200 with `status: "partial"`. A run in which some files could not
 * be processed because their storage provider is unavailable returns 503 with
 * `status: "storage_unavailable"` (the files are retried by later runs). Safe to retry.
 */
export const POST = withRoute({
  name: "videos.retention.run",
  handler: async ({ request, logger }) => {
    await authorize(request);
    const summary = await runScheduledVideoRetention(logger);
    // Storage configuration prevented processing: not a successful run. 503 makes the
    // scheduler record a failure (the body still carries the summary, no secrets).
    if (summary.status === "storage_unavailable") {
      return Response.json(summary, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return summary;
  },
});

/** GET — the current backlog without running anything (monitoring probe). */
export const GET = withRoute({
  name: "videos.retention.status",
  handler: async ({ request }) => {
    await authorize(request);
    return getVideoRetentionStatus();
  },
});
