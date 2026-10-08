import "server-only";

import { notFound } from "next/navigation";

import type { Locale } from "@/i18n/config";
import { requireLocale } from "@/i18n/params";
import { isAppError } from "@/server/errors/app-error";
import type { WorkspaceOverview } from "@/server/workspaces/workspace-queries";

import { loadWorkspace } from "./load-workspace";

export interface WorkspaceRouteParams {
  readonly locale: string;
  readonly workspaceSlug: string;
}

/** The gate every Marketing Core page passes first (session, membership, locale). */
export async function openWorkspacePage(
  params: Promise<WorkspaceRouteParams>,
): Promise<{ readonly locale: Locale; readonly workspace: WorkspaceOverview }> {
  const { locale: rawLocale, workspaceSlug } = await params;
  const locale = requireLocale(rawLocale);
  const { workspace } = await loadWorkspace(locale, workspaceSlug);
  return { locale, workspace };
}

/**
 * Runs a page query: FORBIDDEN becomes `null` (the page shows its "not for your role"
 * state); NOT_FOUND — an unknown id or another workspace's id — is the 404 page.
 */
export async function guardPage<T>(query: Promise<T>): Promise<T | null> {
  try {
    return await query;
  } catch (error) {
    if (isAppError(error) && error.code === "FORBIDDEN") return null;
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

/** A plain calendar date stored at UTC midnight, as `YYYY-MM-DD` for date inputs. */
export function dateInput(value: Date | null): string {
  return value === null ? "" : value.toISOString().slice(0, 10);
}

/** Values of a multi-line list field. */
export function linesInput(values: readonly string[]): string {
  return values.join("\n");
}
