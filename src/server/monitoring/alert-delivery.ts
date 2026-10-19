import type { PrismaClient } from "@/generated/prisma/client";

import type { AlertOutcome } from "./alert-sink";
import { ALERT_DELIVERY_CHECK } from "./ops-status";

// Whether the scheduled tick's alerts reached their destination (ops_check_results
// `alert-delivery`). The alerting path cannot report its own failure through itself, so
// the outcome is stored and shown by ops-status (`alert_delivery_failed`), which an
// external uptime monitor polls. Best effort: callers never let this fail the tick. Pure.

/**
 * Records the outcome of one round of deliveries. A round without deliveries (no alert,
 * or every alert throttled / only logged) changes nothing: the last real outcome stands.
 */
export async function recordAlertDelivery(
  system: PrismaClient,
  outcomes: readonly AlertOutcome[],
  now: Date,
): Promise<void> {
  const sent = outcomes.filter((outcome) => outcome === "sent").length;
  const failed = outcomes.filter((outcome) => outcome === "failed").length;
  if (sent + failed === 0) return;
  const data = {
    status: failed > 0 ? "error" : "ok",
    counts: { sent, failed },
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    errorCode: failed > 0 ? "delivery_failed" : null,
    ...(failed > 0 ? {} : { completedAt: now }),
  };
  await system.opsCheckResult.upsert({
    where: { name: ALERT_DELIVERY_CHECK },
    create: { name: ALERT_DELIVERY_CHECK, ...data },
    update: data,
  });
}
