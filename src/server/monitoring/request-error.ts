import "server-only";

import { logger } from "../logger";

import { reportServerError } from "./alerts";

// Next.js `onRequestError` (src/instrumentation.ts): errors that escaped a render, a route
// handler or a server action not wrapped by withRoute/withAction. Logged with the route
// path, the router context and the error class/digest only — the error message can carry
// customer content, and the request path its query string, so neither is recorded.

/** Next.js control flow (redirect, notFound) is not an error. */
const CONTROL_FLOW =
  /^(NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

export function handleRequestError(
  error: unknown,
  request: { readonly method: string },
  context: { readonly routePath: string; readonly routeType: string },
): void {
  try {
    const digest =
      typeof error === "object" && error !== null && "digest" in error
        ? String(error.digest)
        : undefined;
    if (digest !== undefined && CONTROL_FLOW.test(digest)) return;
    const name = error instanceof Error ? error.name : typeof error;
    logger.error(
      {
        event: "request.unhandled_error",
        routePath: context.routePath,
        routeType: context.routeType,
        method: request.method,
        error: name,
        digest: digest ?? null,
      },
      "Unhandled server error",
    );
    reportServerError({
      source:
        context.routeType === "action"
          ? "action"
          : context.routeType === "route"
            ? "route"
            : "render",
      name: context.routePath,
      code: name,
      requestId: digest,
    });
  } catch {
    // Monitoring must never turn one error into two.
  }
}
