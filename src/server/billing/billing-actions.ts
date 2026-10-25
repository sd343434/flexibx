import "server-only";

import { z } from "zod";

import { LOCALES } from "@/i18n/config";

import { AppError } from "../errors/app-error";
import { getDb } from "../db/client";
import { getEnv } from "../env";
import { withAction } from "../http/action-handler";
import { requireWorkspaceAccess } from "../tenancy/access";

import { getBillingOverview, updateCreditSettings } from "./billing-service";
import { getCheckoutStatus, startCreditCheckout } from "./checkout-service";
import { getCheckoutProvider } from "./checkout-runtime";
import { creditsSettingsFromEnv } from "./config";
import { CREDIT_PACKAGE_IDS, CREDIT_PACKAGES } from "./packages";
import { CREDIT_FEATURES } from "./pricing";
import { getPaymentProvider } from "./payments";

// Server entry points for the workspace's credits (session → membership → permission).

/** Whether card checkout is configured (an invalid configuration counts as off). */
function checkoutAvailable(): boolean {
  try {
    return getCheckoutProvider() !== null;
  } catch {
    return false;
  }
}

/** The credits page (billing.view: owners and admins). */
export async function getBillingPage(slug: string, checkoutIntentId?: string) {
  const ctx = await requireWorkspaceAccess(slug, "billing.view");
  const payments = getPaymentProvider();
  const overview = await getBillingOverview(getDb(), ctx, creditsSettingsFromEnv(), payments);
  // The return from the payment page only READS the intent's state: credits are granted
  // by the verified webhook, never by this redirect.
  const checkout =
    checkoutIntentId === undefined ? null : await getCheckoutStatus(getDb(), ctx, checkoutIntentId);
  return {
    ...overview,
    canManage: ctx.role === "OWNER",
    cardCheckout: checkoutAvailable(),
    packages: CREDIT_PACKAGES,
    checkout,
  };
}

/**
 * Starts a card checkout for one credit package (billing.manage: owners). The browser
 * sends the package id and a one-time request key only; prices and the workspace come
 * from the server.
 */
export const startCheckoutAction = withAction({
  name: "billing.checkout.start",
  input: z.strictObject({
    slug: z.string().min(1).max(100),
    locale: z.enum(LOCALES),
    packageId: z.enum(CREDIT_PACKAGE_IDS),
    requestKey: z.uuid(),
  }),
  handler: async ({ slug, locale, packageId, requestKey }) => {
    const ctx = await requireWorkspaceAccess(slug, "billing.manage");
    const provider = getCheckoutProvider();
    if (provider === null) {
      throw new AppError("CONFLICT", {
        message: "Payments: not configured",
        fields: [{ path: "payments", code: "payments_not_configured" }],
      });
    }
    const { redirectUrl } = await startCreditCheckout(
      getDb(),
      ctx,
      { packageId, requestKey, locale, slug },
      { provider, credits: creditsSettingsFromEnv(), appUrl: getEnv().APP_URL },
    );
    return { redirectUrl };
  },
});

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
