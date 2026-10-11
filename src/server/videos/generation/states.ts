import type { VideoAttemptState, VideoJobState } from "@/generated/prisma/enums";

// Legal state transitions of video jobs and attempts (§4.2.2). Pure (unit tested). The
// database enforces the same tables (migration 20261010110000_video_generation_core,
// `video_*_transition_trigger`); a unit test keeps the two in sync.

export const JOB_TRANSITIONS: Readonly<Record<VideoJobState, readonly VideoJobState[]>> = {
  RESERVED: ["IN_PROGRESS", "FAILED", "CANCELLED"],
  IN_PROGRESS: ["READY_FOR_REVIEW", "FAILED", "LIMIT_REACHED", "NEEDS_RECONCILIATION", "CANCELLED"],
  NEEDS_RECONCILIATION: ["IN_PROGRESS", "FAILED"],
  READY_FOR_REVIEW: ["ACCEPTED", "REJECTED"],
  ACCEPTED: [],
  REJECTED: [],
  FAILED: [],
  LIMIT_REACHED: [],
  CANCELLED: [],
};

export const ATTEMPT_TRANSITIONS: Readonly<
  Record<VideoAttemptState, readonly VideoAttemptState[]>
> = {
  INTENDED: ["SUBMITTED", "FAILED_RETRYABLE", "FAILED_PERMANENT", "OUTCOME_UNKNOWN", "CANCELLED"],
  OUTCOME_UNKNOWN: ["SUBMITTED", "FAILED_RETRYABLE"],
  SUBMITTED: [
    "OUTPUT_READY",
    "FAILED_RETRYABLE",
    "FAILED_PERMANENT",
    "REFUSED_BY_PROVIDER",
    "TIMED_OUT",
    "CANCELLED",
  ],
  OUTPUT_READY: ["VALIDATED", "FAILED_RETRYABLE", "TIMED_OUT"],
  VALIDATED: [],
  FAILED_RETRYABLE: [],
  FAILED_PERMANENT: [],
  REFUSED_BY_PROVIDER: [],
  TIMED_OUT: [],
  CANCELLED: [],
};

/** Job states in which work may still happen (the runner and recovery pick these up). */
export const ACTIVE_JOB_STATES = [
  "RESERVED",
  "IN_PROGRESS",
] as const satisfies readonly VideoJobState[];

/** Attempt states that still have a provider job to follow (never resubmitted). */
export const OPEN_ATTEMPT_STATES = [
  "INTENDED",
  "SUBMITTED",
  "OUTPUT_READY",
  "OUTCOME_UNKNOWN",
] as const satisfies readonly VideoAttemptState[];

export class IllegalTransitionError extends Error {
  constructor(kind: "job" | "attempt", from: string, to: string) {
    super(`Illegal video ${kind} transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransitionJob(from: VideoJobState, to: VideoJobState): boolean {
  return from === to || JOB_TRANSITIONS[from].includes(to);
}

export function canTransitionAttempt(from: VideoAttemptState, to: VideoAttemptState): boolean {
  return from === to || ATTEMPT_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: VideoJobState, to: VideoJobState): void {
  if (!canTransitionJob(from, to)) throw new IllegalTransitionError("job", from, to);
}

export function assertAttemptTransition(from: VideoAttemptState, to: VideoAttemptState): void {
  if (!canTransitionAttempt(from, to)) throw new IllegalTransitionError("attempt", from, to);
}
