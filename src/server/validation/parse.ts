import type { z } from "zod";

import { AppError } from "../errors/app-error";
import { zodIssuesToFieldErrors } from "./field-errors";

/** Parses untrusted input; throws VALIDATION_FAILED with localized field codes on failure. */
export function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  source = "input",
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError("VALIDATION_FAILED", {
      message: `Invalid ${source}`,
      fields: zodIssuesToFieldErrors(result.error.issues, input),
      metadata: { source },
    });
  }
  return result.data;
}
