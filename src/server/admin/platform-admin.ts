import "server-only";

import { notFound, redirect } from "next/navigation";

import type { Locale } from "@/i18n/config";

import { getCurrentSession } from "../auth/session";
import { getSystemDb } from "../db/client";
import { AppError } from "../errors/app-error";
import { logger } from "../logger";

import {
  ADMIN_CHANGE_MFA_MAX_AGE_MS,
  ADMIN_MFA_MAX_AGE_MS,
  platformAdminAccess,
  type PlatformAdminAccess,
} from "./platform-admin-access";

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
// not secret; access control relies only on these checks.)
//
// Multi-factor authentication is mandatory, in every environment (no bypass switch):
// the account must have two-factor enabled AND the current session must have been
// created by a second-factor verification within ADMIN_MFA_MAX_AGE_MS — within
// ADMIN_CHANGE_MFA_MAX_AGE_MS for actions that change platform state
// (platform-admin-access.ts). A session from before enrollment, from a password change
// or from any path that skipped the second factor does not qualify, whatever the
// account's state. Every admin page and action goes through the two functions below.
//
// SYSTEM PATH (reviewed): reads three columns of the current user's own row.

export interface PlatformAdminContext {
  readonly userId: string;
}

async function adminRow(system: PrismaClient, userId: string) {
  return system.user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true, emailVerified: true, twoFactorEnabled: true },
  });
}

async function currentAccess(maxAgeMs: number = ADMIN_MFA_MAX_AGE_MS): Promise<{
  readonly access: PlatformAdminAccess;
  readonly userId: string | null;
}> {
  const session = await getCurrentSession();
  if (session === null) return { access: "NOT_ADMIN", userId: null };
  const row = await adminRow(getSystemDb(), session.user.id);
  const access = platformAdminAccess(row, session.mfaVerifiedAt, new Date(), maxAgeMs);
  if (access === "MFA_ENROLLMENT_REQUIRED" || access === "MFA_VERIFICATION_REQUIRED") {
    // A real administrator without a qualifying second factor: worth seeing in the logs
    // (an attacker holding only a password or an old session lands here).
    logger.warn(
      { event: "admin.mfa_required", access, userId: session.user.id },
      "Admin MFA required",
    );
  }
  return { access, userId: session.user.id };
}

const hidden = () => new AppError("NOT_FOUND", { metadata: { resource: "route" } });

/**
 * For server actions and route handlers: the admin, NOT_FOUND for everyone else (also
 * when signed out), FORBIDDEN for an administrator without a qualifying second factor.
 * `change: true` (every action that changes platform state) needs the second factor
 * within ADMIN_CHANGE_MFA_MAX_AGE_MS (re-sign-in for changes, docs/STORAGE_PROVIDERS.md §9).
 */
export async function requirePlatformAdmin(
  options: { readonly change?: boolean } = {},
): Promise<PlatformAdminContext> {
  const { access, userId } = await currentAccess(
    options.change === true ? ADMIN_CHANGE_MFA_MAX_AGE_MS : ADMIN_MFA_MAX_AGE_MS,
  );
  if (access === "GRANTED" && userId !== null) return { userId };
  if (access === "NOT_ADMIN") throw hidden();
  throw new AppError("FORBIDDEN", { metadata: { reason: "admin_mfa_required" } });
}

/**
 * For admin pages: anyone who is not a signed-in platform administrator — including a
 * signed-out visitor — gets the standard 404 (no sign-in redirect that would reveal the
 * area). An administrator without a qualifying second factor is sent to the account
 * security page to enroll or to sign in again with it.
 */
export async function requirePlatformAdminPage(locale: Locale): Promise<PlatformAdminContext> {
  const { access, userId } = await currentAccess();
  if (access === "GRANTED" && userId !== null) return { userId };
  if (access === "MFA_ENROLLMENT_REQUIRED") redirect(`/${locale}/account/security?admin=enroll`);
  if (access === "MFA_VERIFICATION_REQUIRED") redirect(`/${locale}/account/security?admin=verify`);
  notFound();
}
