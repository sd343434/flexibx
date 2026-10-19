// Minimal scheduler for a single-host deployment (deploy/staging/compose.yaml): calls the
// app's protected internal endpoints on a timer, exactly as a platform cron would —
//   POST /api/internal/automation-tick  every SCHEDULER_TICK_SECONDS (default 120)
//   POST /api/internal/video-retention  every SCHEDULER_RETENTION_HOURS (default 24)
// Needs SCHEDULER_APP_URL (the app's internal address, e.g. http://app:3000),
// AUTOMATION_CRON_SECRET and VIDEO_RETENTION_CRON_SECRET (a call whose secret is unset is
// skipped and said so once). Logs one JSON line per call: endpoint, HTTP status and
// duration — never a secret or a response body. A failed call is retried at the next
// interval; the app's own monitoring (ops-status) reports a stopped scheduler. Stops on
// SIGTERM/SIGINT. No dependencies; runs in the ops image:
//   node --import tsx scripts/ops/scheduler.ts

interface Job {
  readonly path: string;
  readonly secret: string | undefined;
  readonly everyMs: number;
}

const log = (fields: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);
};

const base = process.env.SCHEDULER_APP_URL ?? "";
if (base === "") {
  process.stderr.write(
    `${JSON.stringify({ level: "error", msg: "SCHEDULER_APP_URL is not set" })}\n`,
  );
  process.exit(64);
}

const jobs: readonly Job[] = [
  {
    path: "/api/internal/automation-tick",
    secret: process.env.AUTOMATION_CRON_SECRET,
    everyMs: Number(process.env.SCHEDULER_TICK_SECONDS ?? 120) * 1000,
  },
  {
    path: "/api/internal/video-retention",
    secret: process.env.VIDEO_RETENTION_CRON_SECRET,
    everyMs: Number(process.env.SCHEDULER_RETENTION_HOURS ?? 24) * 3600 * 1000,
  },
];

const timers: NodeJS.Timeout[] = [];

async function call(job: Job): Promise<void> {
  const started = Date.now();
  try {
    const response = await fetch(new URL(job.path, base), {
      method: "POST",
      headers: { authorization: `Bearer ${job.secret ?? ""}` },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    await response.arrayBuffer();
    log({
      level: response.ok ? "info" : "warn",
      endpoint: job.path,
      status: response.status,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    log({
      level: "warn",
      endpoint: job.path,
      error: error instanceof Error ? error.name : "unknown",
      durationMs: Date.now() - started,
    });
  }
}

for (const job of jobs) {
  if (job.secret === undefined || job.secret === "") {
    log({ level: "warn", endpoint: job.path, msg: "secret not set: endpoint not scheduled" });
    continue;
  }
  if (!Number.isFinite(job.everyMs) || job.everyMs < 60_000) {
    log({ level: "error", endpoint: job.path, msg: "interval must be at least 60 s" });
    process.exit(64);
  }
  let running = false;
  const run = () => {
    if (running) return; // never overlap a slow call with the next one
    running = true;
    void call(job).finally(() => {
      running = false;
    });
  };
  run();
  timers.push(setInterval(run, job.everyMs));
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    for (const timer of timers) clearInterval(timer);
    log({ level: "info", msg: "scheduler stopped", signal });
  });
}
