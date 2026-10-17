"use server";

import { revalidatePath } from "next/cache";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import type { ActionResult } from "@/server/http/action-handler";
import {
  addPlanItemAction,
  approvePlanAction,
  createPlanDraftsAction,
  generatePlanAction,
  removePlanItemAction,
  reopenPlanAction,
  savePlanBriefAction,
  updatePlanItemAction,
} from "@/server/marketing/plan-actions";

import type { FormValues, MarketingFormState } from "../../../marketing-actions";

// Form entry points for a campaign's content plan. Each forwards only the fields it
// names; the slug, campaign id and plan version are bound by the page. None of them is
// authority: the server action resolves the workspace from the session's membership and
// the service re-checks the role, the workspace and the version.

/** Which plan a form acts on, as rendered (version = the plan's version on the page). */
export interface PlanTarget {
  readonly slug: string;
  readonly locale: string;
  readonly campaignId: string;
  readonly version: number;
}

const ITEM_FIELDS = ["title", "brief", "contentType", "channel", "plannedDate", "included"];

function collect(formData: FormData, scalars: readonly string[], lists: readonly string[] = []) {
  const values: Record<string, string | string[]> = {};
  for (const name of scalars) {
    const value = formData.get(name);
    values[name] = typeof value === "string" ? value : "";
  }
  for (const name of lists) {
    values[name] = formData.getAll(name).filter((v): v is string => typeof v === "string");
  }
  return values;
}

function settle<T>(
  result: ActionResult<T>,
  values: FormValues,
  target: PlanTarget,
): MarketingFormState {
  if (!result.ok) return { error: result.error, values };
  const locale = isLocale(target.locale) ? target.locale : DEFAULT_LOCALE;
  revalidatePath(`/${locale}/w/${encodeURIComponent(target.slug)}`, "layout");
  return { done: true, at: Date.now() };
}

const ref = (target: PlanTarget) => ({
  slug: target.slug,
  campaignId: target.campaignId,
  version: target.version,
});

export async function submitPlanBrief(
  target: PlanTarget,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ["offer", "budgetNotes"], ["channels"]);
  return settle(await savePlanBriefAction({ ...ref(target), ...values }), values, target);
}

export async function submitGeneratePlan(
  target: PlanTarget,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ["count"]);
  return settle(
    await generatePlanAction({ ...ref(target), ...values, uiLocale: target.locale }),
    values,
    target,
  );
}

export async function submitAddPlanItem(
  target: PlanTarget,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ITEM_FIELDS);
  return settle(await addPlanItemAction({ ...ref(target), ...values }), values, target);
}

export async function submitUpdatePlanItem(
  target: PlanTarget,
  itemId: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = collect(formData, ITEM_FIELDS);
  return settle(await updatePlanItemAction({ ...ref(target), itemId, ...values }), values, target);
}

export async function submitRemovePlanItem(
  target: PlanTarget,
  itemId: string,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await removePlanItemAction({ ...ref(target), itemId }), {}, target);
}

export async function submitApprovePlan(
  target: PlanTarget,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await approvePlanAction(ref(target)), {}, target);
}

export async function submitReopenPlan(
  target: PlanTarget,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await reopenPlanAction(ref(target)), {}, target);
}

export async function submitCreatePlanDrafts(
  target: PlanTarget,
  _previous: MarketingFormState,
): Promise<MarketingFormState> {
  return settle(await createPlanDraftsAction(ref(target)), {}, target);
}
