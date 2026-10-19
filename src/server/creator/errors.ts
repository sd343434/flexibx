import { AppError, isAppError } from "../errors/app-error";
import type { ErrorCode } from "../errors/codes";
import type { ValidationCode } from "../validation/field-errors";

import { MediaToolError } from "./media/tools";
import { CreatorProviderError } from "./providers/types";

// Errors of the Creator Studio. Pure.

/** A refusal shown to the person (a translated `validation.<code>` message). */
export function creatorError(
  code: ErrorCode,
  field: ValidationCode,
  params: Record<string, string | number> = {},
): AppError {
  return new AppError(code, {
    message: `Creator Studio: ${field}`,
    fields: [{ path: "studio", code: field, params }],
    metadata: { ...params },
  });
}

/**
 * Why a job step failed, as stored on the job and the step (codes only, shown through
 * `studio.failures.<code>`). `retryable`: the job goes back to the queue (bounded by
 * MAX_ATTEMPTS); otherwise it fails at once — retrying could not succeed.
 */
export const JOB_FAILURES = [
  "upload_missing",
  "size_mismatch",
  "too_large",
  "unsupported_format",
  "type_mismatch",
  "unreadable_media",
  "too_long",
  "no_audio",
  "no_video",
  "provider_disabled",
  "external_consent_missing",
  "unsupported_language",
  "provider_unavailable",
  "provider_quota",
  "provider_invalid_output",
  "provider_timeout",
  "provider_rate_limited",
  "provider_rejected",
  "provider_auth",
  "provider_outcome_unknown",
  "credits_insufficient",
  "credits_cap",
  "step_timeout",
  "ffmpeg_failed",
  "render_invalid",
  "storage_unavailable",
  "checksum_mismatch",
  "worker_disk_full",
  "project_deleted",
  "deadline_reached",
  "max_attempts",
  "cancelled",
  "internal_error",
] as const;

export type JobFailure = (typeof JOB_FAILURES)[number];

export class StepFailure extends Error {
  constructor(
    readonly failure: JobFailure,
    readonly retryable: boolean,
  ) {
    super(`Creator step failed: ${failure}`);
    this.name = "StepFailure";
  }
}

/** This worker no longer owns the job (lease expired and taken, or the job cancelled). */
export class LeaseLostError extends Error {
  constructor() {
    super("Creator job lease lost");
    this.name = "LeaseLostError";
  }
}

const PROVIDER_FAILURES: Readonly<Record<CreatorProviderError["failure"], JobFailure>> = {
  unsupported_language: "unsupported_language",
  too_long: "too_long",
  quota_exceeded: "provider_quota",
  unavailable: "provider_unavailable",
  invalid_output: "provider_invalid_output",
  timeout: "provider_timeout",
  rate_limited: "provider_rate_limited",
  rejected: "provider_rejected",
  auth: "provider_auth",
  outcome_unknown: "provider_outcome_unknown",
};

/** Maps whatever a step threw to a stored failure (never a message or a stack). */
export function classifyFailure(error: unknown, timedOut: boolean): StepFailure {
  if (error instanceof StepFailure) return error;
  if (timedOut) return new StepFailure("step_timeout", true);
  if (error instanceof CreatorProviderError) {
    return new StepFailure(PROVIDER_FAILURES[error.failure], error.retryable);
  }
  if (error instanceof MediaToolError) {
    if (error.code === "timeout") return new StepFailure("step_timeout", true);
    return new StepFailure("ffmpeg_failed", error.code === "not_found");
  }
  if (isAppError(error)) {
    const field = error.fields[0]?.code;
    if (field === "credits_insufficient") return new StepFailure("credits_insufficient", false);
    if (field?.startsWith("credits_") === true) return new StepFailure("credits_cap", false);
    if (error.code === "SERVICE_UNAVAILABLE") return new StepFailure("storage_unavailable", true);
  }
  return new StepFailure("internal_error", true);
}
