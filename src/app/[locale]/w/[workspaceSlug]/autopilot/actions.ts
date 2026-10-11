"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import {
  advanceRunAction,
  cancelRunAction,
  decideApprovalAction,
  setAutomationPausedAction,
  startPlanningRunAction,
  updateAutomationPolicyAction,
} from "@/server/orchestration/automation-actions";

import type { MarketingFormState } from "../marketing-actions";

// Form entry points for the AI Marketing Manager. Each forwards only the fields it
// names; the slug selects one of the session user's memberships. Permissions, limits and
// what automation may do are decided on the server only.

const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const page = (locale: string, slug: string) =>
  `/${toLocale(locale)}/w/${encodeURIComponent(slug)}/autopilot`;

function back(locale: string, slug: string): never {
  revalidatePath(page(locale, slug));
  redirect(page(locale, slug));
}

export async function submitAutomationPolicy(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  const values = {
    enabled: text("enabled"),
    planningCadence: text("planningCadence"),
    allowDrafts: text("allowDrafts"),
    maxDraftsPerRun: text("maxDraftsPerRun"),
  };
  const result = await updateAutomationPolicyAction({
    slug,
    enabled: values.enabled === "on",
    planningCadence: values.planningCadence as "OFF",
    allowDrafts: values.allowDrafts === "on",
    maxDraftsPerRun: values.maxDraftsPerRun,
  });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(page(locale, slug));
  return { done: true, at: Date.now() };
}

export async function submitAutomationPaused(
  slug: string,
  locale: string,
  paused: boolean,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await setAutomationPausedAction({ slug, paused });
  if (!result.ok) return { error: result.error, values: {} };
  back(locale, slug);
}

export async function submitPlanningRun(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await startPlanningRunAction({ slug });
  if (!result.ok) return { error: result.error, values: {} };
  back(locale, slug);
}

export async function submitAdvanceRun(
  slug: string,
  locale: string,
  runId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await advanceRunAction({ slug, runId });
  if (!result.ok) return { error: result.error, values: {} };
  back(locale, slug);
}

export async function submitCancelRun(
  slug: string,
  locale: string,
  runId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await cancelRunAction({ slug, runId });
  if (!result.ok) return { error: result.error, values: {} };
  back(locale, slug);
}

export async function submitApprovalDecision(
  slug: string,
  locale: string,
  taskId: string,
  decision: "APPROVED" | "REJECTED",
  snapshotHash: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const note = formData.get("note");
  const result = await decideApprovalAction({
    slug,
    taskId,
    decision,
    snapshotHash,
    note: typeof note === "string" ? note : "",
  });
  if (!result.ok) return { error: result.error, values: {} };
  back(locale, slug);
}
