import "server-only";

import { after } from "next/server";
import { z } from "zod";

import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { logger } from "../logger";
import { executeRun } from "../orchestration/engine";
import { getAiRuntimeForAutomation, getOrchestrationDeps } from "../orchestration/runtime";
import { requireWorkspaceAccess } from "../tenancy/access";

import {
  disconnect,
  refreshAccounts,
  selectAccount,
  startConnection,
  syncAccount,
  type AdsDeps,
} from "./connections";
import { AD_PLATFORMS } from "./model";
import {
  createAdPlan,
  discardAdPlan,
  reopenAdPlan,
  requestActivation,
  submitAdPlan,
  updateAdPlan,
} from "./planner";
import { refreshPlanIdentities, selectPlanIdentity } from "./planner";
import { setSpendLimit } from "./spend-limits";
import {
  adTokenKey,
  getAdAdapters,
  getWhatsAppAdapter,
  redirectUriFor,
  whatsappSendingEnabled,
} from "./registry";
import { addWhatsAppContact, optOutWhatsAppContact } from "../whatsapp/contacts";
import { requestWhatsAppSend, resolveUncertainMessage } from "../whatsapp/sending";
import { syncWhatsAppAccount } from "../whatsapp/whatsapp-service";

// Server actions for the advertising area. Order: strict input (unknown fields refused)
// → session + membership + permission → the service, which re-checks it. The workspace
// comes from the member's own membership, never from the input.

const slug = z.string().min(1).max(100);
const id = z.string().min(1).max(100);
const locale = z.enum(["ar", "en"]);
const platform = z.enum(AD_PLATFORMS);

function adsDeps(): AdsDeps {
  return { db: getDb(), adapters: getAdAdapters(), tokenKey: adTokenKey() };
}

export const startConnectionAction = withAction({
  name: "ads.connect",
  input: z.strictObject({ slug, platform, locale }),
  handler: async ({ slug: workspace, platform: target, locale: uiLocale }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.manage");
    return startConnection(adsDeps(), ctx, {
      platform: target,
      locale: uiLocale,
      redirectUri: redirectUriFor(target),
    });
  },
});

export const disconnectAction = withAction({
  name: "ads.disconnect",
  input: z.strictObject({ slug, platform }),
  handler: async ({ slug: workspace, platform: target }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.manage");
    await disconnect(getDb(), ctx, target);
    return { disconnected: true };
  },
});

export const refreshAccountsAction = withAction({
  name: "ads.accounts",
  input: z.strictObject({ slug, platform }),
  handler: async ({ slug: workspace, platform: target }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.manage");
    return refreshAccounts(adsDeps(), ctx, target);
  },
});

export const selectAccountAction = withAction({
  name: "ads.select",
  input: z.strictObject({ slug, accountId: id, selected: z.boolean() }),
  handler: async ({ slug: workspace, accountId, selected }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.manage");
    await selectAccount(getDb(), ctx, { accountId, selected });
    return { selected };
  },
});

