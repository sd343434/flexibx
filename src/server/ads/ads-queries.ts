import "server-only";

import { getDb } from "../db/client";
import { getAiEnv } from "../env";
import { resolveTimeZone } from "../marketing/time";
import { requireWorkspaceAccess } from "../tenancy/access";
import { can } from "../tenancy/permissions";

import { getWhatsAppAccounts } from "../whatsapp/whatsapp-service";

import { getIntegrationsOverview } from "./integrations";
import { getAdPlanReview } from "./planner";
import { readAccountSnapshot, AD_PLATFORMS, type Money } from "./model";
import { adsExecutionEnabled, getAdAdapters, whatsappSendingEnabled } from "./registry";
import { recommendOptimizations } from "./optimization";
import { listSpendLimits } from "./spend-limits";
import { listWhatsAppContacts } from "../whatsapp/contacts";
import { listWhatsAppMessages } from "../whatsapp/sending";

// Page data for the advertising area (ads.view). Workspace and role come from the
// session's membership. Never returned: tokens, ciphertexts, state values, or raw
// platform responses — only the unified model and connection metadata.

export const PLANS_LISTED = 20;
export const CAMPAIGNS_LISTED = 50;

export async function getAdsPage(slug: string) {
  const ctx = await requireWorkspaceAccess(slug, "ads.view");
  const db = getDb();
  const adapters = getAdAdapters();
  const [connections, accounts, plans, workspace, spendLimits] = await Promise.all([
    db.adConnection.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: {
        platform: true,
        status: true,
        externalUserName: true,
        scopes: true,
        tokenExpiresAt: true,
        lastErrorCode: true,
        updatedAt: true,
        connectedBy: { select: { name: true } },
      },
    }),
    db.adAccount.findMany({
      // WhatsApp Business accounts are shown on the Integrations page, not as ad accounts.
      where: { workspaceId: ctx.workspaceId, platform: { not: "WHATSAPP" } },
      orderBy: [{ selected: "desc" }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        platform: true,
        name: true,
        externalId: true,
        currency: true,
        externalStatus: true,
        selected: true,
        snapshot: true,
        lastSyncedAt: true,
        syncErrorCode: true,
        connection: { select: { status: true } },
      },
    }),
    db.adPlan.findMany({
      where: { workspaceId: ctx.workspaceId, status: { not: "DISCARDED" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PLANS_LISTED,
      select: {
        id: true,
        platform: true,
        status: true,
        name: true,
        budgetTotalMinor: true,
        currency: true,
        startDate: true,
        endDate: true,
        createdAt: true,
        account: { select: { name: true } },
      },
    }),
    db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { timezone: true } }),
    listSpendLimits(db, ctx),
  ]);

  return {
    platforms: AD_PLATFORMS.map((platform) => {
      const entry = adapters[platform];
      const connection = connections.find((row) => row.platform === platform) ?? null;
      return {
        platform,
        available: entry.available,
        reason: entry.available ? null : entry.reason,
        capabilities: entry.available ? entry.adapter.capabilities : null,
        connection:
          connection === null
            ? null
            : {
                status: connection.status,
                externalUserName: connection.externalUserName,
                scopes: connection.scopes,
                tokenExpiresAt: connection.tokenExpiresAt,
                lastErrorCode: connection.lastErrorCode,
                updatedAt: connection.updatedAt,
                connectedByName: connection.connectedBy?.name ?? null,
              },
      };
    }),
    accounts: accounts.map((account) => {
      const snapshot = readAccountSnapshot(account.snapshot);
      const limit = spendLimits.find((row) => row.currency === account.currency) ?? null;
      const metrics = new Map(snapshot?.metrics.map((m) => [m.campaignExternalId, m]) ?? []);
      return {
        id: account.id,
        platform: account.platform,
        name: account.name,
        externalId: account.externalId,
        currency: account.currency,
        status: account.externalStatus,
        selected: account.selected,
        usable: account.selected && account.connection.status === "ACTIVE",
        lastSyncedAt: account.lastSyncedAt,
        syncErrorCode: account.syncErrorCode,
        truncated: snapshot?.truncated ?? false,
        // Suggestions from historical results only; nothing is applied automatically.
        optimization:
          snapshot === null || !account.selected
            ? null
            : recommendOptimizations(snapshot, {
                maxDailyBudgetMinor: limit?.maxDailyBudgetMinor ?? null,
              }),
        rangeDays: snapshot?.range.days ?? null,
        counts:
          snapshot === null ? null : { adSets: snapshot.adSets.length, ads: snapshot.ads.length },
        campaigns: (snapshot?.campaigns ?? []).slice(0, CAMPAIGNS_LISTED).map((campaign) => {
          const metric = metrics.get(campaign.externalId);
          return {
            ...campaign,
            impressions: metric?.impressions ?? null,
            clicks: metric?.clicks ?? null,
            spend: (metric?.spend ?? null) satisfies Money | null,
          };
        }),
      };
    }),
    plans: plans.map((plan) => ({
      ...plan,
      budget: { minor: Number(plan.budgetTotalMinor), currency: plan.currency } satisfies Money,
      startDate: plan.startDate.toISOString().slice(0, 10),
      endDate: plan.endDate.toISOString().slice(0, 10),
      accountName: plan.account.name,
    })),
    canManage: can(ctx.role, "ads.manage"),
    canPlan: can(ctx.role, "ads.plan"),
    spendLimits,
    executionEnabled: adsExecutionEnabled(),
    aiConfigured: getAiEnv().AI_PROVIDER !== "disabled",
    timeZone: resolveTimeZone(workspace?.timezone),
  };
}

export type AdsPage = Awaited<ReturnType<typeof getAdsPage>>;

export async function getAdPlanPage(slug: string, planId: string) {
  const ctx = await requireWorkspaceAccess(slug, "ads.view");
  const db = getDb();
  const [review, workspace] = await Promise.all([
    getAdPlanReview(db, ctx, getAdAdapters(), planId, {
      executionEnabled: adsExecutionEnabled(),
    }),
    db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { timezone: true } }),
  ]);
  return {
    review,
    canPlan: can(ctx.role, "ads.plan"),
    canSubmit: can(ctx.role, "ads.plan") && can(ctx.role, "automation.manage"),
    timeZone: resolveTimeZone(workspace?.timezone),
  };
}

export type AdPlanPage = Awaited<ReturnType<typeof getAdPlanPage>>;

/** The Integrations page: every platform, this workspace's connections and WhatsApp accounts. */
export async function getIntegrationsPage(slug: string) {
  const ctx = await requireWorkspaceAccess(slug, "ads.view");
  const db = getDb();
  const [overview, whatsapp, workspace, contacts, messages] = await Promise.all([
    getIntegrationsOverview(db, ctx, getAdAdapters()),
    getWhatsAppAccounts(db, ctx),
    db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { timezone: true } }),
    listWhatsAppContacts(db, ctx),
    listWhatsAppMessages(db, ctx),
  ]);
  return {
    ...overview,
    whatsapp,
    contacts,
    messages,
    sendingEnabled: whatsappSendingEnabled(),
    canSend: can(ctx.role, "ads.plan") && can(ctx.role, "automation.manage"),
    canResolve: can(ctx.role, "automation.approve"),
    canPlan: can(ctx.role, "ads.plan"),
    timeZone: resolveTimeZone(workspace?.timezone),
  };
}

export type IntegrationsPage = Awaited<ReturnType<typeof getIntegrationsPage>>;
