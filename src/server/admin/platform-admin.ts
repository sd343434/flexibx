import "server-only";

import { notFound } from "next/navigation";

import { getCurrentUser } from "../auth/session";
import { getSystemDb } from "../db/client";
import { AppError } from "../errors/app-error";

import type { PrismaClient } from "@/generated/prisma/client";

// Internal platform administration (Flexibx staff), separate from workspace roles: a
// workspace OWNER is a customer and never a platform administrator.
//
// Who is one: users.is_platform_admin = true AND a verified email. The flag is
// - not settable through any auth input (`input: false` in the Better Auth config),
// - not set by sign-up, seed or any application code (enforced by a static test),
// - granted only by an operator directly in the database (runbook).
// It is read from the database on every check (no session or cookie cache), so revoking
// it takes effect on the next request. Everyone else gets the same 404 as an unknown
// page. (The admin UI text ships in the shared message bundle, so the area's existence is
// not secret; access control relies only on these checks.) MFA and fresh-session checks
// are NOT enforced yet: mandatory before production (docs/STORAGE_PROVIDERS.md §9).
//
// SYSTEM PATH (reviewed): reads two columns of the current user's own row.

export interface PlatformAdminContext {
  readonly userId: string;
}

/** True only for a verified user whose platform-admin flag is set in the database. */
export async function isPlatformAdmin(system: PrismaClient, userId: string): Promise<boolean> {
  const row = await system.user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true, emailVerified: true },
  });
  return row?.isPlatformAdmin === true && row.emailVerified;
}

const hidden = () => new AppError("NOT_FOUND", { metadata: { resource: "route" } });

/** For server actions and route handlers: the admin, or NOT_FOUND (also when signed out). */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const user = await getCurrentUser();
  if (user === null || !(await isPlatformAdmin(getSystemDb(), user.id))) throw hidden();
  return { userId: user.id };
}

/**
 * For admin pages: anyone who is not a signed-in platform administrator — including a
 * signed-out visitor — gets the standard 404 (no sign-in redirect that would reveal the
 * area). Administrators sign in first, then open /{locale}/admin.
 */
export async function requirePlatformAdminPage(): Promise<PlatformAdminContext> {
  const user = await getCurrentUser();
  if (user === null || !(await isPlatformAdmin(getSystemDb(), user.id))) notFound();
  return { userId: user.id };
}
