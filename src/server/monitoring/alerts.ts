import "server-only";

import { getSystemDb } from "../db/client";
import { parseMonitoringEnv } from "../env-schema";
import { logger } from "../logger";

import {
  createAlertSink,
  databaseAlertThrottle,
  memoryAlertThrottle,
  type Alert,
  type AlertOutcome,
  type AlertSink,
} from "./alert-sink";

// The process's alert sink (alert-sink.ts), from ALERT_WEBHOOK_URL / ALERT_WEBHOOK_TOKEN.
// SYSTEM PATH (reviewed): alert_throttles is a global table of alert keys and counts.

let sink: AlertSink | undefined;

function getSink(): AlertSink {
  if (sink === undefined) {
    let webhookUrl: string | undefined;
    let webhookToken: string | undefined;
    try {
      ({ ALERT_WEBHOOK_URL: webhookUrl, ALERT_WEBHOOK_TOKEN: webhookToken } = parseMonitoringEnv(
        process.env,
      ));
    } catch {
      // Invalid monitoring configuration is reported at start-up; alerts still reach logs.
    }
    let throttle;
    try {
      throttle = databaseAlertThrottle(getSystemDb());
    } catch {
      throttle = memoryAlertThrottle();
    }
    const log = logger.child({ module: "monitoring" });
    sink = createAlertSink({
      webhookUrl,
      webhookToken,
      environment: process.env.NODE_ENV,
      throttle,
      log: (level, object, message) => {
        log[level](object, message);
      },
    });
  }
  return sink;
}

/** Logs the alert and delivers it to the configured webhook. Never throws. */
export async function alert(event: Alert): Promise<AlertOutcome> {
  try {
    return await getSink()(event);
  } catch {
    return "failed";
  }
}

/**
 * A server fault (5xx) in a route handler, server action or render. Only the entry
 * point, the error code/class and the request id are reported; the full (redacted)
 * error is already in the request log under the same request id.
 */
export function reportServerError(input: {
  readonly source: "route" | "action" | "render";
  /** Route/action name or route path (never a URL with query parameters). */
  readonly name: string;
  readonly code: string;
  readonly requestId?: string | undefined;
}): void {
  const unavailable = input.code === "SERVICE_UNAVAILABLE";
  void alert({
    key: `${unavailable ? "service_unavailable" : "server_error"}:${input.source}:${input.name}`,
    severity: unavailable ? "warning" : "critical",
    title: unavailable ? "Dependency unavailable (503)" : "Server error (5xx)",
    details: {
      source: input.source,
      name: input.name,
      code: input.code,
      requestId: input.requestId ?? null,
    },
  });
}
