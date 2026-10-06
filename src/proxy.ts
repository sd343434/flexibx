import createIntlMiddleware from "next-intl/middleware";
import { NextRequest, type NextResponse } from "next/server";

import { routing } from "./i18n/routing";
import { buildContentSecurityPolicy } from "./security/csp";

const handleI18nRouting = createIntlMiddleware(routing);

/**
 * Edge of every page request. Responsibilities are deliberately limited to:
 *  1. locale negotiation / redirects (next-intl), and
 *  2. a per-request CSP nonce.
 * It performs NO authentication or authorization — that is enforced server-side in
 * route handlers and services (tenancy layer).
 */
export default function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV === "development",
    upgradeInsecureRequests: process.env.APP_URL?.startsWith("https://") ?? false,
  });

  // Next.js reads the CSP request header to apply the nonce to its own scripts;
  // the layout reads `x-nonce` for third-party inline scripts (next-themes).
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const response = handleI18nRouting(new NextRequest(request, { headers }));
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Pages only: skip API routes, Next internals and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
