import { ERROR_CODES, errorMessageKey, type ErrorCode } from "./codes";

export interface FieldError {
  /** Dot-separated path to the invalid field, e.g. `members.0.email`. */
  readonly path: string;
  /** Translation code under `validation.<code>`. */
  readonly code: string;
  /** Interpolation values for the translated message (e.g. `{ minimum: 3 }`). */
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface AppErrorOptions {
  /** Developer-facing message. Logged, never sent to clients. */
  readonly message?: string;
  /** Extra structured context for logs (redacted before logging). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Field-level validation errors (safe to send to clients). */
  readonly fields?: readonly FieldError[];
  readonly cause?: unknown;
}

/**
 * The application's single error type.
 * - `code`: stable, machine-readable identifier (see ERROR_CODES).
 * - `message`: technical message for developers and logs.
 * - `userMessageKey`: translation key for the friendly Arabic/English message.
 * - `metadata`: structured log context.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly userMessageKey: `errors.${ErrorCode}`;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly fields: readonly FieldError[];

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(
      options.message ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AppError";
    this.code = code;
    this.httpStatus = ERROR_CODES[code].httpStatus;
    this.userMessageKey = errorMessageKey(code);
    this.metadata = options.metadata ?? {};
    this.fields = options.fields ?? [];
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
