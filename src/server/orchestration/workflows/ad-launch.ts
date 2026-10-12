import type { Prisma } from "@/generated/prisma/client";

import type { AdAdapters, MediaPayload } from "../../ads/adapter";
import { AdPlatformError } from "../../ads/adapter";
import { withPlatformToken } from "../../ads/connections";
import { executionTag, runCreationSteps, type StepEvent } from "../../ads/execution";
import { executionPreflight } from "../../ads/execution-preflight";
import { readCampaignSpec } from "../../ads/model";
import { AD_LAUNCH_WORKFLOW, launchRequestOf, planMedia } from "../../ads/planner";
import { recordAudit } from "../../audit/audit-log";
import { AppError } from "../../errors/app-error";
import type { TenantContext } from "../../tenancy/context";
import { policySnapshot } from "../engine";
import type { TaskContext, WorkflowDefinition } from "../workflow";
import { TaskError } from "../workflow";

// Creating an approved advertising plan on its platform. validate (INTERNAL) → launch
// (SPEND) → report. The launch task describes exactly what it will send — every call,
// the identity, the destination and the total budget — so the engine asks a person to
// approve that action, re-describes it right before running, and runs it once. Any change
// to the plan, its account, identity or connection changes the description and requires
// a new approval.
//
// With a platform write path (AdWriter) the campaign, ad set, creative and ad are created
// PAUSED through the shared execution service (ads/execution.ts), which records every
// external object, resumes without duplicates and reconciles uncertain writes. Nothing
// delivers or spends until activation is approved separately (ad-activate.ts).

export interface AdLaunchServices {
  readonly ads: () => AdAdapters;
  readonly tokenKey: () => string | null;
  /** External writes are off unless the server enables them (ADS_EXECUTION_ENABLED). */
  readonly executionEnabled?: () => boolean;
  /** The creative file of a plan (from the workspace's media library). */
  readonly readMedia?: (ctx: TenantContext, assetId: string) => Promise<MediaPayload | null>;
}

export async function planOf(
  context: Pick<TaskContext<AdLaunchServices>, "db" | "actor">,
  where: { runId: string } | { activationRunId: string },
) {
  const plan = await context.db.adPlan.findFirst({
    where: { workspaceId: context.actor.workspaceId, ...where },
    select: {
      id: true,
      platform: true,
      status: true,
      proposal: true,
      budgetTotalMinor: true,
      currency: true,
      startDate: true,
      endDate: true,
      version: true,
      identityExternalId: true,
      identityName: true,
      activationStatus: true,
      account: {
        select: {
          id: true,
          externalId: true,
          currency: true,
          timeZone: true,
          selected: true,
          externalStatus: true,
          connection: { select: { status: true, externalUserId: true, version: true } },
        },
      },
    },
  });
  if (plan === null) throw new TaskError("plan_missing", false);
  return plan;
}

/**
 * Re-checked immediately before every external write (not only when the task was
 * claimed): the emergency stop, which may have been pressed while earlier steps ran.
 */
export function guardWrite(context: Pick<TaskContext<AdLaunchServices>, "db" | "actor">) {
  return async () => {
    if ((await policySnapshot(context.db, context.actor.workspaceId)).paused) {
      throw new TaskError("automation_paused", false);
    }
  };
}

