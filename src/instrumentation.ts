// Runs once when a server instance starts, before it serves requests (Next.js
// instrumentation). In production an invalid environment stops the start-up here, with the
// names of the variables at fault, instead of failing on the first request that needs them.
// The Node.js-only work lives in ./server/startup-check (never loaded by the Edge runtime).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupCheck } = await import("./server/startup-check");
  runStartupCheck();
}
