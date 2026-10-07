import "server-only";

import { notFound } from "next/navigation";
import { cache } from "react";

import type { Locale } from "@/i18n/config";
import { requirePageUser } from "@/server/auth/session";
import { isAppError } from "@/server/errors/app-error";
import { getWorkspaceShell, type WorkspaceShell } from "@/server/workspaces/workspace-queries";

/**
 * The gate for every page under `/{locale}/w/{slug}`: no session → sign-in with a
 * return path; unknown, deleted or foreign workspace → the same 404. Layouts are not
 * re-run on client navigation, so the layout AND each page call this (deduplicated per
 * request).
 */
export const loadWorkspace = cache(
  async (locale: Locale, slug: string): Promise<WorkspaceShell> => {
    await requirePageUser(locale, `/${locale}/w/${encodeURIComponent(slug)}`);
    return getWorkspaceShell(slug).catch((error: unknown) => {
      if (isAppError(error) && error.code === "NOT_FOUND") notFound();
      throw error;
    });
  },
);
