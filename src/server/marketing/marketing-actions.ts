import "server-only";

import { z } from "zod";

import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { getStorage } from "../storage";
import { requireWorkspaceAccess } from "../tenancy/access";

import { createAudience, deleteAudience, updateAudience } from "./audience-service";
import { saveBrand } from "./brand-service";
import { changeCampaignStatus, createCampaign, updateCampaign } from "./campaign-service";
import {
  createContent,
  deleteContent,
  rescheduleContent,
  transitionContent,
  updateContent,
} from "./content-service";
import { createGoal, updateGoal } from "./goal-service";
import {
  changeCampaignStatusInputSchema,
  createAudienceInputSchema,
  createCampaignInputSchema,
  createContentInputSchema,
  createGoalInputSchema,
  createPillarInputSchema,
  deleteAudienceInputSchema,
  deleteContentInputSchema,
  deleteMediaInputSchema,
  movePillarInputSchema,
  optionalText,
  rescheduleContentInputSchema,
  saveBrandInputSchema,
  transitionContentInputSchema,
  updateAudienceInputSchema,
  updateCampaignInputSchema,
  updateContentInputSchema,
  updateGoalInputSchema,
  updateMediaInputSchema,
  updatePillarInputSchema,
} from "./inputs";
import { deleteMedia, updateMediaAltText, uploadMedia } from "./media-service";
import { createPillar, movePillar, updatePillar } from "./pillar-service";

// Server actions for Marketing Core. Each one: strict Zod input → session →
// `requireWorkspaceAccess(slug, action)` (membership and role from the database) →
// service, which re-checks the permission and scopes every query to the workspace. Ids
// in the input are lookup keys inside that workspace only.

export const saveBrandAction = withAction({
  name: "brand.save",
  input: saveBrandInputSchema,
  handler: async ({ slug, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "brand.edit");
    return saveBrand(getDb(), ctx, fields);
  },
});

export const createAudienceAction = withAction({
  name: "audience.create",
  input: createAudienceInputSchema,
  handler: async ({ slug, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "brand.edit");
    return createAudience(getDb(), ctx, fields);
  },
});

export const updateAudienceAction = withAction({
  name: "audience.update",
  input: updateAudienceInputSchema,
  handler: async ({ slug, audienceId, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "brand.edit");
    return updateAudience(getDb(), ctx, audienceId, fields);
  },
});

export const deleteAudienceAction = withAction({
  name: "audience.delete",
  input: deleteAudienceInputSchema,
  handler: async ({ slug, audienceId }) => {
    const ctx = await requireWorkspaceAccess(slug, "brand.edit");
    return deleteAudience(getDb(), ctx, audienceId);
  },
});

export const createGoalAction = withAction({
  name: "goal.create",
  input: createGoalInputSchema,
  handler: async ({ slug, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return createGoal(getDb(), ctx, fields);
  },
});

export const updateGoalAction = withAction({
  name: "goal.update",
  input: updateGoalInputSchema,
  handler: async ({ slug, goalId, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return updateGoal(getDb(), ctx, goalId, fields);
  },
});

export const createPillarAction = withAction({
  name: "pillar.create",
  input: createPillarInputSchema,
  handler: async ({ slug, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "brand.edit");
    return createPillar(getDb(), ctx, fields);
  },
});

export const updatePillarAction = withAction({
  name: "pillar.update",
  input: updatePillarInputSchema,
  handler: async ({ slug, pillarId, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "brand.edit");
    return updatePillar(getDb(), ctx, pillarId, fields);
  },
});

export const movePillarAction = withAction({
  name: "pillar.move",
  input: movePillarInputSchema,
  handler: async ({ slug, pillarId, direction }) => {
    const ctx = await requireWorkspaceAccess(slug, "brand.edit");
    return movePillar(getDb(), ctx, pillarId, direction);
  },
});

export const createCampaignAction = withAction({
  name: "campaign.create",
  input: createCampaignInputSchema,
  handler: async ({ slug, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return createCampaign(getDb(), ctx, fields);
  },
});

export const updateCampaignAction = withAction({
  name: "campaign.update",
  input: updateCampaignInputSchema,
  handler: async ({ slug, campaignId, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return updateCampaign(getDb(), ctx, campaignId, fields);
  },
});

export const changeCampaignStatusAction = withAction({
  name: "campaign.status",
  input: changeCampaignStatusInputSchema,
  handler: async ({ slug, campaignId, status }) => {
    const ctx = await requireWorkspaceAccess(slug, "campaign.manage");
    return changeCampaignStatus(getDb(), ctx, campaignId, status);
  },
});

export const createContentAction = withAction({
  name: "content.create",
  input: createContentInputSchema,
  handler: async ({ slug, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    return createContent(getDb(), ctx, fields);
  },
});

export const updateContentAction = withAction({
  name: "content.update",
  input: updateContentInputSchema,
  handler: async ({ slug, contentId, ...fields }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.edit");
    return updateContent(getDb(), ctx, contentId, fields);
  },
});

export const deleteContentAction = withAction({
  name: "content.delete",
  input: deleteContentInputSchema,
  handler: async ({ slug, contentId }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.view");
    return deleteContent(getDb(), ctx, contentId);
  },
});

export const transitionContentAction = withAction({
  name: "content.transition",
  input: transitionContentInputSchema,
  handler: async ({ slug, contentId, transition, scheduledAt }) => {
    // The transition's own permission is checked by the service (it depends on the rule).
    const ctx = await requireWorkspaceAccess(slug, "content.view");
    return transitionContent(getDb(), ctx, { contentId, transition, scheduledAt });
  },
});

export const rescheduleContentAction = withAction({
  name: "content.reschedule",
  input: rescheduleContentInputSchema,
  handler: async ({ slug, contentId, scheduledAt }) => {
    // Edit or publish permission depends on the item's status; the service decides.
    const ctx = await requireWorkspaceAccess(slug, "content.view");
    return rescheduleContent(getDb(), ctx, { contentId, scheduledAt });
  },
});

const uploadMediaInputSchema = z.strictObject({
  slug: z.string().min(1).max(100),
  file: z.custom<File>((value) => value instanceof File && value.size > 0, {
    params: { code: "file_required" },
  }),
  altText: optionalText(500),
});

export const uploadMediaAction = withAction({
  name: "asset.upload",
  input: uploadMediaInputSchema,
  handler: async ({ slug, file, altText }, { logger }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    return uploadMedia(
      getDb(),
      getStorage(),
      ctx,
      {
        name: file.name,
        size: file.size,
        bytes: async () => new Uint8Array(await file.arrayBuffer()),
      },
      altText,
      logger,
    );
  },
});

export const updateMediaAction = withAction({
  name: "asset.update",
  input: updateMediaInputSchema,
  handler: async ({ slug, assetId, altText }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.edit");
    return updateMediaAltText(getDb(), ctx, assetId, altText);
  },
});

export const deleteMediaAction = withAction({
  name: "asset.delete",
  input: deleteMediaInputSchema,
  handler: async ({ slug, assetId }, { logger }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.edit");
    return deleteMedia(getDb(), getStorage(), ctx, assetId, logger);
  },
});
