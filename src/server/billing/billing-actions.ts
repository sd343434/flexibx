import "server-only";

import { z } from "zod";

import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { requireWorkspaceAccess } from "../tenancy/access";

import { getBillingOverview, updateCreditSettings } from "./billing-service";
import { creditsSettingsFromEnv } from "./config";
import { CREDIT_FEATURES } from "./pricing";
import { getPaymentProvider } from "./payments";

// Server entry points for the workspace's credits (session → membership → permission).

/** The credits page (billing.view: owners and admins). */
export async function getBillingPage(slug: string) {
  const ctx = await requireWorkspaceAccess(slug, "billing.view");
  const payments = getPaymentProvider();
  const overview = await getBillingOverview(getDb(), ctx, creditsSettingsFromEnv(), payments);
  return { ...overview, canManage: ctx.role === "OWNER" };
}

const capText = z.string().max(12);

export const updateCreditSettingsAction = withAction({
  name: "billing.settings.update",
  input: z.strictObject({
    slug: z.string().min(1).max(100),
    dailyCap: capText,
    periodCap: capText,
    featureCaps: z.partialRecord(z.enum(CREDIT_FEATURES), capText),
    autoRechargeEnabled: z.boolean(),
    autoRechargeThreshold: capText,
    autoRechargeAmount: capText,
    autoRechargePeriodMax: capText,
    version: z.string().max(12),
  }),
  handler: async ({ slug, ...input }) => {
    const ctx = await requireWorkspaceAccess(slug, "billing.manage");
    await updateCreditSettings(getDb(), ctx, input, creditsSettingsFromEnv(), getPaymentProvider());
  },
});
