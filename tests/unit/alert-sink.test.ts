import { describe, expect, it, vi } from "vitest";

import {
  ALERT_INTERVAL_MS,
  createAlertSink,
  memoryAlertThrottle,
  sanitizeDetails,
  type AlertLog,
  type AlertThrottleStore,
} from "@/server/monitoring/alert-sink";
import { checkStartupEnv } from "@/server/startup-env";

// Alert delivery: always logged, optionally POSTed, throttled per key, and never throwing
// — a broken monitoring path must not break the application.

const URL_ = "https://hooks.example.test/alert";
const NOW = new Date("2026-10-12T12:00:00Z");

function setup(
  options: {
    fetch?: typeof fetch;
    url?: string | undefined;
    token?: string;
    throttle?: AlertThrottleStore;
    log?: AlertLog;
  } = {},
) {
  const logs: { level: string; object: Record<string, unknown>; message: string }[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl =
    options.fetch ??
    (((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch);
  let clock = NOW;
  const sink = createAlertSink({
    webhookUrl: "url" in options ? options.url : URL_,
    webhookToken: options.token,
    environment: "production",
    throttle: options.throttle ?? memoryAlertThrottle(),
    log:
      options.log ??
      ((level, object, message) => {
        logs.push({ level, object, message });
      }),
    fetch: fetchImpl,
    now: () => clock,
  });
  return {
    sink,
    logs,
    calls,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const ALERT = {
  key: "automation_tick_phase_failed",
  severity: "critical" as const,
  title: "Scheduled tick phase failed",
  details: { failedPhases: ["social"] },
};

describe("alert sink", () => {
  it("only logs when no webhook is configured", async () => {
    const { sink, logs, calls } = setup({ url: undefined });
    expect(await sink(ALERT)).toBe("logged");
    expect(calls).toHaveLength(0);
    expect(logs).toEqual([
      {
        level: "error",
        object: {
          event: "alert",
          alertKey: ALERT.key,
          severity: "critical",
          details: { failedPhases: ["social"] },
        },
        message: "ALERT Scheduled tick phase failed",
      },
    ]);
  });

  it("posts a JSON payload with a text field and the bearer token", async () => {
    const { sink, calls } = setup({ token: "alert-token-0123456789" });
    expect(await sink({ ...ALERT, severity: "warning" })).toBe("sent");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(URL_);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer alert-token-0123456789",
    });
    expect(JSON.parse(call?.init.body as string)).toEqual({
      text: "[Flexibx production] WARNING: Scheduled tick phase failed",
      source: "flexibx",
      environment: "production",
      key: ALERT.key,
      severity: "warning",
      title: ALERT.title,
      details: { failedPhases: ["social"] },
      suppressedSinceLastAlert: 0,
      at: NOW.toISOString(),
    });
  });

  it("delivers the same key once per interval, then reports what was suppressed", async () => {
    const { sink, calls, logs, advance } = setup();
    expect(await sink(ALERT)).toBe("sent");
    expect(await sink(ALERT)).toBe("throttled");
    expect(await sink(ALERT)).toBe("throttled");
    expect(await sink({ ...ALERT, key: "other" })).toBe("sent");
    expect(logs).toHaveLength(4); // every occurrence is still logged
    advance(ALERT_INTERVAL_MS);
    expect(await sink(ALERT)).toBe("sent");
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2]?.init.body as string)).toMatchObject({
      suppressedSinceLastAlert: 2,
    });
  });

  it("never throws: network errors, bad statuses, broken throttle store or logger", async () => {
    const failing = setup({ fetch: () => Promise.reject(new TypeError("down")) });
    expect(await failing.sink(ALERT)).toBe("failed");
    expect(failing.logs.at(-1)).toMatchObject({
      level: "warn",
      object: { event: "alert.delivery_failed", error: "TypeError" },
    });

    const rejected = setup({
      fetch: (() =>
        Promise.resolve(new Response("no", { status: 500 }))) as unknown as typeof fetch,
    });
    expect(await rejected.sink(ALERT)).toBe("failed");
    expect(rejected.logs.at(-1)).toMatchObject({ object: { status: 500 } });

    const brokenStore = setup({
      throttle: { claim: () => Promise.reject(new Error("db down")) },
    });
    expect(await brokenStore.sink(ALERT)).toBe("sent"); // falls back to the in-memory throttle
    expect(await brokenStore.sink(ALERT)).toBe("throttled");

    const brokenLog = setup({
      log: () => {
        throw new Error("logger broken");
      },
    });
    expect(await brokenLog.sink(ALERT)).toBe("failed");

    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("timeout", "TimeoutError"));
          });
        }),
    );
    const timeout = createAlertSink({
      webhookUrl: URL_,
      environment: "test",
      throttle: memoryAlertThrottle(),
      log: () => undefined,
      fetch: slow as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect(await timeout(ALERT)).toBe("failed");
  });

  it("keeps details to short primitive values with secrets redacted", () => {
    expect(
      sanitizeDetails({
        count: 3,
        ok: true,
        none: null,
        accessToken: "abc",
        note: "x".repeat(500),
        nested: { a: 1 } as never,
        list: ["a", "b"],
      }),
    ).toEqual({
      count: 3,
      ok: true,
      none: null,
      accessToken: "[REDACTED]",
      note: `${"x".repeat(200)}…`,
      list: ["a", "b"],
    });
  });
});

describe("monitoring environment", () => {
  const base = { NODE_ENV: "development" };
  it("rejects a non-https webhook, a short token or a short status secret", () => {
    const errors = (source: Record<string, string>) =>
      checkStartupEnv({ ...base, ...source }).errors.filter((error) =>
        error.includes("monitoring"),
      );
    expect(errors({ ALERT_WEBHOOK_URL: "https://hooks.example.test/x" })).toEqual([]);
    expect(errors({ ALERT_WEBHOOK_URL: "http://hooks.example.test/x" }).join()).toMatch(
      /ALERT_WEBHOOK_URL/,
    );
    expect(errors({ ALERT_WEBHOOK_TOKEN: "short" }).join()).toMatch(/ALERT_WEBHOOK_TOKEN/);
    for (const bad of [
      "http://localhost.attacker.test/x",
      "https://user:pass@hooks.example.test/x",
      "ftp://hooks.example.test/x",
      "not a url",
    ]) {
      expect(errors({ ALERT_WEBHOOK_URL: bad }).join(), bad).toMatch(/ALERT_WEBHOOK_URL/);
    }
    expect(errors({ ALERT_WEBHOOK_URL: "http://localhost:9000/x" })).toEqual([]);
    expect(errors({ ALERT_WEBHOOK_URL: "http://127.0.0.1:9000/x" })).toEqual([]);
    expect(errors({ OPS_STATUS_SECRET: "short" }).join()).toMatch(/OPS_STATUS_SECRET/);
  });

  it("warns in production when alerts only reach the logs", () => {
    const report = checkStartupEnv({ NODE_ENV: "production" });
    expect(report.warnings).toContain(
      "ALERT_WEBHOOK_URL is not set: alerts are written to the logs only",
    );
    expect(report.warnings).toContain(
      "OPS_STATUS_SECRET is not set: no external monitor can detect a stopped scheduler",
    );
  });
});
