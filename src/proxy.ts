import createIntlMiddleware from "next-intl/middleware";
import { NextRequest, type NextResponse } from "next/server";

import { routing } from "./i18n/routing";
import { refreshSessionCookiesForRequest } from "./server/auth/auth";
import { hasSessionCookie } from "./server/auth/session-refresh";
import {
  LAST_WORKSPACE_COOKIE,
  lastWorkspaceSetCookie,
  workspaceSlugFromPath,
} from "./server/workspaces/last-workspace";
import { buildContentSecurityPolicy } from "./security/csp";

const handleI18nRouting = createIntlMiddleware(routing);

/**
 * Edge of every page request. Responsibilities are deliberately limited to:
 *  1. locale negotiation / redirects (next-intl),
 *  2. a per-request CSP nonce, and
 *  3. renewing the session cookie when Better Auth rolls the session, because Server
 *     Components cannot write cookies (see src/server/auth/session-refresh.ts), and
 *  4. remembering the last workspace slug visited by a signed-in browser (a convenience
 *     cookie, validated against memberships on every use — see last-workspace.ts).
 * It performs NO authentication or authorization — that is enforced server-side in
 * route handlers and services (tenancy layer).
 */
export default async function proxy(request: NextRequest): Promise<NextResponse> {
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
  const cookieHeader = request.headers.get("cookie");
  for (const setCookie of await refreshSessionCookiesForRequest(cookieHeader)) {
    response.headers.append("set-cookie", setCookie);
  }

  const slug = hasSessionCookie(cookieHeader)
    ? workspaceSlugFromPath(request.nextUrl.pathname)
    : undefined;
  if (slug !== undefined && request.cookies.get(LAST_WORKSPACE_COOKIE)?.value !== slug) {
    const secure = process.env.APP_URL?.startsWith("https://") ?? false;
    response.headers.append("set-cookie", lastWorkspaceSetCookie(slug, secure));
  }
  return response;
}

export const config = {
  // Pages only: skip API routes, Next internals and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
