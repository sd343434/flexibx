import { checkStartupEnv } from "../startup-env";

// The pre-rollout gate of a staging deployment (Pass 13): one command, run in the worker
// image next to the deployed app, that answers "may the trial start?". It composes the
// checks that already exist instead of re-implementing them:
//   - environment: every required variable set, and the app's own startup validation;
//   - database: scripts/ops/db-verify.sh --no-row-counts (migrations with checksums, the
//     expected indexes and constraints, integrity checks including disabled guards);
//   - media, scratch disk, bucket privacy, signed links, multipart, CORS, lifecycle:
//     `creator:preflight` (probe objects only, never a provider);
//   - the running app: readiness, and ops-status (worker heartbeat, stuck jobs, clean-up,
//     deletions, disk, alert delivery, the scheduler);
//   - the alert destination: configured, and — only with --send-test-alert — one test
//     alert actually delivered.
// Each result is PASS, FAIL (the deployment is wrong) or NOT_RUN (the check could not be
// executed here, with the reason): a gate that could not look is never reported as passed.
// Output: names, counts and reasons only — never a value of the environment. Pure: every
// side effect comes through `PredeployDeps`.

export type GateStatus = "pass" | "fail" | "not_run";

export interface GateResult {
  readonly name: string;
  readonly status: GateStatus;
  readonly detail: string;
}

export type CommandOutcome =
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string }
  | { readonly kind: "missing"; readonly what: string };

export interface PredeployDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs a repository script; `missing` when its interpreter or tool is not installed. */
  readonly run: (
    name: "db-verify" | "preflight",
    env: Readonly<Record<string, string>>,
  ) => Promise<CommandOutcome>;
  readonly fetch: (
    url: string,
    init: {
      readonly method: "GET" | "POST";
      readonly headers?: Record<string, string>;
      readonly body?: string;
    },
  ) => Promise<{ readonly status: number; readonly text: string }>;
  readonly sendTestAlert: boolean;
}

/** Variables a staging deployment must set (beyond what the app validates by itself). */
export const REQUIRED_VARIABLES = [
  "DATABASE_URL",
  "APP_URL",
  "AUTH_SECRET",
  "ENCRYPTION_KEY",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "AUTOMATION_CRON_SECRET",
  "OPS_STATUS_SECRET",
  "ALERT_WEBHOOK_URL",
] as const;

/** ops-status checks that must be `ok` before a trial (plus the worker heartbeat below). */
export const REQUIRED_OPS_CHECKS = [
  "automation_tick_last_success_age_seconds",
  "automation_tick_last_run_failed",
  "alert_delivery_failed",
  "creator_worker_disk_low",
  "creator_worker_cleanup_failed",
  "creator_jobs_lease_expired",
  "creator_jobs_past_deadline",
  "creator_storage_deletions_failing",
  "creator_storage_deletions_overdue",
  "creator_project_deletions_stuck",
  "creator_uploads_not_cleaned",
] as const;

const WORKER_CHECK = "creator_worker_last_seen_age_seconds";

const result = (name: string, status: GateStatus, detail: string): GateResult => ({
  name,
  status,
  detail,
});

const isSet = (value: string | undefined) => value !== undefined && value.trim() !== "";

function environmentChecks(env: PredeployDeps["env"]): GateResult[] {
  const missing = REQUIRED_VARIABLES.filter((name) => !isSet(env[name]));
  const results = [
    missing.length === 0
      ? result("env_required", "pass", `${String(REQUIRED_VARIABLES.length)} variables set`)
      : result("env_required", "fail", `not set: ${missing.join(", ")}`),
  ];
  if (env.NODE_ENV !== "production") {
    results.push(
      result("env_mode", "fail", "NODE_ENV must be production (the build staging runs)"),
    );
  } else {
    results.push(result("env_mode", "pass", "NODE_ENV=production"));
  }
  const report = checkStartupEnv(env);
  results.push(
    report.errors.length === 0
      ? result(
          "env_valid",
          "pass",
          report.warnings.length === 0
            ? "the app's startup validation passes"
            : `passes with ${String(report.warnings.length)} warning(s): ${report.warnings.join("; ")}`,
        )
      : result("env_valid", "fail", report.errors.join("; ").replaceAll("\n", " ")),
  );
  return results;
}

