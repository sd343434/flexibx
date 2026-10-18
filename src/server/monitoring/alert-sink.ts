import type { PrismaClient } from "@/generated/prisma/client";

import { redactSecrets } from "../redact";

// Alert delivery. Pure (no `server-only`) so it is unit-tested with a fake fetch.
//
// Every alert is written to the structured log (the baseline signal any log-based
// monitor can match on `event: "alert"`). When ALERT_WEBHOOK_URL is set it is also POSTed
// there as JSON (with a `text` field, so Slack/Teams-style incoming webhooks work as is),
// at most once per key per interval across all processes (alert_throttles), with a short
// timeout. Delivery never throws and never delays the caller beyond the timeout: a broken
// monitoring path must not break the application.
//
// Details carry ids, counts, names and codes only — never customer content, tokens or
// email addresses (they also pass through the secret redaction used for logs).

export type AlertSeverity = "critical" | "warning";

export type AlertDetailValue = string | number | boolean | null | readonly string[];

export interface Alert {
  /** Stable identity of the problem (throttling key), e.g. `automation_tick_failed`. */
  readonly key: string;
  readonly severity: AlertSeverity;
  /** Short, fixed English text (no interpolated user data). */
  readonly title: string;
  readonly details?: Readonly<Record<string, AlertDetailValue>>;
}

export type AlertOutcome = "logged" | "sent" | "throttled" | "failed";

export interface AlertThrottleStore {
  /**
   * Whether this occurrence may be delivered now (and, if so, how many earlier ones were
   * swallowed since the last delivery). Records the decision atomically.
   */
  claim(key: string, now: Date, intervalMs: number): Promise<{ send: boolean; suppressed: number }>;
  /**
   * Gives back the slot claimed at `claimedAt` after its delivery failed, so the next
   * occurrence is delivered instead of being swallowed for the rest of the interval. A
   * slot claimed since by another process is left alone.
   */
  release?(key: string, claimedAt: Date): Promise<void>;
}

export type AlertLog = (
  level: "error" | "warn",
  object: Record<string, unknown>,
  message: string,
) => void;

