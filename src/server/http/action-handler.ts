import "server-only";

import { randomUUID } from "node:crypto";

import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import { toAppError, toErrorResponseBody, type ErrorResponseBody } from "../errors/http";
import { createRequestLogger, type Logger } from "../logger";
import { parseInput } from "../validation/parse";

/** What a server action returns to the client: data, or a code-only error (no prose). */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ErrorResponseBody["error"] };

export interface ActionDefinition<S extends z.ZodType, R> {
  /** Stable action name for logs, e.g. `workspace.create`. */
  readonly name: string;
  readonly input: S;
  readonly handler: (
    input: z.output<S>,
    context: { readonly requestId: string; readonly logger: Logger },
  ) => Promise<R> | R;
}

/**
 * Wraps a server action with the same cross-cutting rules as `withRoute`: Zod
 * validation of the (untrusted) input, a request id, unified code-only errors and
 * structured logging. Authorization happens inside the handler through
 * `requireUser()` / `requireWorkspaceAccess(slug, action)` — never from ids or roles in
 * the input. Next.js itself rejects cross-origin server action calls. Next's own control
 * flow (redirect, notFound) is re-thrown untouched.
 */
export function withAction<S extends z.ZodType, R>(definition: ActionDefinition<S, R>) {
  return async function action(rawInput: unknown): Promise<ActionResult<R>> {
    const requestId = randomUUID();
    const log = createRequestLogger({ requestId, route: definition.name, method: "ACTION" });
    try {
      const input = parseInput(definition.input, rawInput, "action");
      const data = await definition.handler(input, { requestId, logger: log });
      return { ok: true, data };
    } catch (error) {
      unstable_rethrow(error);
      const appError = toAppError(error);
      if (appError.httpStatus >= 500) {
        log.error(
          { err: error, code: appError.code, metadata: appError.metadata },
          `Action failed: ${appError.message}`,
        );
      } else {
        log.warn(
          { code: appError.code, metadata: appError.metadata, fields: appError.fields },
          `Action rejected: ${appError.message}`,
        );
      }
      return { ok: false, error: toErrorResponseBody(appError, requestId).error };
    }
  };
}
