import { getRateLimiter } from "@/server/auth/auth";
import { parseMonitoringEnv } from "@/server/env-schema";
import { AppError } from "@/server/errors/app-error";
import { withRoute } from "@/server/http/route-handler";
import { getOpsStatus } from "@/server/monitoring/ops-status-service";
import { isAuthorizedRetentionTrigger } from "@/server/videos/retention-trigger-auth";

export const dynamic = "force-dynamic";

// Operational status for an uptime monitor or an operator: is the scheduler running, and
// are credit holds, sends or publishes stuck (src/server/monitoring/ops-status.ts).
// Requires `Authorization: Bearer $OPS_STATUS_SECRET`; a 404 when the secret is unset or
// the token is missing/wrong. 200 when nothing is critical, 503 when something is, so a
// plain HTTP check can page someone. The body holds check names and counts only.

const RATE_LIMIT_SUBJECT = "internal-ops-status";

async function authorize(request: Request): Promise<void> {
  const { OPS_STATUS_SECRET: secret } = parseMonitoringEnv(process.env);
  if (!isAuthorizedRetentionTrigger(request.headers.get("authorization"), secret)) {
    throw new AppError("NOT_FOUND", { metadata: { resource: "route" } });
  }
  await getRateLimiter()({
    bucket: "ops-status",
    requestHeaders: request.headers,
    subject: RATE_LIMIT_SUBJECT,
  });
}

export const GET = withRoute({
  name: "ops.status",
  handler: async ({ request }) => {
    await authorize(request);
    const status = await getOpsStatus();
    return Response.json(status, {
      status: status.status === "critical" ? 503 : 200,
      headers: { "cache-control": "no-store" },
    });
  },
});
