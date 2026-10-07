import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/server/auth/auth";

// Better Auth's HTTP endpoints (session, sign-out, email links). Email/password sign-up
// and sign-in are disabled here and run only through src/server/auth/credentials.ts.
// The instance is resolved per request so `next build` needs no auth secrets.

export function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).GET(request);
}

export function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).POST(request);
}
