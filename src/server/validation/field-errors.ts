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
  "campaign_locked",
  "schedule_required",
  "schedule_in_past",
  "image_invalid",
  "file_required",
  "stale_status",
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
