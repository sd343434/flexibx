import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import type { TenantContext } from "../tenancy/context";
import { can } from "../tenancy/permissions";

import type { AdAdapters, AdPlatformAdapter, AdWriter } from "./adapter";
import { adsError } from "./errors";
import { assertWithinSpendLimits, assertWriteAccess } from "./execution";
import type { AdCampaignSpec, AdPlatform } from "./model";

// The checks every advertising write must pass, run right before the write (inside the
// approved task) and when a plan is submitted: execution enabled on this server, a ready
// write path supporting the objective, an active connection holding the write
// permissions, a destination, budget within the workspace's spending limits, and the
// acting member still allowed to plan and run automation.

export interface PreflightPlan {
  readonly platform: AdPlatform;
  readonly spec: AdCampaignSpec;
  readonly budgetMinor: number;
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string;
  /** The ad account's status on the platform at its last sync (ACTIVE to launch). */
  readonly accountStatus: string;
}

export async function executionPreflight(args: {
  readonly db: Db;
  readonly actor: TenantContext;
  readonly adapters: AdAdapters;
  readonly executionEnabled: boolean;
  readonly plan: PreflightPlan;
}): Promise<{ readonly adapter: AdPlatformAdapter; readonly writer: AdWriter | null }> {
  const { db, actor, plan } = args;
  if (!can(actor.role, "ads.plan") || !can(actor.role, "automation.manage")) {
    throw new AppError("FORBIDDEN");
  }
  const entry = args.adapters[plan.platform];
  if (!entry.available || !entry.adapter.capabilities.launchCampaign) {
    throw adsError("CONFLICT", "ads_operation_unavailable", {
      operation: `${plan.platform}.launch`,
    });
  }
  if (!args.executionEnabled) throw adsError("CONFLICT", "ads_execution_disabled");
  // A disabled, closed or unpaid account cannot deliver: refused before any write.
  if (plan.accountStatus !== "ACTIVE") throw adsError("CONFLICT", "ads_account_inactive");
  const writer = entry.adapter.writer ?? null;
  if (writer !== null) {
    if (
      !writer.ready ||
      !writer.supportsObjective(plan.spec.objective) ||
      !writer.supportsCurrency(plan.currency) ||
      !writer.supportsPlacements(plan.spec.placements)
    ) {
      throw adsError("CONFLICT", "ads_operation_unavailable", {
        operation: `${plan.platform}.${plan.spec.objective}`,
      });
    }
    if ((plan.spec.creative.destinationUrl ?? null) === null) {
      throw adsError("CONFLICT", "ads_destination_missing");
    }
    await assertWriteAccess(db, actor.workspaceId, plan.platform, writer);
  } else if (entry.adapter.launchCampaign === undefined) {
    throw adsError("CONFLICT", "ads_operation_unavailable", {
      operation: `${plan.platform}.launch`,
    });
  }
  await assertWithinSpendLimits(db, actor.workspaceId, {
    budgetMinor: plan.budgetMinor,
    currency: plan.currency,
    startDate: plan.startDate,
    endDate: plan.endDate,
  });
  return { adapter: entry.adapter, writer };
}
