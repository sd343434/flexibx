import { describe, expect, it } from "vitest";

import {
  backoffMs,
  definitionProblems,
  firstSlot,
  nextSlot,
  planRun,
  runOutcome,
  type TaskState,
  type TaskView,
} from "@/server/orchestration/planner";

// The orchestration engine's deterministic core: readiness, propagation of failures,
// run outcomes, backoff, schedule slots and workflow validation.

const NOW = new Date("2026-10-10T12:00:00Z");
const task = (
  key: string,
  state: TaskState,
  dependsOn: string[] = [],
  runAfter: Date = NOW,
  failureCode: string | null = null,
): TaskView => ({ key, state, dependsOn, runAfter, failureCode });

describe("planRun", () => {
  it("starts tasks whose dependencies succeeded or were skipped", () => {
    const plan = planRun(
      [
        task("a", "SUCCEEDED"),
        task("b", "SKIPPED"),
        task("c", "PENDING", ["a", "b"]),
        task("d", "PENDING", ["c"]),
      ],
      NOW,
    );
    expect(plan).toEqual({ cancel: [], ready: ["c"], nextAt: null, outcome: null });
  });

  it("waits for a retry backoff and reports when it ends", () => {
    const later = new Date(NOW.getTime() + 60_000);
    const plan = planRun([task("a", "PENDING", [], later)], NOW);
    expect(plan.ready).toEqual([]);
    expect(plan.nextAt).toEqual(later);
    expect(plan.outcome).toBeNull();
  });

  it("cancels every task downstream of a failure and finishes the run in one pass", () => {
    const plan = planRun(
      [
        task("a", "FAILED", [], NOW, "ai_not_configured"),
        task("b", "PENDING", ["a"]),
        task("c", "PENDING", ["b"]),
        task("d", "SUCCEEDED"),
      ],
      NOW,
    );
    expect(plan.cancel).toEqual(["b", "c"]);
    expect(plan.ready).toEqual([]);
    expect(plan.outcome).toEqual({ state: "FAILED", failureCode: "a:ai_not_configured" });
  });

  it("holds the dependents of a task awaiting approval until nothing else can move", () => {
    const done = task("a", "SUCCEEDED");
    const report = task("r", "PENDING", ["p"]);
    const waiting = [done, task("p", "NEEDS_APPROVAL", ["a"]), report];
    // Another branch still runs: the run is not stuck yet.
    expect(planRun([...waiting, task("x", "RUNNING", ["a"])], NOW).outcome).toBeNull();
    expect(planRun([...waiting, task("x", "PENDING", ["a"])], NOW).ready).toEqual(["x"]);
    // Only the approval is left: the dependents wait (not cancelled), the run needs a person.
    const stuck = planRun(waiting, NOW);
    expect(stuck.cancel).toEqual([]);
    expect(stuck.ready).toEqual([]);
    expect(stuck.outcome).toEqual({ state: "NEEDS_ATTENTION", failureCode: "approval_required:p" });
    // Once approved (PENDING again) the task is ready; once rejected (FAILED) the chain ends.
    expect(planRun([done, task("p", "PENDING", ["a"]), report], NOW).ready).toEqual(["p"]);
    const rejected = planRun(
      [done, task("p", "FAILED", ["a"], NOW, "approval_rejected"), report],
      NOW,
    );
    expect(rejected.cancel).toEqual(["r"]);
    expect(rejected.outcome).toEqual({ state: "FAILED", failureCode: "p:approval_rejected" });
  });

  it("is still open while a task runs", () => {
    expect(planRun([task("a", "RUNNING"), task("b", "PENDING", ["a"])], NOW).outcome).toBeNull();
  });
});

describe("runOutcome", () => {
  it("needs attention when a step waits for approval, fails on a failed step", () => {
    expect(runOutcome([task("a", "SUCCEEDED"), task("p", "NEEDS_APPROVAL")])).toEqual({
      state: "NEEDS_ATTENTION",
      failureCode: "approval_required:p",
    });
    expect(runOutcome([task("a", "FAILED", [], NOW, "timeout")])).toEqual({
      state: "FAILED",
      failureCode: "a:timeout",
    });
    expect(runOutcome([task("a", "SUCCEEDED"), task("b", "SKIPPED")])).toEqual({
      state: "SUCCEEDED",
    });
    expect(runOutcome([task("a", "SUCCEEDED"), task("b", "CANCELLED")]).state).toBe("FAILED");
  });
});

describe("backoff and schedule", () => {
  it("doubles the retry wait from 30 s and caps it at 15 min", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(20)).toBe(15 * 60_000);
  });

  it("skips missed slots instead of replaying them", () => {
    const slot = new Date("2026-10-01T09:00:00Z");
    expect(nextSlot(slot, "WEEKLY", new Date("2026-10-01T09:00:00Z"))?.toISOString()).toBe(
      "2026-10-08T09:00:00.000Z",
    );
    // Nine days late on a daily cadence: the next slot is the first one after now.
    expect(nextSlot(slot, "DAILY", new Date("2026-10-10T10:00:00Z"))?.toISOString()).toBe(
      "2026-10-11T09:00:00.000Z",
    );
    expect(nextSlot(slot, "OFF", NOW)).toBeNull();
    expect(firstSlot("DAILY", NOW)?.toISOString()).toBe("2026-10-11T12:00:00.000Z");
    expect(firstSlot("OFF", NOW)).toBeNull();
  });
});

describe("definitionProblems", () => {
  it("accepts a sound graph and names every problem of a bad one", () => {
    expect(
      definitionProblems([
        { key: "a", dependsOn: [] },
        { key: "b", dependsOn: ["a"] },
      ]),
    ).toEqual([]);
    expect(
      definitionProblems([
        { key: "a", dependsOn: ["b"] },
        { key: "b", dependsOn: ["a"] },
        { key: "c", dependsOn: ["c", "zzz"] },
        { key: "c", dependsOn: [] },
      ]),
    ).toEqual(["duplicate:c", "self:c", "unknown:c->zzz", "cycle:a,b"]);
  });
});