export function launchContext(context: Pick<TaskContext<AdLaunchServices>, "db" | "services">) {
  return {
    db: context.db,
    adapters: context.services.ads(),
    tokenKey: context.services.tokenKey(),
  };
}

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/** The pre-execution checks, as task errors (never retried: a person must act). */
export async function preflightOrFail(
  context: Pick<TaskContext<AdLaunchServices>, "db" | "actor" | "services">,
  plan: Awaited<ReturnType<typeof planOf>>,
) {
  const spec = readCampaignSpec(plan.proposal);
  if (spec === null) throw new TaskError("plan_invalid", false);
  if (!plan.account.selected || plan.account.connection.status !== "ACTIVE") {
    throw new TaskError("account_unavailable", false);
  }
  try {
    const checked = await executionPreflight({
      db: context.db,
      actor: context.actor,
      adapters: context.services.ads(),
      executionEnabled: context.services.executionEnabled?.() ?? false,
      plan: {
        platform: plan.platform,
        spec,
        budgetMinor: Number(plan.budgetTotalMinor),
        currency: plan.currency,
        startDate: isoDay(plan.startDate),
        endDate: isoDay(plan.endDate),
        accountStatus: plan.account.externalStatus,
      },
    });
    return { ...checked, spec };
  } catch (error) {
    if (error instanceof AppError) {
      throw new TaskError((error.fields[0]?.code ?? error.code.toLowerCase()).slice(0, 60), false);
    }
    throw error;
  }
}

async function auditStep(
  context: Pick<TaskContext<AdLaunchServices>, "db" | "actor">,
  planId: string,
  platform: string,
  event: StepEvent,
) {
  const action =
    event.outcome === "succeeded"
      ? "ads.step_succeeded"
      : event.outcome === "reconciled"
        ? "ads.step_reconciled"
        : event.outcome === "uncertain"
          ? "ads.step_uncertain"
          : "ads.step_failed";
  await recordAudit(
    context.db,
    { workspaceId: context.actor.workspaceId, userId: null },
    {
      action,
      entityType: "ad_plan",
      entityId: planId,
      metadata: { platform, step: event.step, externalId: event.externalId, code: event.code },
    },
  );
}

