import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/server/auth/auth";
import { isInternalOnlyAuthPath } from "@/server/auth/auth-config";

// Better Auth's public HTTP endpoints (session, sign-out). Every email/password flow is
// disabled here (DISABLED_HTTP_PATHS) and runs only through Flexibx server code; the
// internal rate-limit checkpoint and the reset callback are refused outright.
// The instance is resolved per request so `next build` needs no auth secrets.

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
}

export function GET(request: Request): Promise<Response> {
  if (isInternalOnlyAuthPath(new URL(request.url).pathname)) return Promise.resolve(notFound());
  return toNextJsHandler(getAuth()).GET(request);
}

export function POST(request: Request): Promise<Response> {
  if (isInternalOnlyAuthPath(new URL(request.url).pathname)) return Promise.resolve(notFound());
  return toNextJsHandler(getAuth()).POST(request);
}
