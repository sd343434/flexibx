// Node resolve hook for the retention CLI: `server-only` exists to stop server modules
// from reaching client bundles and throws outside React Server Components. This process
// is a server process, so the marker resolves to an empty module here (and only here).
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  return nextResolve(specifier, context);
}
