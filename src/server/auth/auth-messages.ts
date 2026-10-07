import type { ErrorCode } from "../errors/codes";

// Pure module: which message the authentication pages show for a failed attempt.
// Better Auth's own error codes and texts never reach the UI: credentials.ts collapses
// them into ACCEPTED / INVALID_CREDENTIALS / VALIDATION_FAILED / INTERNAL, and this
// maps those outcomes to Flexibx message keys under `auth.errors.*`.

export const AUTH_ERROR_MESSAGE_KEYS = {
  /** Every sign-in failure: unknown email, wrong password, malformed input. */
  invalidCredentials: "auth.errors.invalidCredentials",
  /** Sign-up input that fails validation (details are shown per field). */
  invalidInput: "auth.errors.invalidInput",
  /** Anything else; no detail is shown. */
  unavailable: "auth.errors.unavailable",
} as const;

export type AuthErrorMessageKey =
  (typeof AUTH_ERROR_MESSAGE_KEYS)[keyof typeof AUTH_ERROR_MESSAGE_KEYS];

export type AuthFailure = "INVALID_CREDENTIALS" | ErrorCode;

export function authErrorMessageKey(failure: AuthFailure): AuthErrorMessageKey {
  if (failure === "INVALID_CREDENTIALS") return AUTH_ERROR_MESSAGE_KEYS.invalidCredentials;
  if (failure === "VALIDATION_FAILED") return AUTH_ERROR_MESSAGE_KEYS.invalidInput;
  return AUTH_ERROR_MESSAGE_KEYS.unavailable;
}