async function databaseCheck(deps: PredeployDeps): Promise<GateResult> {
  const url = deps.env.DATABASE_URL;
  if (!isSet(url)) return result("database", "not_run", "DATABASE_URL is not set");
  const outcome = await deps.run("db-verify", { VERIFY_DATABASE_URL: url ?? "" });
  if (outcome.kind === "missing")
    return result("database", "not_run", `${outcome.what} not installed`);
  // db-verify prints check names and counts only; its last line is the verdict.
  const verdict = outcome.stdout.trim().split("\n").at(-1) ?? "";
  return outcome.code === 0
    ? result("database", "pass", "migrations, schema objects and integrity checks verified")
    : result("database", "fail", `db-verify failed (exit ${String(outcome.code)}): ${verdict}`);
}

const PREFLIGHT_LINE = /^(PASS|FAIL|WARN|SKIP)\s+([a-z_]+): (.*)$/;

async function preflightChecks(deps: PredeployDeps): Promise<GateResult[]> {
  const outcome = await deps.run("preflight", {});
  if (outcome.kind === "missing") {
    return [result("preflight", "not_run", `${outcome.what} not installed`)];
  }
  const lines = outcome.stdout.split("\n").flatMap((line) => {
    const match = PREFLIGHT_LINE.exec(line.trim());
    if (match === null) return [];
    const [, status, name, detail] = match;
    const mapped: GateStatus = status === "FAIL" ? "fail" : status === "SKIP" ? "not_run" : "pass";
    return [
      result(
        `preflight.${name ?? ""}`,
        mapped,
        `${status === "WARN" ? "warning: " : ""}${detail ?? ""}`,
      ),
    ];
  });
  if (lines.length === 0) {
    return [result("preflight", "fail", `no result (exit ${String(outcome.code)})`)];
  }
  if (outcome.code !== 0 && lines.every((line) => line.status !== "fail")) {
    lines.push(result("preflight", "fail", `exited ${String(outcome.code)}`));
  }
  return lines;
}

/**
 * Where the gate reaches the app: STAGING_CHECK_APP_URL (its address inside the deployment's
 * network, e.g. http://app:3000) when set, otherwise the public APP_URL.
 */
function appUrl(env: PredeployDeps["env"]): string | null {
  const target = isSet(env.STAGING_CHECK_APP_URL) ? env.STAGING_CHECK_APP_URL : env.APP_URL;
  try {
    return new URL(target ?? "").origin;
  } catch {
    return null;
  }
}

async function readinessCheck(deps: PredeployDeps): Promise<GateResult> {
  const origin = appUrl(deps.env);
  if (origin === null) return result("app_readiness", "not_run", "APP_URL is not a URL");
  try {
    const response = await deps.fetch(`${origin}/api/health`, { method: "GET" });
    const body = JSON.parse(response.text) as { checks?: { db?: string } };
    return response.status === 200 && body.checks?.db === "up"
      ? result("app_readiness", "pass", "readiness 200, db up")
      : result("app_readiness", "fail", `readiness answered ${String(response.status)}`);
  } catch (error) {
    return result("app_readiness", "fail", `app unreachable (${errorName(error)})`);
  }
}

interface OpsCheckShape {
  readonly name: string;
  readonly value: number | null;
  readonly threshold: number;
  readonly level: string;
}

