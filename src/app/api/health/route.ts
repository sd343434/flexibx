import { z } from "zod";

import { checkDatabaseHealth } from "@/server/health/health-service";
import { withRoute } from "@/server/http/route-handler";

export const dynamic = "force-dynamic";

/**
 * GET /api/health?scope=liveness|readiness
 * - liveness: the process is serving requests (no dependencies checked).
 * - readiness (default): also verifies the database is reachable.
 * Reports only up/down — never connection details or error messages.
 */
export const GET = withRoute({
  name: "health.get",
  query: z.object({ scope: z.enum(["liveness", "readiness"]).default("readiness") }).strict(),
  handler: async ({ query, logger }) => {
    if (query.scope === "liveness") {
      return { status: "ok", scope: query.scope };
    }
    const db = await checkDatabaseHealth();
    if (db === "down") logger.error({ check: "db" }, "readiness check failed");
    return Response.json(
      { status: db === "up" ? "ok" : "unavailable", scope: query.scope, checks: { db } },
      { status: db === "up" ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  },
});
