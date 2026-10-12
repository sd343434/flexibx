import "server-only";

import { z } from "zod";

import {
  adminAddCredits,
  adminChangePlan,
  availablePlans,
  costReport,
} from "../billing/billing-service";
import { creditsSettingsFromEnv } from "../billing/config";
import { lockAccount } from "../billing/credits";
import { getDb, getSystemDb } from "../db/client";
import { withAction } from "../http/action-handler";

import { requirePlatformAdmin } from "./platform-admin";

// Platform admin → Credits. Authorizes first (platform administrator, re-read from the
// database); anyone else gets the standard 404. Adds credits against a manual invoice
// (no payment provider exists yet), corrects balances and changes plans; every change is
// in the workspace's credit ledger (with the administrator as actor) and the audit log.
//
// SYSTEM PATH (reviewed): the workspace is looked up by slug across all workspaces; every
// read and write after that goes through the guarded client with its id.

/** One workspace's credits for the admin page, by slug (null = no such workspace). */
export async function getCreditsAdminView(slug: string | null) {
  await requirePlatformAdmin();
  const settings = creditsSettingsFromEnv();
  const plans = availablePlans(settings);
  if (slug === null || slug.trim() === "") return { plans, workspace: null };
  const workspace = await getSystemDb().workspace.findFirst({
    where: { slug: slug.trim().toLowerCase(), deletedAt: null },
    select: { id: true, name: true, slug: true },
  });
  if (workspace === null) return { plans, workspace: null };
  const db = getDb();
  const account = await db.$transaction((tx) =>
    lockAccount(tx, workspace.id, new Date(), settings),
  );
  const report = await costReport(db, workspace.id, account.periodStart, settings);
  return {
    plans,
    workspace: {
      ...workspace,
      planCode: account.planCode,
      periodStart: account.periodStart,
      periodEnd: account.periodEnd,
      subscriptionCredits: account.subscriptionCredits,
      purchasedCredits: account.purchasedCredits,
      heldCredits: account.heldCredits,
      report: {
        credits: report.credits,
        providerCostMicros: report.providerCostMicros?.toString() ?? null,
        marginMicros: report.marginMicros?.toString() ?? null,
        unknownCost: report.unknownCost,
      },
    },
  };
}

export const addCreditsAdminAction = withAction({
  name: "admin.credits.add",
  input: z.unknown(),
  handler: async (input) => {
    const admin = await requirePlatformAdmin();
    await adminAddCredits(getDb(), admin.userId, input, creditsSettingsFromEnv());
  },
});

export const changePlanAdminAction = withAction({
  name: "admin.credits.change_plan",
  input: z.unknown(),
  handler: async (input) => {
    const admin = await requirePlatformAdmin();
    await adminChangePlan(getDb(), admin.userId, input, creditsSettingsFromEnv());
  },
});
