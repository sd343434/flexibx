import { ZodError } from "zod";

import { zodIssuesToFieldErrors } from "../validation/field-errors";
import { AppError, isAppError, type FieldError } from "./app-error";
import { INTERNAL_ERROR_CODES, type ErrorCode } from "./codes";

/** Wire format of every error response. Contains no prose, stack traces or internals. */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly messageKey: `errors.${ErrorCode}`;
    readonly requestId: string;
    readonly fields?: readonly FieldError[];
  };
}

/** Normalizes anything thrown into an AppError. Unknown errors become INTERNAL. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) {
    return new AppError("VALIDATION_FAILED", {
      message: "Input validation failed",
      fields: zodIssuesToFieldErrors(error.issues),
      cause: error,
    });
  }
  return new AppError("INTERNAL", { message: "Unhandled error", cause: error });
}

export function toErrorResponseBody(error: AppError, requestId: string): ErrorResponseBody {
  const exposeFields = !INTERNAL_ERROR_CODES.has(error.code) && error.fields.length > 0;
  return {
    error: {
      code: error.code,
      messageKey: error.userMessageKey,
      requestId,
      ...(exposeFields ? { fields: error.fields } : {}),
    },
  };
}

export function errorResponse(error: AppError, requestId: string): Response {
  return Response.json(toErrorResponseBody(error, requestId), {
    status: error.httpStatus,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}
