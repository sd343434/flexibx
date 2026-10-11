import { AdPlatformError } from "../../ads/adapter";
import { withPlatformToken } from "../../ads/connections";
import { createdIds, runActivation } from "../../ads/execution";
import { AD_ACTIVATE_WORKFLOW, launchRequestOf, planMedia } from "../../ads/planner";
import { recordAudit } from "../../audit/audit-log";
import { AppError } from "../../errors/app-error";
import type { WorkflowDefinition } from "../workflow";
import { TaskError } from "../workflow";

import {
  guardWrite,
  launchContext,
  planOf,
  preflightOrFail,
  type AdLaunchServices,
} from "./ad-launch";

// Activating a campaign that was created PAUSED: validate (INTERNAL) → activate (SPEND)
// → reconcile (INTERNAL). The activate task describes exactly which external objects are
// turned on and the budget they may spend, so a person approves that action; it is
// re-described right before running (any change → a new approval), runs once, and an
// unknown outcome is recorded UNCERTAIN and reconciled by reading the platform, never by
// writing again. Activation is never automatic: connecting an account or creating a
// campaign does not authorize spending.

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

export const adActivateWorkflow: WorkflowDefinition<AdLaunchServices> = {
  id: AD_ACTIVATE_WORKFLOW,
  summaryTask: "reconcile",
  tasks: [
    {
      key: "validate",
      dependsOn: [],
      risk: "INTERNAL",
      maxAttempts: 1,
      timeoutMs: 10_000,
      run: async (context) => {
        const plan = await planOf(context, { activationRunId: context.runId });
        if (plan.status !== "LAUNCHED" || plan.activationStatus !== "REQUESTED") {
          throw new TaskError("plan_not_activatable", false);
        }
        const ids = await createdIds(context.db, context.actor.workspaceId, plan.id);
        if (ids.campaign === undefined || ids.adset === undefined || ids.ad === undefined) {
          throw new TaskError("ads_not_created", false);
        }
        await preflightOrFail(context, plan);
        return { status: "succeeded", output: { planId: plan.id } };
      },
    },
    {
      key: "activate",
      dependsOn: ["validate"],
      risk: "SPEND",
      maxAttempts: 1,
      // A read of three objects, three writes and a read again, each request bounded.
      timeoutMs: 200_000,
      describe: async (context) => {
        const plan = await planOf(context, { activationRunId: context.runId });
        const ids = await createdIds(context.db, context.actor.workspaceId, plan.id);
        return {
          action: "activate_ad_campaign",
          details: {
            platform: plan.platform,
            planId: plan.id,
            planVersion: plan.version,
            account: plan.account.externalId,
            connectedAs: plan.account.connection.externalUserId,
            connectionVersion: plan.account.connection.version,
            identity: plan.identityExternalId,
            identityName: plan.identityName,
            campaign: ids.campaign ?? null,
            adSet: ids.adset ?? null,
            ad: ids.ad ?? null,
            startDate: isoDay(plan.startDate),
            endDate: isoDay(plan.endDate),
            status: "ACTIVE",
          },
          amount: { minor: Number(plan.budgetTotalMinor), currency: plan.currency },
        };
      },
      run: async (context) => {
        const plan = await planOf(context, { activationRunId: context.runId });
        if (plan.status !== "LAUNCHED" || plan.activationStatus !== "REQUESTED") {
          throw new TaskError("plan_not_activatable", false);
        }
        const { writer, spec } = await preflightOrFail(context, plan);
        if (writer === null) throw new TaskError("ads_operation_unavailable", false);
        const ids = await createdIds(context.db, context.actor.workspaceId, plan.id);
        const media = await planMedia(context.db, context.actor.workspaceId, spec);
        const request = launchRequestOf(
          plan,
          spec,
          media === null ? null : { id: media.id, filename: media.filename },
        );
        const finish = async (
          activationStatus: "ACTIVE" | "UNCERTAIN" | "FAILED",
          externalStatus: string | null,
          code: string | null,
        ) => {
          await context.db.$transaction(async (tx) => {
            await tx.adPlan.updateMany({
              where: { workspaceId: context.actor.workspaceId, id: plan.id },
              data: {
                activationStatus,
                ...(externalStatus === null
                  ? {}
                  : { externalStatus, externalCheckedAt: new Date() }),
                ...(code === null ? {} : { failureCode: code.slice(0, 60) }),
              },
            });
            await recordAudit(
              tx,
              { workspaceId: context.actor.workspaceId, userId: null },
              {
                action:
                  activationStatus === "ACTIVE"
                    ? "ads.activation_succeeded"
                    : "ads.activation_failed",
                entityType: "ad_plan",
                entityId: plan.id,
                metadata: {
                  platform: plan.platform,
                  status: activationStatus,
                  code,
                  budgetMinor: Number(plan.budgetTotalMinor),
                  currency: plan.currency,
                },
              },
            );
          });
        };
        try {
          const state = await withPlatformToken(
            launchContext(context),
            context.actor.workspaceId,
            plan.platform,
            (token) =>
              runActivation({
                db: context.db,
                workspaceId: context.actor.workspaceId,
                planId: plan.id,
                writer,
                token,
                request,
                ids,
                signal: context.signal,
                beforeWrite: guardWrite(context),
              }),
          );
          await finish("ACTIVE", state.campaign, null);
          return { status: "succeeded", output: { planId: plan.id, status: state.campaign } };
        } catch (error) {
          const uncertain =
            (error instanceof AdPlatformError && error.uncertain) ||
            (error instanceof AppError && error.fields[0]?.code === "ads_outcome_unknown");
          const code = uncertain
            ? "ads_outcome_unknown"
            : error instanceof TaskError
              ? error.code
              : error instanceof AppError
                ? (error.fields[0]?.code ?? error.code)
                : error instanceof AdPlatformError
                  ? `ads_${error.kind}`
                  : "activation_failed";
          await finish(uncertain ? "UNCERTAIN" : "FAILED", null, code);
          throw new TaskError(code.slice(0, 60), false);
        }
      },
    },
    {
      key: "reconcile",
      dependsOn: ["activate"],
      risk: "INTERNAL",
      maxAttempts: 2,
      timeoutMs: 90_000,
      run: async (context) => {
        const plan = await planOf(context, { activationRunId: context.runId });
        const entry = context.services.ads()[plan.platform];
        const writer = entry.available ? (entry.adapter.writer ?? null) : null;
        if (writer === null) return { status: "skipped", output: { planId: plan.id } };
        const ids = await createdIds(context.db, context.actor.workspaceId, plan.id);
        const state = await withPlatformToken(
          launchContext(context),
          context.actor.workspaceId,
          plan.platform,
          (token) => writer.readState(token, ids, context.signal),
        );
        await context.db.adPlan.updateMany({
          where: { workspaceId: context.actor.workspaceId, id: plan.id },
          data: { externalStatus: state.campaign, externalCheckedAt: new Date() },
        });
        await recordAudit(
          context.db,
          { workspaceId: context.actor.workspaceId, userId: null },
          {
            action: "ads.state_reconciled",
            entityType: "ad_plan",
            entityId: plan.id,
            metadata: { platform: plan.platform, campaign: state.campaign, ad: state.ad },
          },
        );
        return { status: "succeeded", output: { planId: plan.id, status: state.campaign } };
      },
    },
  ],
};