export const adLaunchWorkflow: WorkflowDefinition<AdLaunchServices> = {
  id: AD_LAUNCH_WORKFLOW,
  summaryTask: "report",
  tasks: [
    {
      key: "validate",
      dependsOn: [],
      risk: "INTERNAL",
      maxAttempts: 1,
      timeoutMs: 10_000,
      run: async (context) => {
        const plan = await planOf(context, { runId: context.runId });
        if (plan.status !== "SUBMITTED") throw new TaskError("plan_not_submitted", false);
        await preflightOrFail(context, plan);
        return { status: "succeeded", output: { planId: plan.id } };
      },
    },
    {
      key: "launch",
      dependsOn: ["validate"],
      risk: "SPEND",
      maxAttempts: 1,
      // Covers every request the creation can make (5 writes, each bounded by
      // META_REQUEST_TIMEOUT_MS) plus lookups; a timeout aborts the requests in flight.
      timeoutMs: 180_000,
      describe: async (context) => {
        const plan = await planOf(context, { runId: context.runId });
        const spec = readCampaignSpec(plan.proposal);
        const entry = context.services.ads()[plan.platform];
        if (spec === null || !entry.available) throw new TaskError("plan_invalid", false);
        const media = await planMedia(context.db, context.actor.workspaceId, spec);
        const request = launchRequestOf(
          plan,
          spec,
          media === null ? null : { id: media.id, filename: media.filename },
        );
        return {
          action: "launch_ad_campaign",
          details: {
            platform: plan.platform,
            planId: plan.id,
            planVersion: plan.version,
            account: plan.account.externalId,
            connectedAs: plan.account.connection.externalUserId,
            connectionVersion: plan.account.connection.version,
            identity: plan.identityExternalId,
            identityName: plan.identityName,
            destination: spec.creative.destinationUrl ?? null,
            media: media === null ? null : { id: media.id, filename: media.filename },
            startDate: request.startDate,
            endDate: request.endDate,
            createdPaused: true,
            calls: entry.adapter.describeLaunch(request).map((call) => ({
              method: call.method,
              endpoint: call.endpoint,
              params: call.params,
            })),
          },
          amount: { minor: request.budgetTotalMinor, currency: request.currency },
        };
      },
      run: async (context) => {
        const plan = await planOf(context, { runId: context.runId });
        if (plan.status !== "SUBMITTED") throw new TaskError("plan_not_submitted", false);
        const { writer, spec } = await preflightOrFail(context, plan);
        const media = await planMedia(context.db, context.actor.workspaceId, spec);
        const request = launchRequestOf(
          plan,
          spec,
          media === null ? null : { id: media.id, filename: media.filename },
        );
        const finish = async (
          data: Prisma.AdPlanUpdateManyMutationInput,
          action: "ads.launch_succeeded" | "ads.launch_failed",
          metadata: Record<string, unknown>,
        ) => {
          await context.db.$transaction(async (tx) => {
            await tx.adPlan.updateMany({
              where: { workspaceId: context.actor.workspaceId, id: plan.id, status: "SUBMITTED" },
              data,
            });
            await recordAudit(
              tx,
              { workspaceId: context.actor.workspaceId, userId: null },
              { action, entityType: "ad_plan", entityId: plan.id, metadata },
            );
          });
        };
        try {
          const result = await withPlatformToken(
            launchContext(context),
            context.actor.workspaceId,
            plan.platform,
            async (token, adapter) => {
              if (writer === null) {
                // A platform without a write path but with a single-call launch.
                if (adapter.launchCampaign === undefined) throw new AdPlatformError("unavailable");
                return adapter.launchCampaign(token, request);
              }
              const identityId = plan.identityExternalId;
              if (identityId === null) throw new TaskError("ads_identity_missing", false);
              const file =
                media === null
                  ? null
                  : ((await context.services.readMedia?.(context.actor, media.id)) ?? null);
              if (media !== null && file === null) throw new TaskError("media_unavailable", false);
              const ids = await runCreationSteps({
                db: context.db,
                workspaceId: context.actor.workspaceId,
                planId: plan.id,
                writer,
                token,
                context: {
                  request,
                  tag: executionTag(plan.id),
                  identityId,
                  media: file,
                  signal: context.signal,
                },
                onEvent: (event) => auditStep(context, plan.id, plan.platform, event),
                beforeWrite: guardWrite(context),
              });
              const campaign = ids.campaign;
              if (campaign === undefined) throw new TaskError("launch_incomplete", false);
              return { externalCampaignId: campaign };
            },
          );
          await finish(
            {
              status: "LAUNCHED",
              externalCampaignId: result.externalCampaignId,
              externalStatus: "PAUSED",
              externalCheckedAt: new Date(),
            },
            "ads.launch_succeeded",
            {
              platform: plan.platform,
              externalCampaignId: result.externalCampaignId,
              budgetMinor: request.budgetTotalMinor,
              currency: request.currency,
              paused: true,
            },
          );
          return {
            status: "succeeded",
            output: { planId: plan.id, externalCampaignId: result.externalCampaignId },
          };
        } catch (error) {
          // Never retried automatically: what exists is in the ledger; an uncertain write
          // is reconciled when a person resubmits (after a new approval).
          const code =
            error instanceof TaskError
              ? error.code
              : error instanceof AppError
                ? (error.fields[0]?.code ?? error.code)
                : error instanceof AdPlatformError
                  ? error.uncertain
                    ? "ads_outcome_unknown"
                    : `ads_${error.kind}`
                  : "launch_failed";
          await finish({ status: "FAILED", failureCode: code.slice(0, 60) }, "ads.launch_failed", {
            platform: plan.platform,
            code,
          });
          throw new TaskError(code.slice(0, 60), false);
        }
      },
    },
    {
      key: "report",
      dependsOn: ["validate", "launch"],
      risk: "INTERNAL",
      maxAttempts: 1,
      timeoutMs: 10_000,
      run: (context) => {
        const launch = context.inputs.launch as Record<string, unknown> | undefined;
        return Promise.resolve({
          status: "succeeded",
          output: {
            planId: launch?.planId ?? null,
            externalCampaignId: launch?.externalCampaignId ?? null,
          },
        });
      },
    },
  ],
};
