import { getRateLimiter } from "@/server/auth/auth";
import { parseAutomationEnv } from "@/server/env-schema";
import { AppError } from "@/server/errors/app-error";
import { withRoute } from "@/server/http/route-handler";
import { runScheduledAutomationTick } from "@/server/orchestration/runtime";
import { isAuthorizedRetentionTrigger } from "@/server/videos/retention-trigger-auth";

export const dynamic = "force-dynamic";

// Scheduler-facing endpoint for the AI Marketing Manager tick (the same work as
// `pnpm automation:tick`, available in the standalone production image): recover tasks
// interrupted by a crash or a deploy, start due scheduled planning, advance active runs.
//
// Requires `Authorization: Bearer $AUTOMATION_CRON_SECRET`; a 404 when the secret is
// unset or the token is missing/wrong, so its existence is not revealed. Authorized calls
// share one limit of 12 per 10 minutes (429 above it). Responses hold counts only.
// Single flight across instances (advisory lock): an overlapping call returns
// `status: "skipped"`. Items are also claimed by compare-and-set and tasks by lease.

const RATE_LIMIT_SUBJECT = "internal-automation-tick";

/** Secret first, quota second: unauthenticated traffic cannot use up the quota. */
async function authorize(request: Request): Promise<void> {
  const { AUTOMATION_CRON_SECRET: secret } = parseAutomationEnv(process.env);
  // The same constant-time bearer check as the retention endpoint, with its own secret.
  if (!isAuthorizedRetentionTrigger(request.headers.get("authorization"), secret)) {
    throw new AppError("NOT_FOUND", { metadata: { resource: "route" } });
  }
  await getRateLimiter()({
    bucket: "automation-tick",
    requestHeaders: request.headers,
    subject: RATE_LIMIT_SUBJECT,
  });
}

/** POST — one tick, every 1–5 minutes. Safe to retry. */
export const POST = withRoute({
  name: "automation.tick",
  handler: async ({ request, logger }) => {
    await authorize(request);
    const body = await runScheduledAutomationTick();
    logger.info(body, "automation.tick");
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  },
});
