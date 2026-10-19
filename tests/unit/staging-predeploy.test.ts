// The staging pre-rollout gate (src/server/staging/predeploy.ts): every check reports
// PASS, FAIL or NOT_RUN, a check that could not run is never a pass, and no value of the
// environment reaches the output.
import { describe, expect, it } from "vitest";

import {
  REQUIRED_OPS_CHECKS,
  runPredeployGate,
  summarize,
  type CommandOutcome,
  type GateResult,
  type PredeployDeps,
} from "@/server/staging/predeploy";

const SECRET = "s".repeat(48);
const ENV = {
  NODE_ENV: "production",
  APP_URL: "https://staging.flexibx.example",
  DATABASE_URL: "postgresql://u:db-password@db.example:5432/flexibx_staging",
  AUTH_SECRET: SECRET,
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  S3_REGION: "eu-central-1",
  S3_BUCKET: "flexibx-staging",
  S3_ACCESS_KEY_ID: "staging-access-key",
  S3_SECRET_ACCESS_KEY: "staging-secret-key-value",
  AUTOMATION_CRON_SECRET: "c".repeat(40),
  OPS_STATUS_SECRET: "o".repeat(40),
  ALERT_WEBHOOK_URL: "https://alerts.example/hook",
};

const PREFLIGHT_OK = [
  "PASS  ffmpeg_version: FFmpeg 6",
  "PASS  bucket_private: unsigned read refused (403)",
  "WARN  ai_provider: OpenAI enabled",
  "PREFLIGHT PASSED (storage: LEGACY_S3)",
].join("\n");

function opsBody(overrides: Record<string, Partial<{ value: number | null; level: string }>> = {}) {
  const checks = [
    { name: "creator_worker_last_seen_age_seconds", value: 12, threshold: 600, level: "ok" },
    ...REQUIRED_OPS_CHECKS.map((name) => ({ name, value: 0, threshold: 1, level: "ok" })),
  ].map((check) => ({ ...check, ...overrides[check.name] }));
  return JSON.stringify({ status: "ok", checks });
}

