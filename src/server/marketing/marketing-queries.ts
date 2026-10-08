import "server-only";

import { getDb } from "../db/client";
import { getStorage } from "../storage";
import { requireWorkspaceAccess } from "../tenancy/access";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan, can, type Action } from "../tenancy/permissions";

import { getAudience, listAudiences } from "./audience-service";
import { getBrand } from "./brand-service";
import { getCampaign, listCampaigns } from "./campaign-service";
import { notFound, workspaceTimeZone, type MarketingResource } from "./common";
import { getContent, listContent, type ContentListFilters } from "./content-service";
import { getGoal, listGoals } from "./goal-service";
import type { CalendarView } from "./inputs";
import { listMedia, readMedia } from "./media-service";
import { getCalendar, getDashboard, listActivity } from "./overview-service";
import { getPillar, listPillars } from "./pillar-service";
import { CAMPAIGN_STATUS_TRANSITIONS, isCampaignEditable } from "./workflow";

// Page data for the Marketing Core screens. Every function resolves the workspace from
// the session's membership (`requireWorkspaceAccess`) and reads through services that
// check the permission and scope every query. FORBIDDEN propagates to the page, which
// shows its "not available for your role" state. Permission flags are UI hints only.

export interface Abilities {
  readonly brandEdit: boolean;
  readonly contentCreate: boolean;
  readonly contentEdit: boolean;
  readonly campaignManage: boolean;
  readonly campaignView: boolean;
  readonly brandView: boolean;
  readonly contentView: boolean;
}

function abilities(ctx: TenantContext): Abilities {
  const has = (action: Action) => can(ctx.role, action);
  return {
    brandEdit: has("brand.edit"),
    brandView: has("brand.view"),
    contentCreate: has("content.create"),
    contentEdit: has("content.edit"),
    contentView: has("content.view"),
    campaignManage: has("campaign.manage"),
    campaignView: has("campaign.view"),
  };
}

/** Route ids are untrusted text: anything but a UUID is simply not found. */
function assertId(id: string, resource: MarketingResource): void {
  if (!isUuid(id)) throw notFound(resource);
}

async function access(slug: string) {
  const ctx = await requireWorkspaceAccess(slug);
  return { ctx, db: getDb(), can: abilities(ctx) };
}

export async function getDashboardPage(slug: string) {
  const { ctx, db } = await access(slug);
  return getDashboard(db, ctx);
}

export async function getBrandPage(slug: string) {
  const { ctx, db, can: abilities } = await access(slug);
  return { brand: await getBrand(db, ctx), can: abilities };
}

export async function getAudiencesPage(slug: string) {
  const { ctx, db, can: abilities } = await access(slug);
  return { audiences: await listAudiences(db, ctx), can: abilities };
}

export async function getAudiencePage(slug: string, audienceId: string) {
  assertId(audienceId, "audience");
  const { ctx, db, can: abilities } = await access(slug);
  return { audience: await getAudience(db, ctx, audienceId), can: abilities };
}

export async function getGoalsPage(slug: string) {
  const { ctx, db, can: abilities } = await access(slug);
  return { goals: await listGoals(db, ctx), can: abilities };
}

export async function getGoalPage(slug: string, goalId: string) {
  assertId(goalId, "goal");
  const { ctx, db, can: abilities } = await access(slug);
  return { goal: await getGoal(db, ctx, goalId), can: abilities };
}

export async function getPillarsPage(slug: string) {
  const { ctx, db, can: abilities } = await access(slug);
  const [pillars, audiences] = await Promise.all([listPillars(db, ctx), listAudiences(db, ctx)]);
  return { pillars, audiences, can: abilities };
}

export async function getPillarPage(slug: string, pillarId: string) {
  assertId(pillarId, "pillar");
  const { ctx, db, can: abilities } = await access(slug);
  const [pillar, audiences] = await Promise.all([
    getPillar(db, ctx, pillarId),
    listAudiences(db, ctx),
  ]);
  return { pillar, audiences, can: abilities };
}

