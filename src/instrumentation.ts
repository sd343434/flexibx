// Runs once when a server instance starts, before it serves requests (Next.js
// instrumentation). In production an invalid environment stops the start-up here, with the
// names of the variables at fault, instead of failing on the first request that needs them.
// The Node.js-only work lives in ./server/startup-check and ./server/monitoring (never
// loaded by the Edge runtime).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupCheck } = await import("./server/startup-check");
  runStartupCheck();
}

/**
 * Server errors that escaped every handler (renders, unwrapped route handlers and server
 * actions): logged and alerted without the error message or query string.
 */
export async function onRequestError(
  error: unknown,
  request: { readonly path: string; readonly method: string },
  context: { readonly routePath: string; readonly routeType: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { handleRequestError } = await import("./server/monitoring/request-error");
    handleRequestError(error, request, context);
  } catch {
    // Monitoring must never break request handling.
  }
}
