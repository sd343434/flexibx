// The deterministic core of the orchestration engine (pure, unit tested): which tasks of
// a run may start, which can never start, what a finished run's outcome is, how long a
// retry waits, when a schedule fires next, and whether a workflow definition is sound.
// No model output ever decides any of this.

export const TASK_RISKS = ["INTERNAL", "EXTERNAL", "SPEND"] as const;
/**
 * What a task does to the world. INTERNAL: reads workspace data or writes drafts inside
 * Flexibx. EXTERNAL: acts outside (publishing, messaging). SPEND: commits money. Only
 * INTERNAL runs without a person; the others run only after a person approves that exact
 * action, once (no standing grants exist).
 */
export type TaskRisk = (typeof TASK_RISKS)[number];

export type TaskState =
  "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED" | "NEEDS_APPROVAL";

export type RunOutcome =
  | { readonly state: "SUCCEEDED" }
  | { readonly state: "FAILED"; readonly failureCode: string }
  | { readonly state: "NEEDS_ATTENTION"; readonly failureCode: string };

export interface TaskView {
  readonly key: string;
  readonly state: TaskState;
  readonly dependsOn: readonly string[];
  readonly runAfter: Date;
  readonly failureCode: string | null;
}

export interface TaskDefinitionShape {
  readonly key: string;
  readonly dependsOn: readonly string[];
}

const DONE_OK: ReadonlySet<TaskState> = new Set(["SUCCEEDED", "SKIPPED"]);
const DEAD: ReadonlySet<TaskState> = new Set(["FAILED", "CANCELLED"]);
const TERMINAL: ReadonlySet<TaskState> = new Set([...DONE_OK, ...DEAD]);

export interface RunPlan {
  /** Pending tasks that can never start (a dependency failed or was cancelled). */
  readonly cancel: readonly string[];
  /** Pending tasks whose dependencies are done and whose backoff has passed. */
  readonly ready: readonly string[];
  /** Earliest backoff end among pending tasks that are otherwise ready. */
  readonly nextAt: Date | null;
  /**
   * Set when nothing more can happen without a person: every task is finished
   * (SUCCEEDED/FAILED), or the only open work waits for an approval (NEEDS_ATTENTION —
   * the run resumes once the approval is decided).
   */
  readonly outcome: RunOutcome | null;
}

export function planRun(tasks: readonly TaskView[], now: Date): RunPlan {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const state = (key: string) => byKey.get(key)?.state;
  // Pending tasks downstream of a failed or cancelled task, transitively: a whole chain is
  // settled in one pass.
  const cancelled = new Set<string>();
  const dead = (key: string) => cancelled.has(key) || DEAD.has(state(key) ?? "CANCELLED");
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (task.state === "PENDING" && !cancelled.has(task.key) && task.dependsOn.some(dead)) {
        cancelled.add(task.key);
        grew = true;
      }
    }
  }
  const cancel = tasks.filter((task) => cancelled.has(task.key)).map((task) => task.key);
  const depsDone = (task: TaskView) =>
    task.dependsOn.every((dep) => DONE_OK.has(state(dep) ?? "FAILED"));
  const waiting = tasks.filter(
    (task) => task.state === "PENDING" && !cancelled.has(task.key) && depsDone(task),
  );
  const ready = waiting.filter((task) => task.runAfter <= now).map((task) => task.key);
  const later = waiting
    .filter((task) => task.runAfter > now)
    .map((task) => task.runAfter.getTime());
  const open = tasks.filter((task) => !TERMINAL.has(task.state) && !cancelled.has(task.key));
  // A task awaiting approval blocks its dependents (they wait, they are not cancelled).
  // Once nothing else can move — nothing running, ready or backing off — the run needs a
  // person.
  const stuckOnApproval =
    open.some((task) => task.state === "NEEDS_APPROVAL") &&
    !open.some((task) => task.state === "RUNNING") &&
    ready.length === 0 &&
    later.length === 0;
  return {
    cancel,
    ready,
    nextAt: later.length === 0 ? null : new Date(Math.min(...later)),
    outcome:
      open.length === 0 || stuckOnApproval
        ? runOutcome(
            tasks.map((task) =>
              cancelled.has(task.key) ? { ...task, state: "CANCELLED" as const } : task,
            ),
          )
        : null,
  };
}

/** The outcome of a run whose tasks are all finished. */
export function runOutcome(tasks: readonly TaskView[]): RunOutcome {
  const approval = tasks.find((task) => task.state === "NEEDS_APPROVAL");
  if (approval !== undefined) {
    return { state: "NEEDS_ATTENTION", failureCode: `approval_required:${approval.key}` };
  }
  const failed = tasks.find((task) => task.state === "FAILED");
  if (failed !== undefined) {
    return {
      state: "FAILED",
      failureCode: `${failed.key}:${failed.failureCode ?? "failed"}`.slice(0, 60),
    };
  }
  if (tasks.some((task) => task.state === "CANCELLED")) {
    return { state: "FAILED", failureCode: "cancelled_tasks" };
  }
  return { state: "SUCCEEDED" };
}

/** Retry wait after `attempts` failed attempts: 30 s, 60 s, 120 s … capped at 15 min. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

export type Cadence = "OFF" | "DAILY" | "WEEKLY";
const CADENCE_MS = { DAILY: 24 * 3_600_000, WEEKLY: 7 * 24 * 3_600_000 } as const;

/**
 * The next schedule slot after `slot` that is later than `now` (missed slots are skipped,
 * never replayed one by one). Null when the cadence is OFF.
 */
export function nextSlot(slot: Date, cadence: Cadence, now: Date): Date | null {
  if (cadence === "OFF") return null;
  const step = CADENCE_MS[cadence];
  const missed = Math.max(0, Math.floor((now.getTime() - slot.getTime()) / step) + 1);
  return new Date(slot.getTime() + missed * step);
}

/** The first slot of a newly scheduled cadence: one interval from now. */
export function firstSlot(cadence: Cadence, now: Date): Date | null {
  return cadence === "OFF" ? null : new Date(now.getTime() + CADENCE_MS[cadence]);
}

/** Problems with a workflow definition (unknown or self dependencies, cycles, duplicates). */
export function definitionProblems(tasks: readonly TaskDefinitionShape[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) problems.push(`duplicate:${task.key}`);
    keys.add(task.key);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.key) problems.push(`self:${task.key}`);
      else if (!keys.has(dep)) problems.push(`unknown:${task.key}->${dep}`);
    }
  }
  // Cycle check (Kahn): every task must be reachable in dependency order.
  const remaining = new Map(tasks.map((task) => [task.key, new Set(task.dependsOn)]));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [key, deps] of remaining) {
      if ([...deps].every((dep) => !remaining.has(dep))) {
        remaining.delete(key);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) problems.push(`cycle:${[...remaining.keys()].sort().join(",")}`);
  return problems;
}