/** Choices for linking records, limited to what the role may see. */
async function linkOptions(ctx: TenantContext) {
  const db = getDb();
  const brandView = can(ctx.role, "brand.view");
  const campaignView = can(ctx.role, "campaign.view");
  const [audiences, pillars, goals, campaigns] = await Promise.all([
    brandView ? listAudiences(db, ctx) : [],
    brandView ? listPillars(db, ctx) : [],
    campaignView ? listGoals(db, ctx) : [],
    campaignView ? listCampaigns(db, ctx) : [],
  ]);
  return {
    audiences: audiences.map((row) => ({ id: row.id, name: row.name, archived: false })),
    pillars: pillars.map((row) => ({
      id: row.id,
      name: row.name,
      archived: row.status === "ARCHIVED",
    })),
    goals: goals.map((row) => ({
      id: row.id,
      name: row.title,
      archived: row.status === "ARCHIVED",
    })),
    campaigns: campaigns.map((row) => ({
      id: row.id,
      name: row.name,
      archived: row.status === "ARCHIVED",
    })),
  };
}

export type LinkOptions = Awaited<ReturnType<typeof linkOptions>>;

export async function getCampaignsPage(slug: string, includeArchived: boolean) {
  const { ctx, db, can: abilities } = await access(slug);
  return { campaigns: await listCampaigns(db, ctx, { includeArchived }), can: abilities };
}

export async function getCampaignFormPage(slug: string) {
  const { ctx, can: abilities } = await access(slug);
  assertCan(ctx, "campaign.manage");
  return { options: await linkOptions(ctx), can: abilities };
}

export async function getCampaignPage(slug: string, campaignId: string) {
  assertId(campaignId, "campaign");
  const { ctx, db, can: abilities } = await access(slug);
  const campaign = await getCampaign(db, ctx, campaignId);
  const editable = abilities.campaignManage && isCampaignEditable(campaign.status);
  const [options, content] = await Promise.all([
    editable ? linkOptions(ctx) : Promise.resolve(null),
    abilities.contentView ? listContent(db, ctx, { campaignId, page: 1 }) : Promise.resolve(null),
  ]);
  return {
    campaign,
    options,
    content,
    nextStatuses: abilities.campaignManage ? CAMPAIGN_STATUS_TRANSITIONS[campaign.status] : [],
    editable,
    can: abilities,
  };
}

export async function getContentListPage(slug: string, filters: ContentListFilters) {
  const { ctx, db, can: abilities } = await access(slug);
  const [list, options] = await Promise.all([listContent(db, ctx, filters), linkOptions(ctx)]);
  return { ...list, options, can: abilities };
}

async function contentFormOptions(ctx: TenantContext) {
  const [links, media] = await Promise.all([linkOptions(ctx), listMedia(getDb(), ctx)]);
  return {
    ...links,
    media: media.map((row) => ({ id: row.id, name: row.filename, altText: row.altText })),
  };
}

export type ContentFormOptions = Awaited<ReturnType<typeof contentFormOptions>>;

export async function getNewContentPage(slug: string) {
  const { ctx, db, can: abilities } = await access(slug);
  assertCan(ctx, "content.create");
  const [options, timeZone] = await Promise.all([
    contentFormOptions(ctx),
    workspaceTimeZone(db, ctx),
  ]);
  return { options, timeZone, can: abilities };
}

export async function getContentPage(slug: string, contentId: string) {
  assertId(contentId, "content");
  const { ctx, db, can: abilities } = await access(slug);
  const content = await getContent(db, ctx, contentId);
  const [options, timeZone] = await Promise.all([
    content.canEdit ? contentFormOptions(ctx) : Promise.resolve(null),
    workspaceTimeZone(db, ctx),
  ]);
  return { content, options, timeZone, can: abilities };
}

export async function getCalendarPage(
  slug: string,
  query: { readonly view: CalendarView; readonly date?: string | undefined },
) {
  const { ctx, db, can: abilities } = await access(slug);
  return { calendar: await getCalendar(db, ctx, query), can: abilities };
}

export async function getMediaPage(slug: string) {
  const { ctx, db, can: abilities } = await access(slug);
  return { media: await listMedia(db, ctx), can: abilities };
}

/**
 * The bytes of one media asset for the access-checked media route: the session's
 * membership decides the workspace; the asset is looked up inside it only.
 */
export async function getMediaObject(slug: string, assetId: string) {
  const ctx = await requireWorkspaceAccess(slug, "content.view");
  return readMedia(getDb(), getStorage(), ctx, assetId);
}

export async function getActivityPage(slug: string, before: string | undefined) {
  const { ctx, db } = await access(slug);
  return listActivity(db, ctx, { limit: 30, before });
}