function deps(
  over: {
    env?: Record<string, string | undefined>;
    dbVerify?: CommandOutcome;
    preflight?: CommandOutcome;
    health?: { status: number; text: string } | Error;
    ops?: { status: number; text: string } | Error;
    alert?: { status: number; text: string } | Error;
    sendTestAlert?: boolean;
  } = {},
) {
  const calls: { url: string; headers?: Record<string, string>; body?: string }[] = [];
  const d: PredeployDeps = {
    env: over.env ?? ENV,
    sendTestAlert: over.sendTestAlert ?? false,
    run: (name) =>
      Promise.resolve(
        name === "db-verify"
          ? (over.dbVerify ?? { kind: "exited", code: 0, stdout: "migrations ok\nVERIFIED\n" })
          : (over.preflight ?? { kind: "exited", code: 0, stdout: PREFLIGHT_OK }),
      ),
    fetch: (url, init) => {
      calls.push({
        url,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body ? { body: init.body } : {}),
      });
      const answer = url.endsWith("/api/health")
        ? (over.health ?? { status: 200, text: '{"status":"ok","checks":{"db":"up"}}' })
        : url.endsWith("/api/internal/ops-status")
          ? (over.ops ?? { status: 200, text: opsBody() })
          : (over.alert ?? { status: 204, text: "" });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { d, calls };
}

const byName = (results: readonly GateResult[], name: string) =>
  results.find((entry) => entry.name === name);

describe("staging pre-rollout gate", () => {
  it("passes a healthy deployment, except the alert delivery it was not asked to test", async () => {
    const { d } = deps();
    const summary = await runPredeployGate(d);
    expect(summary.results.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(byName(summary.results, "alert_destination")?.status).toBe("not_run");
    expect(summary).toMatchObject({ exitCode: 2, verdict: "INCOMPLETE" });
    // A preflight warning stays visible but is not a failure.
    expect(byName(summary.results, "preflight.ai_provider")).toMatchObject({
      status: "pass",
      detail: "warning: OpenAI enabled",
    });
  });

  it("passes completely when the test alert is delivered, with its token", async () => {
    const { d, calls } = deps({
      sendTestAlert: true,
      env: { ...ENV, ALERT_WEBHOOK_TOKEN: "t".repeat(20) },
    });
    const summary = await runPredeployGate(d);
    expect(summary).toMatchObject({ exitCode: 0, verdict: "PASSED" });
    const alert = calls.find((call) => call.url === ENV.ALERT_WEBHOOK_URL);
    expect(alert?.headers?.authorization).toBe(`Bearer ${"t".repeat(20)}`);
    expect(alert?.body).toContain("staging_check_test");
  });

  it("fails on missing variables, naming them only", async () => {
    const { d } = deps({ env: { ...ENV, OPS_STATUS_SECRET: undefined, ALERT_WEBHOOK_URL: " " } });
    const summary = await runPredeployGate(d);
    expect(byName(summary.results, "env_required")).toMatchObject({
      status: "fail",
      detail: "not set: OPS_STATUS_SECRET, ALERT_WEBHOOK_URL",
    });
    expect(byName(summary.results, "ops_status")?.status).toBe("not_run");
    expect(summary.exitCode).toBe(1);
  });

  it("fails outside production mode and on an invalid configuration", async () => {
    const dev = await runPredeployGate(deps({ env: { ...ENV, NODE_ENV: "development" } }).d);
    expect(byName(dev.results, "env_mode")?.status).toBe("fail");
    const invalid = await runPredeployGate(deps({ env: { ...ENV, AUTH_SECRET: "short" } }).d);
    expect(byName(invalid.results, "env_valid")?.status).toBe("fail");
    expect(byName(invalid.results, "env_valid")?.detail).toContain("AUTH_SECRET");
  });

  it("separates a database that fails verification from one it could not check", async () => {
    const failed = await runPredeployGate(
      deps({
        dbVerify: { kind: "exited", code: 1, stdout: "guard_triggers_inactive\t1\nFAILED\n" },
      }).d,
    );
    expect(byName(failed.results, "database")).toMatchObject({
      status: "fail",
      detail: "db-verify failed (exit 1): FAILED",
    });
    const missing = await runPredeployGate(deps({ dbVerify: { kind: "missing", what: "psql" } }).d);
    expect(byName(missing.results, "database")).toMatchObject({
      status: "not_run",
      detail: "psql not installed",
    });
    expect(summarize(missing.results).verdict).toBe("INCOMPLETE");
  });

  it("reports each preflight failure, and a preflight that printed nothing", async () => {
    const bad = await runPredeployGate(
      deps({
        preflight: {
          kind: "exited",
          code: 1,
          stdout:
            "FAIL  bucket_cors: no rule allows PUT from the app's origin\nSKIP  storage: none",
        },
      }).d,
    );
    expect(byName(bad.results, "preflight.bucket_cors")?.status).toBe("fail");
    expect(byName(bad.results, "preflight.storage")?.status).toBe("not_run");
    const silent = await runPredeployGate(
      deps({ preflight: { kind: "exited", code: 1, stdout: "" } }).d,
    );
    expect(byName(silent.results, "preflight")?.status).toBe("fail");
  });

  it("fails on an unreachable app, a wrong ops secret, a stale worker or stuck work", async () => {
    const down = await runPredeployGate(deps({ health: new TypeError("fetch failed") }).d);
    expect(byName(down.results, "app_readiness")).toMatchObject({
      status: "fail",
      detail: "app unreachable (TypeError)",
    });
    const secret = await runPredeployGate(deps({ ops: { status: 404, text: "" } }).d);
    expect(byName(secret.results, "ops_status")?.status).toBe("fail");
    const stale = await runPredeployGate(
      deps({
        ops: {
          status: 200,
          text: opsBody({
            creator_worker_last_seen_age_seconds: { value: null, level: "ok" },
            creator_jobs_lease_expired: { value: 2, level: "critical" },
          }),
        },
      }).d,
    );
    expect(byName(stale.results, "ops.creator_worker_last_seen_age_seconds")).toMatchObject({
      status: "fail",
      detail: "no worker heartbeat yet",
    });
    expect(byName(stale.results, "ops.creator_jobs_lease_expired")?.status).toBe("fail");
  });

  it("reaches the app at its internal address when one is given", async () => {
    const { d, calls } = deps({ env: { ...ENV, STAGING_CHECK_APP_URL: "http://app:3000" } });
    await runPredeployGate(d);
    expect(calls.map((call) => call.url)).toEqual(
      expect.arrayContaining([
        "http://app:3000/api/health",
        "http://app:3000/api/internal/ops-status",
      ]),
    );
    expect(calls.some((call) => call.url.startsWith(ENV.APP_URL))).toBe(false);
  });

  it("fails when the alert destination refuses the test alert", async () => {
    const summary = await runPredeployGate(
      deps({ sendTestAlert: true, alert: { status: 500, text: "" } }).d,
    );
    expect(byName(summary.results, "alert_destination")).toMatchObject({
      status: "fail",
      detail: "test alert refused (500)",
    });
  });

  it("never prints a value of the environment", async () => {
    const summary = await runPredeployGate(
      deps({
        env: { ...ENV, AUTH_SECRET: "short" },
        sendTestAlert: true,
        dbVerify: { kind: "exited", code: 3, stdout: "x" },
      }).d,
    );
    const printed = JSON.stringify(summary.results);
    for (const value of Object.values(ENV)) {
      if (value === "production") continue;
      expect(printed).not.toContain(value);
    }
    expect(printed).not.toContain("db-password");
  });
});
