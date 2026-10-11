import type { GuardedPrismaClient } from "../db/prisma";
import type { TenantContext } from "../tenancy/context";

import type { ActionDescription } from "./approval-snapshot";
import type { TaskRisk } from "./planner";

// The contract between the orchestration engine and a workflow. A workflow is a fixed,
// code-defined graph of tasks; each task names a handler and a risk class. Handlers do
// one coherent unit of work and return JSON output that later tasks receive. Specialist
// capabilities (AI planning, drafting, later publishing) are handlers, not free agents:
// the graph, retries, limits and permissions are decided here, never by a model.

export interface AutomationPolicySnapshot {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly allowDrafts: boolean;
  readonly maxDraftsPerRun: number;
}

/** What a handler gets: the run's workspace, its authority, its inputs and a deadline. */
export interface TaskContext<S = unknown> {
  readonly db: GuardedPrismaClient;
  readonly runId: string;
  readonly taskKey: string;
  /** The member whose authority this run uses (re-checked before every task). */
  readonly actor: TenantContext;
  readonly policy: AutomationPolicySnapshot;
  /** Outputs of the tasks this one depends on, by task key. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Aborted when the task's timeout passes; handlers pass it on to slow calls. */
  readonly signal: AbortSignal;
  readonly services: S;
}

export type TaskResult =
  | { readonly status: "succeeded"; readonly output: Record<string, unknown> }
  | { readonly status: "skipped"; readonly output: Record<string, unknown> };

/**
 * A handler failure with a stable code. `retryable`: worth another attempt (transient).
 * Anything else a handler throws counts as retryable with code "unexpected".
 */
export class TaskError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "TaskError";
  }
}

/** What `describe` gets: the same view as the handler, without a deadline. */
export type DescribeContext<S = unknown> = Omit<TaskContext<S>, "signal">;

export interface TaskDefinition<S = unknown> {
  readonly key: string;
  readonly dependsOn: readonly string[];
  readonly risk: TaskRisk;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  /**
   * Required for EXTERNAL and SPEND tasks: the exact action `run` would take, built
   * deterministically from the inputs and current data (never by a model). A person
   * approves this description; it is built again right before `run`, and any change
   * requires a new approval. `run` must do only what it describes.
   */
  readonly describe?: (context: DescribeContext<S>) => Promise<ActionDescription>;
  readonly run: (context: TaskContext<S>) => Promise<TaskResult>;
}

export interface WorkflowDefinition<S = unknown> {
  /** Stored on each run, e.g. `content_planning`. */
  readonly id: string;
  readonly tasks: readonly TaskDefinition<S>[];
  /** The task whose output becomes the run's summary. */
  readonly summaryTask: string;
}
