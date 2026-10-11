import { AppError } from "../errors/app-error";
import type { ValidationCode } from "../validation/field-errors";

import { AdPlatformError, type AdFailure } from "./adapter";

// Advertising failures as application errors: a stable code and one field code the UI
// translates. Never the platform's message, a token or a URL.

export function adsError(
  code: "CONFLICT" | "SERVICE_UNAVAILABLE" | "RATE_LIMITED" | "NOT_FOUND",
  field: ValidationCode,
  metadata: Record<string, unknown> = {},
): AppError {
  return new AppError(code, {
    message: `Advertising: ${field}`,
    fields: [{ path: "ads", code: field }],
    metadata,
  });
}

export const adsNotConfigured = () => adsError("SERVICE_UNAVAILABLE", "ads_not_configured");
export const adsNotConnected = () => adsError("CONFLICT", "ads_not_connected");
export const adsUnavailableOperation = (operation: string) =>
  adsError("CONFLICT", "ads_operation_unavailable", { operation });

const FIELD: Readonly<Record<AdFailure, ValidationCode>> = {
  oauth_invalid: "ads_oauth_invalid",
  permission_missing: "ads_permission_missing",
  token_expired: "ads_token_expired",
  rate_limited: "ads_rate_limited",
  invalid_request: "ads_provider_error",
  provider_error: "ads_provider_error",
  unavailable: "ads_operation_unavailable",
};

/** An adapter failure → AppError (the platform's numeric code is kept as metadata). */
export function fromPlatformError(error: AdPlatformError): AppError {
  // A write that may have taken effect is never reported as a plain failure.
  if (error.uncertain) {
    return adsError("SERVICE_UNAVAILABLE", "ads_outcome_unknown", {
      platformCode: error.platformCode,
    });
  }
  const code =
    error.kind === "rate_limited"
      ? "RATE_LIMITED"
      : error.kind === "provider_error" || error.kind === "invalid_request"
        ? "SERVICE_UNAVAILABLE"
        : "CONFLICT";
  return adsError(code, FIELD[error.kind], { platformCode: error.platformCode });
}

export function failureCodeOf(error: unknown): string {
  return error instanceof AdPlatformError ? error.kind : "unexpected";
}
