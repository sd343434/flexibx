import type { z } from "zod";

import type { FieldError } from "../errors/app-error";

/**
 * Validation codes used in API responses. Each one has a translation under
 * `validation.<code>` in messages/{ar,en}.json, so messages are shown in the user's
 * language instead of Zod's English defaults.
 */
export const VALIDATION_CODES = [
  "required",
  "invalid_type",
  "too_small",
  "too_big",
  "invalid_format",
  "invalid_value",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid",
  // Domain codes raised by services (not by Zod).
  "slug_taken",
  "already_member",
  "invitation_pending",
  "last_owner",
  "invitation_invalid",
  "invitation_email_mismatch",
  "email_not_verified",
  // Marketing Core (Phase 3).
  "date_range",
  "budget_pair",
  "reference_not_found",
  "reference_archived",
  "invalid_transition",
  "content_locked",
  "publication_in_flight",
  "review_reason_required",
  "social_image_unsupported",
  "campaign_locked",
  "schedule_required",
  "schedule_in_past",
  "image_invalid",
  "file_required",
  "stale_status",
  "plan_changed",
  "plan_locked",
  "plan_not_approved",
  "plan_empty",
  "plan_item_converted",
  "metrics_csv_invalid",
  "metrics_import_not_voidable",
  "recommendation_changed",
  "recommendation_not_actionable",
  "insights_channel_unavailable",
  "insights_not_configured",
  "insights_not_connected",
  "insights_permission_missing",
  "insights_source_disabled",
  "insights_sync_running",
  // AI Marketing Engine (Phase 4).
  "ai_not_configured",
  "ai_timeout",
  "ai_unavailable",
  "ai_provider_busy",
  "ai_refused",
  "ai_invalid_output",
  "ai_daily_cap",
  "ai_already_used",
  "ai_not_usable",
  "ai_draft_only",
  // Generative video (Phase 4).
  "video_not_configured",
  "video_unsupported",
  "video_daily_budget",
  "video_approval_required",
  // AI Marketing Manager.
  "automation_paused",
  "approval_not_pending",
  "approval_changed",
  // Advertising platforms.
  // AI Social Manager.
  "social_not_configured",
  "social_page_unavailable",
  "social_platform_error",
  "social_reply_locked",
  "social_reply_empty",
  "social_cannot_verify",
  "social_nothing_to_learn",
  "social_content_not_approved",
  "social_sending_disabled",
  "social_reply_superseded",
  "social_reply_claimed",
  "social_connection_inactive",
  // Credits.
  "credits_insufficient",
  "credits_daily_cap",
  "credits_period_cap",
  "credits_feature_cap",
  "credits_amount_invalid",
  "credits_plan_unknown",
  "credits_payment_unavailable",
  "ads_not_configured",
  "ads_not_connected",
  "ads_oauth_invalid",
  "ads_permission_missing",
  "ads_token_expired",
  "ads_rate_limited",
  "ads_provider_error",
  "ads_operation_unavailable",
  "ads_account_unavailable",
  "ads_account_inactive",
  "ads_plan_objective_unsupported",
  "ads_plan_locked",
  "ads_execution_disabled",
  "ads_spend_limit_missing",
  "ads_spend_limit_exceeded",
  "ads_daily_limit_exceeded",
  "ads_identity_missing",
  "ads_identity_ambiguous",
  "ads_destination_missing",
  "ads_outcome_unknown",
  "ads_external_objects_exist",
  "ads_not_created",
  "whatsapp_sending_disabled",
  "whatsapp_no_consent",
  "whatsapp_template_unavailable",
  "whatsapp_window_closed",
  "whatsapp_number_unavailable",
  "whatsapp_invalid_number",
  "whatsapp_rate_limited",
  "whatsapp_send_pending",
  "whatsapp_sync_required",
  "whatsapp_marketing_opted_out",
  "creator_provider_disabled",
  "creator_upload_expired",
  "creator_upload_not_pending",
  "creator_upload_too_large",
  "creator_upload_size_mismatch",
  "creator_type_unsupported",
  "creator_source_not_ready",
  "creator_already_transcribed",
  "creator_no_audio",
  "creator_no_video",
  "creator_job_active",
  "creator_job_not_active",
  "creator_job_not_retryable",
  "creator_clip_not_approved",
  "creator_clip_out_of_bounds",
  "creator_language_unsupported",
  "creator_translation_exists",
  "creator_segment_out_of_bounds",
  "creator_stale",
] as const;

export type ValidationCode = (typeof VALIDATION_CODES)[number];

export function isValidationCode(value: unknown): value is ValidationCode {
  return typeof value === "string" && (VALIDATION_CODES as readonly string[]).includes(value);
}

type Params = Record<string, string | number>;

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

/** Reads the value at an issue path from the original (untrusted) input. */
function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

const NO_INPUT = Symbol("no-input");

function toFieldError(issue: z.core.$ZodIssue, rootInput: unknown): FieldError {
  const path = issue.path.map(String).join(".");
  const base = (code: ValidationCode, params?: Params): FieldError =>
    params === undefined || Object.keys(params).length === 0
      ? { path, code }
      : { path, code, params };

  switch (issue.code) {
    case "invalid_type": {
      // Zod 4 omits `issue.input` by default, so resolve the value from the original input.
      const value =
        "input" in issue
          ? issue.input
          : rootInput === NO_INPUT
            ? NO_INPUT
            : valueAtPath(rootInput, issue.path);
      return value === undefined
        ? base("required")
        : base("invalid_type", { expected: issue.expected });
    }
    case "too_small": {
      const minimum = numeric(issue.minimum);
      return base("too_small", {
        origin: issue.origin,
        ...(minimum === undefined ? {} : { minimum }),
      });
    }
    case "too_big": {
      const maximum = numeric(issue.maximum);
      return base("too_big", {
        origin: issue.origin,
        ...(maximum === undefined ? {} : { maximum }),
      });
    }
    case "invalid_format":
      return base("invalid_format", { format: issue.format });
    case "invalid_value":
      return base("invalid_value");
    case "not_multiple_of": {
      const divisor = numeric(issue.divisor);
      return base("not_multiple_of", divisor === undefined ? {} : { divisor });
    }
    case "unrecognized_keys":
      return base("unrecognized_keys", { keys: issue.keys.join(", ") });
    case "custom": {
      // A refinement may name its own code (e.g. `date_range`) through `params.code`.
      const code: unknown = issue.params?.code;
      return base(isValidationCode(code) ? code : "invalid");
    }
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
      return base("invalid");
  }
}

/**
 * Converts Zod issues to client-safe field errors. Pass the original input so missing
 * values (`required`) can be told apart from wrong types (`invalid_type`).
 */
export function zodIssuesToFieldErrors(
  issues: readonly z.core.$ZodIssue[],
  input: unknown = NO_INPUT,
): FieldError[] {
  return issues.map((issue) => toFieldError(issue, input));
}
