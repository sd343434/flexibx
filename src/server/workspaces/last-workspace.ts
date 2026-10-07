import { LOCALES } from "@/i18n/config";

import { normalizeWorkspaceSlug, WORKSPACE_SLUG_PATTERN } from "../tenancy/slug";

// The "last workspace" cookie (Phase 2 decision 10). It holds a workspace slug only,
// is a convenience for picking a default on `/{locale}/workspaces`, and is NEVER a
// security reference: every read is validated against the user's memberships.
// Pure module: used by the proxy (write) and the workspace landing page (read).

export const LAST_WORKSPACE_COOKIE = "flexibx.last_workspace";
export const LAST_WORKSPACE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

const WORKSPACE_PATH = new RegExp(`^/(?:${LOCALES.join("|")})/w/([^/]+)(?:/|$)`);

/** A cookie or path value as a well-formed slug, or undefined. Not an access check. */
export function parseWorkspaceSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const slug = normalizeWorkspaceSlug(decoded);
  return WORKSPACE_SLUG_PATTERN.test(slug) ? slug : undefined;
}

/** The workspace slug of a `/{locale}/w/{slug}…` page path, if well-formed. */
export function workspaceSlugFromPath(pathname: string): string | undefined {
  const match = WORKSPACE_PATH.exec(pathname);
  return match === null ? undefined : parseWorkspaceSlug(match[1]);
}

/** `Set-Cookie` value remembering `slug`. HttpOnly: no script ever needs it. */
export function lastWorkspaceSetCookie(slug: string, secure: boolean): string {
  return [
    `${LAST_WORKSPACE_COOKIE}=${slug}`,
    "Path=/",
    `Max-Age=${String(LAST_WORKSPACE_MAX_AGE_SECONDS)}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
