import "server-only";

import { getAiEnv } from "../env";
import { getDb } from "../db/client";
import { publishingReadiness } from "../social/publishing-readiness";
import { metaSocialFromEnv, socialSendingEnabled } from "../social/social-runtime";
import { requireWorkspaceAccess } from "../tenancy/access";
import { isUuid } from "../tenancy/context";
import { can } from "../tenancy/permissions";

import { getCampaign } from "./campaign-service";
import { campaignProgress } from "./campaign-progress";
import { notFound } from "./common";
import { campaignProgressFacts, getCampaignPlan } from "./plan-service";
import { isCampaignEditable } from "./workflow";

// Page data for a campaign's plan and progress (Pass 4). The workspace comes from the
// session's membership; the services check every permission and scope every query.
// Permission flags are UI hints only — every action re-checks on the server.

function campaignId(id: string): string {
  if (!isUuid(id)) throw notFound("campaign");
  return id;
}

/** The plan page: the campaign, its plan (or none yet) and what this person may do. */
export async function getCampaignPlanPage(slug: string, rawCampaignId: string) {
  const id = campaignId(rawCampaignId);
  const ctx = await requireWorkspaceAccess(slug);
  const db = getDb();
  const [campaign, plan] = await Promise.all([
    getCampaign(db, ctx, id),
    getCampaignPlan(db, ctx, id),
  ]);
  const manage = can(ctx.role, "campaign.manage") && isCampaignEditable(campaign.status);
  return {
    campaign,
    plan,
    can: {
      manage,
      edit: manage && (plan === null || plan.status === "DRAFT"),
      generate: manage && can(ctx.role, "content.create") && getAiEnv().AI_PROVIDER !== "disabled",
      createDrafts: manage && can(ctx.role, "content.create"),
    },
  };
}

/**
 * The campaign's progress and next steps (campaign-progress.ts) from recorded facts and
 * the workspace's publishing readiness. Null for a role that cannot see content.
 */
export async function getCampaignProgress(slug: string, rawCampaignId: string) {
  const id = campaignId(rawCampaignId);
  const ctx = await requireWorkspaceAccess(slug);
  if (!can(ctx.role, "content.view")) return null;
  const db = getDb();
  const [facts, readiness] = await Promise.all([
    campaignProgressFacts(db, ctx, id),
    publishingReadiness(
      { db, meta: metaSocialFromEnv(), sendingEnabled: socialSendingEnabled() },
      ctx.workspaceId,
    ),
  ]);
  const now = new Date();
  return {
    progress: campaignProgress({
      campaign: facts.campaign,
      plan: facts.plan,
      content: facts.content,
      publishingBlockers: readiness.blockers,
      now,
    }),
    blockers: readiness.blockers,
    schedulerLastRunAt: readiness.schedulerLastRunAt,
    can: {
      manage: can(ctx.role, "campaign.manage"),
      approve: can(ctx.role, "content.approve"),
      publish: can(ctx.role, "content.publish"),
      edit: can(ctx.role, "content.edit"),
    },
  };
}