export interface AlertSinkConfig {
  readonly webhookUrl?: string | undefined;
  readonly webhookToken?: string | undefined;
  /** NODE_ENV / deployment name, included in the payload. */
  readonly environment: string;
  readonly throttle: AlertThrottleStore;
  readonly log: AlertLog;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

export const ALERT_TIMEOUT_MS = 3000;
/** The same problem is delivered at most once per this interval. */
export const ALERT_INTERVAL_MS = 30 * 60_000;
const MAX_KEY_LENGTH = 120;
const MAX_TEXT_LENGTH = 200;
const MAX_DETAILS = 20;

const truncate = (value: string) =>
  value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;

/** Keeps primitive details only, shortened and secret-redacted. */
export function sanitizeDetails(
  details: Readonly<Record<string, AlertDetailValue>> | undefined,
): Record<string, AlertDetailValue> {
  const clean: Record<string, AlertDetailValue> = {};
  for (const [name, value] of Object.entries(details ?? {}).slice(0, MAX_DETAILS)) {
    if (typeof value === "string") clean[name] = truncate(value);
    else if (Array.isArray(value))
      clean[name] = value.slice(0, MAX_DETAILS).map((item) => truncate(String(item)));
    else if (value === null || typeof value === "number" || typeof value === "boolean") {
      clean[name] = value;
    }
  }
  return redactSecrets(clean) as Record<string, AlertDetailValue>;
}

/** In-process throttle: the fallback when the database cannot be reached. */
export function memoryAlertThrottle(): AlertThrottleStore {
  const last = new Map<string, { at: number; suppressed: number }>();
  return {
    claim: (key, now, intervalMs) => {
      const entry = last.get(key);
      if (entry !== undefined && now.getTime() - entry.at < intervalMs) {
        entry.suppressed += 1;
        return Promise.resolve({ send: false, suppressed: entry.suppressed });
      }
      last.set(key, { at: now.getTime(), suppressed: 0 });
      return Promise.resolve({ send: true, suppressed: entry?.suppressed ?? 0 });
    },
    release: (key, claimedAt) => {
      const entry = last.get(key);
      if (entry?.at === claimedAt.getTime()) entry.at = 0;
      return Promise.resolve();
    },
  };
}

/**
 * Cross-process throttle in `alert_throttles`: one atomic statement decides whether this
 * occurrence is delivered (no row yet, or the last delivery is older than the interval:
 * the counter resets to 0) or counted (the counter goes up, so it is never 0).
 */
export function databaseAlertThrottle(system: PrismaClient): AlertThrottleStore {
  return {
    claim: async (key, now, intervalMs) => {
      const cutoff = new Date(now.getTime() - intervalMs);
      const rows = await system.$queryRaw<{ send: boolean; suppressed: number }[]>`
        WITH previous AS (
          SELECT "suppressed_count" FROM "alert_throttles" WHERE "key" = ${key}
        )
        INSERT INTO "alert_throttles" ("key", "last_sent_at", "suppressed_count")
        VALUES (${key}, ${now}, 0)
        ON CONFLICT ("key") DO UPDATE SET
          "last_sent_at" = CASE WHEN "alert_throttles"."last_sent_at" <= ${cutoff}
            THEN EXCLUDED."last_sent_at" ELSE "alert_throttles"."last_sent_at" END,
          "suppressed_count" = CASE WHEN "alert_throttles"."last_sent_at" <= ${cutoff}
            THEN 0 ELSE "alert_throttles"."suppressed_count" + 1 END
        RETURNING ("suppressed_count" = 0) AS "send",
          COALESCE((SELECT "suppressed_count" FROM previous), 0)::int AS "suppressed"`;
      const row = rows[0];
      return { send: row?.send === true, suppressed: row?.suppressed ?? 0 };
    },
    // The epoch is older than any interval: the next claim delivers, and reports the
    // occurrences counted meanwhile.
    release: async (key, claimedAt) => {
      await system.$executeRaw`
        UPDATE "alert_throttles" SET "last_sent_at" = to_timestamp(0)
        WHERE "key" = ${key} AND "last_sent_at" = ${claimedAt}`;
    },
  };
}

export type AlertSink = (alert: Alert) => Promise<AlertOutcome>;

export function createAlertSink(config: AlertSinkConfig): AlertSink {
  const fallback = memoryAlertThrottle();
  const now = config.now ?? (() => new Date());
  const doFetch = config.fetch ?? fetch;
  const intervalMs = config.intervalMs ?? ALERT_INTERVAL_MS;

  return async (alert) => {
    // Set once a slot is claimed: a failed delivery gives it back.
    let giveBack: (() => Promise<void>) | undefined;
    try {
      const key = alert.key.slice(0, MAX_KEY_LENGTH);
      const details = sanitizeDetails(alert.details);
      config.log(
        alert.severity === "critical" ? "error" : "warn",
        { event: "alert", alertKey: key, severity: alert.severity, details },
        `ALERT ${alert.title}`,
      );
      if (config.webhookUrl === undefined) return "logged";

      const at = now();
      let decision: { send: boolean; suppressed: number };
      let store: AlertThrottleStore = config.throttle;
      try {
        decision = await store.claim(key, at, intervalMs);
      } catch {
        store = fallback;
        decision = await store.claim(key, at, intervalMs);
      }
      if (!decision.send) return "throttled";
      giveBack = async () => {
        try {
          await store.release?.(key, at);
        } catch {
          // The slot stays taken: this key is delivered again after the interval.
        }
      };

      const response = await doFetch(config.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.webhookToken === undefined
            ? {}
            : { authorization: `Bearer ${config.webhookToken}` }),
        },
        body: JSON.stringify({
          text: `[Flexibx ${config.environment}] ${alert.severity.toUpperCase()}: ${alert.title}`,
          source: "flexibx",
          environment: config.environment,
          key,
          severity: alert.severity,
          title: alert.title,
          details,
          suppressedSinceLastAlert: decision.suppressed,
          at: at.toISOString(),
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? ALERT_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        await giveBack();
        config.log(
          "warn",
          { event: "alert.delivery_failed", alertKey: key, status: response.status },
          "Alert delivery failed",
        );
        return "failed";
      }
      return "sent";
    } catch (error) {
      await giveBack?.();
      try {
        config.log(
          "warn",
          {
            event: "alert.delivery_failed",
            alertKey: alert.key.slice(0, MAX_KEY_LENGTH),
            error: error instanceof Error ? error.name : "unknown",
          },
          "Alert delivery failed",
        );
      } catch {
        // Nothing else to do: monitoring must never break the caller.
      }
      return "failed";
    }
  };
}