async function opsChecks(deps: PredeployDeps): Promise<GateResult[]> {
  const origin = appUrl(deps.env);
  const secret = deps.env.OPS_STATUS_SECRET;
  if (origin === null || !isSet(secret)) {
    return [result("ops_status", "not_run", "APP_URL or OPS_STATUS_SECRET is not set")];
  }
  let checks: readonly OpsCheckShape[];
  try {
    const response = await deps.fetch(`${origin}/api/internal/ops-status`, {
      method: "GET",
      headers: { authorization: `Bearer ${secret ?? ""}` },
    });
    if (response.status === 404) {
      return [result("ops_status", "fail", "404: OPS_STATUS_SECRET differs from the app's")];
    }
    checks = (JSON.parse(response.text) as { checks?: OpsCheckShape[] }).checks ?? [];
  } catch (error) {
    return [result("ops_status", "fail", `unreachable or unreadable (${errorName(error)})`)];
  }
  const byName = new Map(checks.map((check) => [check.name, check]));
  const results: GateResult[] = [];
  const worker = byName.get(WORKER_CHECK);
  results.push(
    worker === undefined
      ? result(`ops.${WORKER_CHECK}`, "fail", "not reported by this app version")
      : worker.value === null || worker.value >= worker.threshold
        ? result(
            `ops.${WORKER_CHECK}`,
            "fail",
            worker.value === null
              ? "no worker heartbeat yet"
              : `last beat ${String(worker.value)} s ago`,
          )
        : result(`ops.${WORKER_CHECK}`, "pass", `last beat ${String(worker.value)} s ago`),
  );
  for (const name of REQUIRED_OPS_CHECKS) {
    const check = byName.get(name);
    if (check === undefined) {
      results.push(result(`ops.${name}`, "fail", "not reported by this app version"));
    } else {
      results.push(
        result(
          `ops.${name}`,
          check.level === "ok" ? "pass" : "fail",
          `${check.level}: value ${String(check.value)}, threshold ${String(check.threshold)}`,
        ),
      );
    }
  }
  return results;
}

async function alertCheck(deps: PredeployDeps): Promise<GateResult> {
  const url = deps.env.ALERT_WEBHOOK_URL;
  if (!isSet(url)) return result("alert_destination", "fail", "ALERT_WEBHOOK_URL is not set");
  if (!deps.sendTestAlert) {
    return result(
      "alert_destination",
      "not_run",
      "configured; delivery not tested (run with --send-test-alert)",
    );
  }
  const token = deps.env.ALERT_WEBHOOK_TOKEN;
  try {
    const response = await deps.fetch(url ?? "", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(isSet(token) ? { authorization: `Bearer ${token ?? ""}` } : {}),
      },
      body: JSON.stringify({
        text: "[Flexibx staging] Test alert from staging:check (no action needed)",
        source: "flexibx",
        key: "staging_check_test",
        severity: "warning",
        title: "Test alert from staging:check",
      }),
    });
    return response.status >= 200 && response.status < 300
      ? result("alert_destination", "pass", `test alert delivered (${String(response.status)})`)
      : result("alert_destination", "fail", `test alert refused (${String(response.status)})`);
  } catch (error) {
    return result("alert_destination", "fail", `unreachable (${errorName(error)})`);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

export interface GateSummary {
  readonly results: readonly GateResult[];
  /** 0: everything passed; 1: something failed; 2: nothing failed, but not everything ran. */
  readonly exitCode: 0 | 1 | 2;
  readonly verdict: "PASSED" | "FAILED" | "INCOMPLETE";
}

export function summarize(results: readonly GateResult[]): GateSummary {
  if (results.some((entry) => entry.status === "fail")) {
    return { results, exitCode: 1, verdict: "FAILED" };
  }
  if (results.some((entry) => entry.status === "not_run")) {
    return { results, exitCode: 2, verdict: "INCOMPLETE" };
  }
  return { results, exitCode: 0, verdict: "PASSED" };
}

export async function runPredeployGate(deps: PredeployDeps): Promise<GateSummary> {
  const results: GateResult[] = [...environmentChecks(deps.env)];
  results.push(await databaseCheck(deps));
  results.push(...(await preflightChecks(deps)));
  results.push(await readinessCheck(deps));
  results.push(...(await opsChecks(deps)));
  results.push(await alertCheck(deps));
  return summarize(results);
}