export const syncAccountAction = withAction({
  name: "ads.sync",
  input: z.strictObject({ slug, accountId: id }),
  handler: async ({ slug: workspace, accountId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    return syncAccount(adsDeps(), ctx, accountId);
  },
});

export const syncWhatsAppAction = withAction({
  name: "whatsapp.sync",
  input: z.strictObject({ slug, accountId: id }),
  handler: async ({ slug: workspace, accountId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    return syncWhatsAppAccount({ ...adsDeps(), whatsapp: getWhatsAppAdapter() }, ctx, accountId);
  },
});

export const createAdPlanAction = withAction({
  name: "ads.plan.create",
  input: z.strictObject({
    slug,
    uiLocale: locale,
    accountId: id,
    budget: z.string().max(40),
    startDate: z.string().max(20),
    endDate: z.string().max(20),
    request: z.string().max(2000),
  }),
  handler: async ({ slug: workspace, uiLocale, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    return createAdPlan(getDb(), ctx, getAiRuntimeForAutomation(), input, uiLocale);
  },
});

export const updateAdPlanAction = withAction({
  name: "ads.plan.update",
  input: z.strictObject({
    slug,
    planId: id,
    budget: z.string().max(40),
    startDate: z.string().max(20),
    endDate: z.string().max(20),
    campaignName: z.string().max(400),
    headline: z.string().max(400),
    primaryText: z.string().max(2000),
    destinationUrl: z.string().max(2100).optional(),
    placements: z.array(z.string().max(40)).max(10).optional(),
  }),
  handler: async ({ slug: workspace, planId, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    await updateAdPlan(getDb(), ctx, planId, input);
    return { saved: true };
  },
});

export const discardAdPlanAction = withAction({
  name: "ads.plan.discard",
  input: z.strictObject({ slug, planId: id }),
  handler: async ({ slug: workspace, planId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    await discardAdPlan(getDb(), ctx, planId);
    return { discarded: true };
  },
});

export const reopenAdPlanAction = withAction({
  name: "ads.plan.reopen",
  input: z.strictObject({ slug, planId: id }),
  handler: async ({ slug: workspace, planId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    await reopenAdPlan(getDb(), ctx, planId);
    return { reopened: true };
  },
});

/** Sends a plan to the approval workflow and lets the run reach its approval step. */
export const submitAdPlanAction = withAction({
  name: "ads.plan.submit",
  input: z.strictObject({ slug, planId: id }),
  handler: async ({ slug: workspace, planId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    const deps = getOrchestrationDeps();
    const { runId } = await submitAdPlan(deps, ctx, planId);
    after(async () => {
      try {
        await executeRun(deps, ctx.workspaceId, runId);
      } catch (error) {
        logger.error({ err: error, runId }, "Ad launch run failed to advance");
      }
    });
    return { runId };
  },
});

/**
 * Asks for a created (paused) campaign to be turned on. Starts the ad_activate run, which
 * stops at its approval step: nothing is activated until an owner or admin approves.
 */
export const requestActivationAction = withAction({
  name: "ads.plan.activate",
  input: z.strictObject({ slug, planId: id }),
  handler: async ({ slug: workspace, planId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    const deps = getOrchestrationDeps();
    const { runId } = await requestActivation(deps, ctx, planId);
    after(async () => {
      try {
        await executeRun(deps, ctx.workspaceId, runId);
      } catch (error) {
        logger.error({ err: error, runId }, "Ad activation run failed to advance");
      }
    });
    return { runId };
  },
});

export const setSpendLimitAction = withAction({
  name: "ads.spend_limit.set",
  input: z.strictObject({
    slug,
    currency: z.string().max(10),
    maxPlanBudget: z.string().max(40),
    maxDailyBudget: z.string().max(40),
  }),
  handler: async ({ slug: workspace, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.manage");
    return setSpendLimit(getDb(), ctx, input);
  },
});

export const addWhatsAppContactAction = withAction({
  name: "whatsapp.contact.add",
  input: z.strictObject({
    slug,
    accountId: id,
    phone: z.string().max(60),
    consentSource: z.string().max(40),
    consentConfirmed: z.boolean(),
  }),
  handler: async ({ slug: workspace, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    return addWhatsAppContact({ db: getDb(), tokenKey: adTokenKey() }, ctx, input);
  },
});

export const optOutWhatsAppContactAction = withAction({
  name: "whatsapp.contact.opt_out",
  input: z.strictObject({ slug, contactId: id }),
  handler: async ({ slug: workspace, contactId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    await optOutWhatsAppContact(getDb(), ctx, contactId);
    return { optedOut: true };
  },
});

/**
 * Asks to send one WhatsApp message. Starts the whatsapp_send run, which stops at its
 * approval step: nothing is sent until an owner or admin approves that exact message.
 */
export const requestWhatsAppSendAction = withAction({
  name: "whatsapp.send",
  input: z.strictObject({
    slug,
    accountId: id,
    phoneNumberId: z.string().max(64),
    contactId: id,
    requestKey: z.string().max(64),
    kind: z.string().max(20),
    templateName: z.string().max(512).optional(),
    templateLanguage: z.string().max(20).optional(),
    parameters: z.array(z.string().max(1000)).max(20).optional(),
    text: z.string().max(5000).optional(),
  }),
  handler: async ({ slug: workspace, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    const deps = getOrchestrationDeps();
    const result = await requestWhatsAppSend(
      {
        ...deps,
        sendingEnabled: whatsappSendingEnabled(),
        configured: getWhatsAppAdapter() !== null,
      },
      ctx,
      input,
    );
    if (result.created) {
      after(async () => {
        try {
          await executeRun(deps, ctx.workspaceId, result.runId);
        } catch (error) {
          logger.error({ err: error, runId: result.runId }, "WhatsApp send run failed to advance");
        }
      });
    }
    return { messageId: result.messageId, runId: result.runId };
  },
});

/** Lists the Facebook Pages the connection may advertise as (read-only on Meta). */
export const refreshPlanIdentitiesAction = withAction({
  name: "ads.plan.identities",
  input: z.strictObject({ slug, planId: id }),
  handler: async ({ slug: workspace, planId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    const deps = getOrchestrationDeps();
    return refreshPlanIdentities(
      {
        db: getDb(),
        adapters: deps.adapters,
        tokenKey: adTokenKey(),
        executionEnabled: deps.executionEnabled,
      },
      ctx,
      planId,
    );
  },
});

export const selectPlanIdentityAction = withAction({
  name: "ads.plan.identity",
  input: z.strictObject({ slug, planId: id, identityId: z.string().max(64) }),
  handler: async ({ slug: workspace, planId, identityId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "ads.plan");
    await selectPlanIdentity(getDb(), ctx, planId, identityId);
    return { selected: true };
  },
});

/** An owner or admin releases a contact after checking a message whose outcome is unknown. */
export const resolveWhatsAppMessageAction = withAction({
  name: "whatsapp.message.resolve",
  input: z.strictObject({ slug, messageId: id }),
  handler: async ({ slug: workspace, messageId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "automation.approve");
    await resolveUncertainMessage(getDb(), ctx, messageId);
    return { resolved: true };
  },
});
