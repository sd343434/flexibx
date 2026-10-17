import "server-only";

import { admitGeneration } from "../ai/ai-actions";
import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { requireWorkspaceAccess } from "../tenancy/access";

import {
  addPlanItemInputSchema,
  generatePlanInputSchema,
  planStepInputSchema,
  removePlanItemInputSchema,
  savePlanBriefInputSchema,
  updatePlanItemInputSchema,
} from "./campaign-plan";
import {
  addPlanItem,
  approvePlan,
  createDraftsFromPlan,
  generatePlanItems,
  removePlanItem,
  reopenPlan,
  savePlanBrief,
  updatePlanItem,
} from "./plan-service";

// Server actions for campaign plans (Pass 4). Each one: strict Zod input → session →
// `requireWorkspaceAccess(slug, action)` → the plan service, which re-checks every
// permission, scopes every query to the workspace and refuses a stale `version`.
// Proposing items with AI also passes the AI engine's admission (configured provider,
// per-user and per-workspace rate limits) before any provider call.

export const savePlanBriefAction = withAction({
  name: "campaign.plan.brief",
  input: savePlanBriefInputSchema,
  handler: async ({ slug, campaignId, version, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return savePlanBrief(getDb(), ctx, campaignId, version, fields);
  },
});

export const generatePlanAction = withAction({
  name: "campaign.plan.generate",
  input: generatePlanInputSchema,
  handler: async ({ slug, campaignId, version, count, uiLocale }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    const runtime = await admitGeneration(ctx);
    return generatePlanItems(getDb(), ctx, runtime, campaignId, version, {
      count,
      uiLocale,
      today: new Date(),
    });
  },
});

export const addPlanItemAction = withAction({
  name: "campaign.plan.item_add",
  input: addPlanItemInputSchema,
  handler: async ({ slug, campaignId, version, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return addPlanItem(getDb(), ctx, campaignId, version, fields);
  },
});

export const updatePlanItemAction = withAction({
  name: "campaign.plan.item_update",
  input: updatePlanItemInputSchema,
  handler: async ({ slug, campaignId, itemId, version, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return updatePlanItem(getDb(), ctx, campaignId, itemId, version, fields);
  },
});

export const removePlanItemAction = withAction({
  name: "campaign.plan.item_remove",
  input: removePlanItemInputSchema,
  handler: async ({ slug, campaignId, itemId, version }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    await removePlanItem(getDb(), ctx, campaignId, itemId, version);
  },
});

export const approvePlanAction = withAction({
  name: "campaign.plan.approve",
  input: planStepInputSchema,
  handler: async ({ slug, campaignId, version }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    await approvePlan(getDb(), ctx, campaignId, version);
  },
});

export const reopenPlanAction = withAction({
  name: "campaign.plan.reopen",
  input: planStepInputSchema,
  handler: async ({ slug, campaignId, version }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    await reopenPlan(getDb(), ctx, campaignId, version);
  },
});

export const createPlanDraftsAction = withAction({
  name: "campaign.plan.drafts",
  input: planStepInputSchema,
  handler: async ({ slug, campaignId, version }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return createDraftsFromPlan(getDb(), ctx, campaignId, version);
  },
});
