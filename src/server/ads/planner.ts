import "server-only";

import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";

import { generate, type AiRuntime } from "../ai/ai-service";
import { readStoredOutput } from "../ai/operations";
import type { AiLanguage } from "../ai/provider";
import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import { createRun, type OrchestrationDeps } from "../orchestration/engine";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";
import { parseInput } from "../validation/parse";

import { inclusiveDays, type AdAdapters, type ExternalAction, type LaunchRequest } from "./adapter";
import { withPlatformToken } from "./connections";
import { adsError, adsUnavailableOperation } from "./errors";
import { hasExternalObjects, readLedger } from "./execution";
import { executionPreflight } from "./execution-preflight";
import {
  AD_OBJECTIVES,
  AD_PLACEMENTS,
  placementsFor,
  PLATFORM_PLACEMENTS,
  readAccountSnapshot,
  readCampaignSpec,
  type AdCampaignSpec,
  type AdObjective,
  type AdPlacement,
  type AdPlatform,
} from "./model";
import {
  accountHistory,
  expectedResults,
  MAX_PLAN_DAYS,
  parseBudget,
  renderAdData,
  type ExpectedResults,
} from "./planner-math";

// The AI advertising planner and the plan review. A person chooses the ad account, the
// total budget and the dates; the AI (through the shared AI engine, with the workspace's
// brand, audiences and goals) proposes the objective, audience, placements and creative
// and may pick one of the workspace's images. Money, dates and any expected results are
// deterministic. A plan launches only through the approval workflow (ad_launch).

export const AD_LAUNCH_WORKFLOW = "ad_launch";
export const AD_ACTIVATE_WORKFLOW = "ad_activate";
const MAX_ASSETS = 9;
const fieldError = (path: string, code: "invalid_value" | "too_small" | "too_big") =>
  new AppError("VALIDATION_FAILED", { fields: [{ path, code }] });
const planNotFound = () => new AppError("NOT_FOUND", { metadata: { resource: "ad_plan" } });
const planLocked = () => adsError("CONFLICT", "ads_plan_locked");

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createAdPlanSchema = z.object({
  accountId: z.string().refine(isUuid),
  budget: z.string().trim().min(1).max(20),
  /** Where the ad leads (https). Optional here; required before a launch. */
  destinationUrl: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .url({ protocol: /^https$/ })
      .max(2000)
      .optional(),
  ),
  startDate: date,
  endDate: date,
  request: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(1000).optional(),
  ),
  language: z.enum(["ar", "en"]).optional(),
});

const updateAdPlanSchema = z.object({
  placements: z.array(z.enum(AD_PLACEMENTS)).min(1).max(AD_PLACEMENTS.length).optional(),
  destinationUrl: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z
      .url({ protocol: /^https$/ })
      .max(2000)
      .nullable()
      .optional(),
  ),
  budget: z.string().trim().min(1).max(20),
  startDate: date,
  endDate: date,
  campaignName: z.string().trim().min(1).max(200),
  headline: z.string().trim().min(1).max(120),
  primaryText: z.string().trim().min(1).max(1000),
});

function validDates(startDate: string, endDate: string, today: string) {
  if (Number.isNaN(Date.parse(`${startDate}T00:00:00Z`)))
    throw fieldError("startDate", "invalid_value");
  if (Number.isNaN(Date.parse(`${endDate}T00:00:00Z`)))
    throw fieldError("endDate", "invalid_value");
  if (startDate < today) throw fieldError("startDate", "too_small");
  const days = inclusiveDays(startDate, endDate);
  if (days < 1) throw fieldError("endDate", "too_small");
  if (days > MAX_PLAN_DAYS) throw fieldError("endDate", "too_big");
  return days;
}

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/** Today's date (YYYY-MM-DD) where the ad account runs — dates are the account's days. */
export function todayIn(timeZone: string | null, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return isoDay(now);
  }
}

async function selectedAccount(db: Db, ctx: TenantContext, accountId: string) {
  const account = await db.adAccount.findFirst({
    where: { workspaceId: ctx.workspaceId, id: accountId },
    select: {
      id: true,
      platform: true,
      name: true,
      externalId: true,
      currency: true,
      timeZone: true,
      selected: true,
      snapshot: true,
      connection: { select: { status: true } },
    },
  });
  if (account === null) throw new AppError("NOT_FOUND", { metadata: { resource: "ad_account" } });
  if (!account.selected || account.connection.status !== "ACTIVE") {
    throw adsError("CONFLICT", "ads_account_unavailable");
  }
  // A WhatsApp Business account is a conversation channel, not an ad account: campaigns
  // that lead to WhatsApp are planned on a Meta ad account (objective MESSAGES).
  if (account.platform === "WHATSAPP") throw adsUnavailableOperation("WHATSAPP.plan");
  return account;
}

/** The workspace's usable WhatsApp business name, offered as a conversation destination. */
async function whatsappDestination(db: Db, ctx: TenantContext): Promise<string | null> {
  const account = await db.adAccount.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      platform: "WHATSAPP",
      selected: true,
      connection: { status: "ACTIVE" },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { name: true },
  });
  return account?.name ?? null;
}

/**
 * What the platform's write path can launch, so the AI proposes only plans that can run
 * here. Null when there is no ready writer (nothing to constrain: such plans cannot
 * launch on this server anyway).
 */
export function launchableChoices(
  adapters: AdAdapters | undefined,
  platform: AdPlatform,
): { readonly objectives: AdObjective[]; readonly placements: AdPlacement[] } | null {
  const entry = adapters?.[platform];
  const writer = entry?.available === true ? entry.adapter.writer : undefined;
  if (writer?.ready !== true) return null;
  return {
    objectives: AD_OBJECTIVES.filter((objective) => writer.supportsObjective(objective)),
    placements: PLATFORM_PLACEMENTS[platform].filter((placement) =>
      writer.supportsPlacements([placement]),
    ),
  };
}

/**
 * Creates a plan from an AI proposal (ads.plan). Returns the plan id. With `adapters`,
 * the AI may only choose the objectives and placements the platform's write path
 * supports; a proposal outside them is refused rather than stored.
 */
export async function createAdPlan(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runtime: AiRuntime,
  input: unknown,
  uiLocale: AiLanguage,
  options: { readonly adapters?: AdAdapters } = {},
): Promise<{ readonly planId: string }> {
  assertCan(ctx, "ads.plan");
  const data = parseInput(createAdPlanSchema, input);
  const account = await selectedAccount(db, ctx, data.accountId);
  const budget = parseBudget(data.budget, account.currency);
  if (budget === null) throw fieldError("budget", "invalid_value");
  const days = validDates(data.startDate, data.endDate, todayIn(account.timeZone));

  const images = await db.mediaAsset.findMany({
    where: { workspaceId: ctx.workspaceId, contentType: { startsWith: "image/" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_ASSETS,
    select: { id: true, filename: true, altText: true },
  });
  const assetRefs = Object.fromEntries(
    images.map((image, index) => [`M${String(index + 1)}`, image.id]),
  );
  const snapshot = readAccountSnapshot(account.snapshot);
  const language: AiLanguage = data.language ?? uiLocale;
  const choices = launchableChoices(options.adapters, account.platform);
  // Click-to-WhatsApp ads exist on Meta only, and need the MESSAGES objective.
  const whatsapp =
    account.platform === "META" && (choices === null || choices.objectives.includes("MESSAGES"))
      ? await whatsappDestination(db, ctx)
      : null;

  const { generationId } = await generate(db, ctx, runtime, {
    operation: "AD_PLAN",
    permission: "ads.plan",
    requestedLanguage: data.language,
    uiLocale,
    focus: {},
    contentItemId: null,
    extraReferences: assetRefs,
    params: {
      request: data.request ?? null,
      extra: renderAdData({
        language,
        accountName: account.name,
        platform: account.platform,
        placements: choices?.placements ?? PLATFORM_PLACEMENTS[account.platform],
        ...(choices === null ? {} : { objectives: choices.objectives }),
        whatsapp,
        budget: { minor: budget, currency: account.currency },
        days,
        history: accountHistory(snapshot, account.currency),
        topCampaigns: (snapshot?.campaigns ?? []).map((c) => ({
          name: c.name,
          objective: c.objective,
        })),
        assets: images.map((image, index) => ({
          handle: `M${String(index + 1)}`,
          label: image.altText ?? image.filename,
        })),
      }),
    },
  });

  return db.$transaction(async (tx) => {
    const generation = await tx.aiGeneration.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        id: generationId,
        status: "SUCCEEDED",
        appliedAt: null,
      },
      select: { output: true },
    });
    const output = generation === null ? null : readStoredOutput("AD_PLAN", generation.output);
    if (output === null) throw adsError("CONFLICT", "ads_provider_error", { stage: "plan_output" });
    if (choices !== null && !choices.objectives.includes(output.objective)) {
      throw adsError("CONFLICT", "ads_provider_error", { stage: "plan_objective" });
    }
    const chosen = choices?.placements.filter((placement) => output.placements.includes(placement));
    const audience = output.audience;
    const spec = readCampaignSpec({
      objective: output.objective,
      campaignName: output.campaignName,
      audience: {
        ...audience,
        ageMin: Math.min(audience.ageMin, audience.ageMax),
        ageMax: Math.max(audience.ageMin, audience.ageMax),
      },
      // Only what the account's platform can express (Snapchat: automatic placement); with
      // a write path, only what it can launch (none chosen → all it supports).
      placements:
        chosen === undefined
          ? placementsFor(account.platform, output.placements)
          : chosen.length > 0
            ? chosen
            : [...(choices?.placements ?? [])],
      creative: {
        headline: output.creative.headline,
        primaryText: output.creative.primaryText,
        callToAction: output.creative.callToAction,
        mediaAssetId:
          output.creative.assetRef === null ? null : (assetRefs[output.creative.assetRef] ?? null),
        ...(data.destinationUrl === undefined ? {} : { destinationUrl: data.destinationUrl }),
      },
      rationale: output.rationale,
    } satisfies AdCampaignSpec);
    if (spec === null) throw adsError("CONFLICT", "ads_provider_error", { stage: "plan_spec" });
    await tx.aiGeneration.updateMany({
      where: { workspaceId: ctx.workspaceId, id: generationId, appliedAt: null },
      data: { appliedAt: new Date() },
    });
    const plan = await tx.adPlan.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        platform: account.platform,
        name: spec.campaignName,
        proposal: spec as unknown as Prisma.InputJsonValue,
        budgetTotalMinor: BigInt(budget),
        currency: account.currency,
        startDate: new Date(`${data.startDate}T00:00:00Z`),
        endDate: new Date(`${data.endDate}T00:00:00Z`),
        aiGenerationId: generationId,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: "ads.plan_created",
      entityType: "ad_plan",
      entityId: plan.id,
      metadata: {
        platform: account.platform,
        accountId: account.id,
        budgetMinor: budget,
        currency: account.currency,
        days,
        generationId,
      },
    });
    return { planId: plan.id };
  });
}

async function loadPlan(db: Db, ctx: TenantContext, planId: string) {
  if (!isUuid(planId)) throw planNotFound();
  const plan = await db.adPlan.findFirst({
    where: { workspaceId: ctx.workspaceId, id: planId },
    select: {
      id: true,
      platform: true,
      status: true,
      name: true,
      proposal: true,
      budgetTotalMinor: true,
      currency: true,
      startDate: true,
      endDate: true,
      runId: true,
      externalCampaignId: true,
      failureCode: true,
      version: true,
      createdAt: true,
      identityExternalId: true,
      identityName: true,
      identityOptions: true,
      identityCheckedAt: true,
      activationStatus: true,
      activationRunId: true,
      externalStatus: true,
      externalCheckedAt: true,
      createdBy: { select: { name: true } },
      run: { select: { state: true, failureCode: true } },
      activationRun: { select: { state: true, failureCode: true } },
      account: {
        select: {
          id: true,
          name: true,
          externalId: true,
          currency: true,
          timeZone: true,
          selected: true,
          snapshot: true,
          connection: { select: { status: true } },
        },
      },
    },
  });
  if (plan === null) throw planNotFound();
  return plan;
}

/** Edits a draft plan's money, dates and wording (ads.plan). */
export async function updateAdPlan(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  planId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx, "ads.plan");
  const data = parseInput(updateAdPlanSchema, input);
  const plan = await loadPlan(db, ctx, planId);
  if (plan.status !== "DRAFT") throw planLocked();
  // Objects already created on the platform were built from this exact plan.
  if (await hasExternalObjects(db, ctx.workspaceId, plan.id)) {
    throw adsError("CONFLICT", "ads_external_objects_exist");
  }
  const spec = readCampaignSpec(plan.proposal);
  if (spec === null) throw adsError("CONFLICT", "ads_provider_error", { stage: "plan_spec" });
  const budget = parseBudget(data.budget, plan.currency);
  if (budget === null) throw fieldError("budget", "invalid_value");
  const days = validDates(data.startDate, data.endDate, todayIn(plan.account.timeZone));
  const next: AdCampaignSpec = {
    ...spec,
    campaignName: data.campaignName,
    ...(data.placements === undefined
      ? {}
      : { placements: placementsFor(plan.platform, data.placements) }),
    creative: {
      ...spec.creative,
      headline: data.headline,
      primaryText: data.primaryText,
      ...(data.destinationUrl === undefined ? {} : { destinationUrl: data.destinationUrl }),
    },
  };
  await db.$transaction(async (tx) => {
    const updated = await tx.adPlan.updateMany({
      where: { workspaceId: ctx.workspaceId, id: plan.id, status: "DRAFT", version: plan.version },
      data: {
        name: next.campaignName,
        proposal: next as unknown as Prisma.InputJsonValue,
        budgetTotalMinor: BigInt(budget),
        startDate: new Date(`${data.startDate}T00:00:00Z`),
        endDate: new Date(`${data.endDate}T00:00:00Z`),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) throw planLocked();
    await recordAudit(tx, ctx, {
      action: "ads.plan_updated",
      entityType: "ad_plan",
      entityId: plan.id,
      metadata: { budgetMinor: budget, currency: plan.currency, days },
    });
  });
}

/** Discards a plan that is not on its way to the platform (ads.plan). */
export async function discardAdPlan(db: GuardedPrismaClient, ctx: TenantContext, planId: string) {
  assertCan(ctx, "ads.plan");
  const plan = await loadPlan(db, ctx, planId);
  await db.$transaction(async (tx) => {
    const updated = await tx.adPlan.updateMany({
      where: { workspaceId: ctx.workspaceId, id: plan.id, status: { in: ["DRAFT", "FAILED"] } },
      data: { status: "DISCARDED" },
    });
    if (updated.count === 0) throw planLocked();
    await recordAudit(tx, ctx, {
      action: "ads.plan_discarded",
      entityType: "ad_plan",
      entityId: plan.id,
    });
  });
}

/** The exact launch request of a plan (shared by the review and the workflow). */
export function launchRequestOf(
  plan: {
    readonly id: string;
    readonly budgetTotalMinor: bigint;
    readonly currency: string;
    readonly startDate: Date;
    readonly endDate: Date;
    readonly identityExternalId?: string | null;
    readonly account: { readonly externalId: string; readonly timeZone?: string | null };
  },
  spec: AdCampaignSpec,
  media: { readonly id: string; readonly filename: string } | null,
): LaunchRequest {
  return {
    planId: plan.id,
    accountExternalId: plan.account.externalId,
    currency: plan.currency,
    budgetTotalMinor: Number(plan.budgetTotalMinor),
    startDate: isoDay(plan.startDate),
    endDate: isoDay(plan.endDate),
    spec,
    media,
    timeZone: plan.account.timeZone ?? null,
    identityId: plan.identityExternalId ?? null,
  };
}

export async function planMedia(db: Db, workspaceId: string, spec: AdCampaignSpec) {
  if (spec.creative.mediaAssetId === null) return null;
  return db.mediaAsset.findFirst({
    where: { workspaceId, id: spec.creative.mediaAssetId },
    select: { id: true, filename: true, altText: true, contentType: true },
  });
}

export interface AdPlanReview {
  readonly id: string;
  readonly platform: AdPlatform;
  readonly status: string;
  readonly name: string;
  readonly version: number;
  readonly spec: AdCampaignSpec | null;
  readonly budget: { readonly minor: number; readonly currency: string };
  readonly startDate: string;
  readonly endDate: string;
  readonly days: number;
  readonly account: { readonly id: string; readonly name: string; readonly externalId: string };
  readonly media: {
    readonly id: string;
    readonly filename: string;
    readonly altText: string | null;
  } | null;
  readonly expected: ExpectedResults;
  /** The exact calls a launch would make, or null when the platform has no adapter here. */
  readonly externalActions: readonly ExternalAction[] | null;
  readonly launch:
    | { readonly available: true }
    | {
        readonly available: false;
        readonly reason: LaunchBlocker;
      };
  /** What exists on the platform, step by step, and the activation's state. */
  readonly execution: {
    readonly identity: string | null;
    readonly identityName: string | null;
    /** The identities last listed for this plan (a person picks one). */
    readonly identityOptions: readonly { readonly id: string; readonly name: string }[];
    readonly identityCheckedAt: Date | null;
    /** Choosing the identity applies (a write path that publishes as an identity). */
    readonly identityRequired: boolean;
    readonly steps: readonly {
      readonly step: string;
      readonly status: string;
      readonly externalId: string | null;
      readonly errorCode: string | null;
    }[];
    readonly activationStatus: string | null;
    readonly activationRunState: string | null;
    readonly externalStatus: string | null;
    readonly externalCheckedAt: Date | null;
    readonly canRequestActivation: boolean;
  };
  readonly runState: string | null;
  readonly failureCode: string | null;
  readonly externalCampaignId: string | null;
  readonly createdByName: string | null;
  readonly createdAt: Date;
}

export type LaunchBlocker =
  | "not_configured"
  | "not_implemented"
  | "not_supported"
  | "blocked"
  | "objective_unsupported"
  | "currency_unsupported"
  | "placement_unsupported"
  | "execution_disabled"
  | "destination_missing"
  | "spend_limit_missing";

/** Why a plan cannot be launched here, or null when it can (read-only; no platform call). */
async function launchBlocker(
  db: Db,
  workspaceId: string,
  entry: AdAdapters[AdPlatform],
  spec: AdCampaignSpec | null,
  currency: string,
  executionEnabled: boolean,
): Promise<LaunchBlocker | null> {
  if (!entry.available) return entry.reason;
  const { adapter } = entry;
  if (!adapter.capabilities.launchCampaign) {
    return adapter.writer !== undefined && !adapter.writer.ready ? "blocked" : "not_supported";
  }
  if (
    spec !== null &&
    adapter.writer !== undefined &&
    !adapter.writer.supportsObjective(spec.objective)
  ) {
    return "objective_unsupported";
  }
  if (adapter.writer !== undefined && !adapter.writer.supportsCurrency(currency)) {
    return "currency_unsupported";
  }
  if (
    spec !== null &&
    adapter.writer !== undefined &&
    !adapter.writer.supportsPlacements(spec.placements)
  ) {
    return "placement_unsupported";
  }
  if (!executionEnabled) return "execution_disabled";
  if (adapter.writer !== undefined && (spec?.creative.destinationUrl ?? null) === null) {
    return "destination_missing";
  }
  const limit = await db.adSpendLimit.count({ where: { workspaceId, currency } });
  return limit === 0 ? "spend_limit_missing" : null;
}

/** Everything the review screen shows (ads.view). */
export async function getAdPlanReview(
  db: Db,
  ctx: TenantContext,
  adapters: AdAdapters,
  planId: string,
  options: { readonly executionEnabled?: boolean } = {},
): Promise<AdPlanReview> {
  assertCan(ctx, "ads.view");
  const plan = await loadPlan(db, ctx, planId);
  const spec = readCampaignSpec(plan.proposal);
  const media = spec === null ? null : await planMedia(db, ctx.workspaceId, spec);
  const entry = adapters[plan.platform];
  const snapshot = readAccountSnapshot(plan.account.snapshot);
  const budgetMinor = Number(plan.budgetTotalMinor);
  const startDate = isoDay(plan.startDate);
  const endDate = isoDay(plan.endDate);
  const ledger = await readLedger(db, ctx.workspaceId, plan.id);
  const blocker = await launchBlocker(
    db,
    ctx.workspaceId,
    entry,
    spec,
    plan.currency,
    options.executionEnabled ?? false,
  );
  return {
    id: plan.id,
    platform: plan.platform,
    status: plan.status,
    name: plan.name,
    version: plan.version,
    spec,
    budget: { minor: budgetMinor, currency: plan.currency },
    startDate,
    endDate,
    days: inclusiveDays(startDate, endDate),
    account: { id: plan.account.id, name: plan.account.name, externalId: plan.account.externalId },
    media:
      media === null ? null : { id: media.id, filename: media.filename, altText: media.altText },
    expected: expectedResults(accountHistory(snapshot, plan.currency), budgetMinor),
    externalActions:
      spec === null || !entry.available
        ? null
        : entry.adapter.describeLaunch(
            launchRequestOf(
              plan,
              spec,
              media === null ? null : { id: media.id, filename: media.filename },
            ),
          ),
    launch: blocker === null ? { available: true } : { available: false, reason: blocker },
    execution: {
      identity: plan.identityExternalId,
      identityName: plan.identityName,
      identityOptions: readIdentityOptions(plan.identityOptions),
      identityCheckedAt: plan.identityCheckedAt,
      identityRequired: entry.available && entry.adapter.writer?.ready === true,
      steps: [...ledger.entries()].map(([step, row]) => ({
        step,
        status: row.status,
        externalId: row.externalId,
        errorCode: row.errorCode,
      })),
      activationStatus: plan.activationStatus,
      activationRunState: plan.activationRun?.state ?? null,
      externalStatus: plan.externalStatus,
      externalCheckedAt: plan.externalCheckedAt,
      canRequestActivation:
        plan.status === "LAUNCHED" &&
        entry.available &&
        entry.adapter.writer !== undefined &&
        (plan.activationStatus === null ||
          plan.activationStatus === "FAILED" ||
          plan.activationStatus === "UNCERTAIN" ||
          (plan.activationStatus === "REQUESTED" &&
            ["FAILED", "CANCELLED"].includes(plan.activationRun?.state ?? ""))),
    },
    runState: plan.run?.state ?? null,
    failureCode: plan.failureCode ?? plan.run?.failureCode ?? null,
    externalCampaignId: plan.externalCampaignId,
    createdByName: plan.createdBy?.name ?? null,
    createdAt: plan.createdAt,
  };
}

/**
 * Sends a draft plan to the approval workflow (ads.plan + automation.manage: the run acts
 * with the submitter's authority). Refused when the platform cannot launch campaigns here.
 */
export interface ExecutionDeps {
  readonly adapters: AdAdapters;
  /** ADS_EXECUTION_ENABLED: external writes are refused unless true. */
  readonly executionEnabled?: boolean;
  /** ENCRYPTION_KEY, to read the connection's token (identity resolution). */
  readonly tokenKey?: string | null;
}

export async function submitAdPlan<S>(
  deps: OrchestrationDeps<S> & ExecutionDeps,
  ctx: TenantContext,
  planId: string,
): Promise<{ readonly runId: string }> {
  assertCan(ctx, "ads.plan");
  assertCan(ctx, "automation.manage");
  const plan = await loadPlan(deps.db, ctx, planId);
  if (plan.status !== "DRAFT") throw planLocked();
  const entry = deps.adapters[plan.platform];
  if (!entry.available || !entry.adapter.capabilities.launchCampaign) {
    throw adsUnavailableOperation(`${plan.platform}.launchCampaign`);
  }
  if (!plan.account.selected || plan.account.connection.status !== "ACTIVE") {
    throw adsError("CONFLICT", "ads_account_unavailable");
  }
  const spec = readCampaignSpec(plan.proposal);
  if (spec === null) throw adsError("CONFLICT", "ads_provider_error", { stage: "plan_spec" });
  const { writer } = await executionPreflight({
    db: deps.db,
    actor: ctx,
    adapters: deps.adapters,
    executionEnabled: deps.executionEnabled ?? false,
    plan: {
      platform: plan.platform,
      spec,
      budgetMinor: Number(plan.budgetTotalMinor),
      currency: plan.currency,
      startDate: isoDay(plan.startDate),
      endDate: isoDay(plan.endDate),
    },
  });
  // The identity the ads publish as is fixed now and becomes part of the approved action:
  // the one a person chose, confirmed against the platform's current list — or the only
  // one there is. Never a guess between several.
  let identity: { id: string; name: string } | null =
    plan.identityExternalId === null
      ? null
      : { id: plan.identityExternalId, name: plan.identityName ?? plan.identityExternalId };
  // Once objects exist on the platform they keep the identity they were created with.
  const locked = identity !== null && (await hasExternalObjects(deps.db, ctx.workspaceId, plan.id));
  if (writer !== null && !locked) {
    const listed = await withPlatformToken(
      { db: deps.db, adapters: deps.adapters, tokenKey: deps.tokenKey ?? null },
      ctx.workspaceId,
      plan.platform,
      (token) => writer.listIdentities(token, plan.account.externalId),
    );
    identity = chooseIdentity(listed, plan.identityExternalId);
  }
  const { runId } = await createRun(
    deps,
    { workspaceId: ctx.workspaceId, requestedByUserId: ctx.userId },
    AD_LAUNCH_WORKFLOW,
    "MANUAL",
    `ad_launch:${plan.id}:${String(plan.version)}`,
  );
  await deps.db.$transaction(async (tx) => {
    const updated = await tx.adPlan.updateMany({
      where: { workspaceId: ctx.workspaceId, id: plan.id, status: "DRAFT", version: plan.version },
      data: {
        status: "SUBMITTED",
        runId,
        identityExternalId: identity?.id ?? null,
        identityName: identity?.name ?? null,
      },
    });
    if (updated.count === 0) throw planLocked();
    await recordAudit(tx, ctx, {
      action: "ads.launch_requested",
      entityType: "ad_plan",
      entityId: plan.id,
      metadata: {
        platform: plan.platform,
        runId,
        budgetMinor: Number(plan.budgetTotalMinor),
        currency: plan.currency,
      },
    });
  });
  return { runId };
}

/** A submitted plan whose run ended without launching goes back to draft (ads.plan). */
export async function reopenAdPlan(db: GuardedPrismaClient, ctx: TenantContext, planId: string) {
  assertCan(ctx, "ads.plan");
  const plan = await loadPlan(db, ctx, planId);
  const ended = plan.run === null || ["FAILED", "CANCELLED"].includes(plan.run.state);
  if (plan.status !== "SUBMITTED" && plan.status !== "FAILED") throw planLocked();
  if (!ended) throw planLocked();
  const updated = await db.adPlan.updateMany({
    where: { workspaceId: ctx.workspaceId, id: plan.id, status: { in: ["SUBMITTED", "FAILED"] } },
    data: { status: "DRAFT", failureCode: null, version: { increment: 1 } },
  });
  if (updated.count === 0) throw planLocked();
}

/**
 * Asks for the created (paused) campaign to be turned on (ads.plan + automation.manage):
 * starts the ad_activate workflow, whose SPEND task a person must approve. Never automatic.
 */
export async function requestActivation<S>(
  deps: OrchestrationDeps<S> & ExecutionDeps,
  ctx: TenantContext,
  planId: string,
): Promise<{ readonly runId: string }> {
  assertCan(ctx, "ads.plan");
  assertCan(ctx, "automation.manage");
  const plan = await loadPlan(deps.db, ctx, planId);
  if (plan.status !== "LAUNCHED") throw adsError("CONFLICT", "ads_not_created");
  if (plan.activationStatus === "ACTIVE") throw planLocked();
  // A request whose run ended without recording an outcome (a crashed or cancelled
  // worker) may be asked again: the new run reads the platform before writing anything.
  if (
    plan.activationStatus === "REQUESTED" &&
    !["FAILED", "CANCELLED"].includes(plan.activationRun?.state ?? "")
  ) {
    throw planLocked();
  }
  const entry = deps.adapters[plan.platform];
  if (!entry.available || entry.adapter.writer === undefined) {
    throw adsUnavailableOperation(`${plan.platform}.activate`);
  }
  const spec = readCampaignSpec(plan.proposal);
  if (spec === null) throw adsError("CONFLICT", "ads_provider_error", { stage: "plan_spec" });
  await executionPreflight({
    db: deps.db,
    actor: ctx,
    adapters: deps.adapters,
    executionEnabled: deps.executionEnabled ?? false,
    plan: {
      platform: plan.platform,
      spec,
      budgetMinor: Number(plan.budgetTotalMinor),
      currency: plan.currency,
      startDate: isoDay(plan.startDate),
      endDate: isoDay(plan.endDate),
    },
  });
  const { runId } = await createRun(
    deps,
    { workspaceId: ctx.workspaceId, requestedByUserId: ctx.userId },
    AD_ACTIVATE_WORKFLOW,
    "MANUAL",
    `ad_activate:${plan.id}:${plan.activationRunId ?? "first"}`,
  );
  await deps.db.$transaction(async (tx) => {
    const updated = await tx.adPlan.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        id: plan.id,
        status: "LAUNCHED",
        activationRunId: plan.activationRunId,
      },
      data: { activationStatus: "REQUESTED", activationRunId: runId, failureCode: null },
    });
    if (updated.count === 0) throw planLocked();
    await recordAudit(tx, ctx, {
      action: "ads.activation_requested",
      entityType: "ad_plan",
      entityId: plan.id,
      metadata: {
        platform: plan.platform,
        runId,
        budgetMinor: Number(plan.budgetTotalMinor),
        currency: plan.currency,
      },
    });
  });
  return { runId };
}

/**
 * The identity a submission uses: the chosen one if the platform still lists it; else the
 * only one when the list is complete. Refuses (never guesses) otherwise.
 */
function chooseIdentity(
  listed: {
    readonly identities: readonly { id: string; name: string }[];
    readonly complete: boolean;
  },
  chosen: string | null,
): { id: string; name: string } {
  if (chosen !== null) {
    const found = listed.identities.find((identity) => identity.id === chosen);
    if (found === undefined) throw adsError("CONFLICT", "ads_identity_missing");
    return found;
  }
  const [only, ...others] = listed.identities;
  if (only === undefined) {
    throw adsError("CONFLICT", listed.complete ? "ads_identity_missing" : "ads_identity_ambiguous");
  }
  if (others.length > 0 || !listed.complete) throw adsError("CONFLICT", "ads_identity_ambiguous");
  return only;
}

const identityOptionsSchema = z
  .array(
    z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: z.string().max(200) }),
  )
  .max(500);

/** The identities stored for a plan by its last listing (re-validated on read). */
export function readIdentityOptions(value: unknown): { id: string; name: string }[] {
  const parsed = identityOptionsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * Lists the identities (Facebook Pages) this connection may advertise as and stores them
 * on the plan for a person to choose from (ads.plan). Read-only on the platform. When
 * exactly one exists (complete list) and none is chosen yet, it is chosen.
 */
export async function refreshPlanIdentities(
  deps: ExecutionDeps & { readonly db: GuardedPrismaClient },
  ctx: TenantContext,
  planId: string,
): Promise<{ readonly count: number; readonly complete: boolean }> {
  assertCan(ctx, "ads.plan");
  const plan = await loadPlan(deps.db, ctx, planId);
  if (plan.status !== "DRAFT") throw planLocked();
  if (await hasExternalObjects(deps.db, ctx.workspaceId, plan.id)) {
    throw adsError("CONFLICT", "ads_external_objects_exist");
  }
  const entry = deps.adapters[plan.platform];
  const writer = entry.available ? entry.adapter.writer : undefined;
  if (!writer?.ready) {
    throw adsUnavailableOperation(`${plan.platform}.identities`);
  }
  const listed = await withPlatformToken(
    { db: deps.db, adapters: deps.adapters, tokenKey: deps.tokenKey ?? null },
    ctx.workspaceId,
    plan.platform,
    (token) => writer.listIdentities(token, plan.account.externalId),
  );
  const options = listed.identities.slice(0, 500).map(({ id, name }) => ({ id, name }));
  const stillListed = options.find((option) => option.id === plan.identityExternalId) ?? null;
  const [only, ...others] = options;
  const chosen =
    stillListed ??
    (plan.identityExternalId === null &&
    only !== undefined &&
    others.length === 0 &&
    listed.complete
      ? only
      : null);
  await deps.db.$transaction(async (tx) => {
    const updated = await tx.adPlan.updateMany({
      where: { workspaceId: ctx.workspaceId, id: plan.id, status: "DRAFT", version: plan.version },
      data: {
        identityOptions: options,
        identityCheckedAt: new Date(),
        identityExternalId: chosen?.id ?? null,
        identityName: chosen?.name ?? null,
        ...(chosen?.id === plan.identityExternalId ? {} : { version: { increment: 1 } }),
      },
    });
    if (updated.count === 0) throw planLocked();
    await recordAudit(tx, ctx, {
      action: "ads.identities_listed",
      entityType: "ad_plan",
      entityId: plan.id,
      metadata: {
        platform: plan.platform,
        count: options.length,
        complete: listed.complete,
        chosen: chosen?.id ?? null,
      },
    });
  });
  return { count: options.length, complete: listed.complete };
}

/** A person chooses the identity (Facebook Page) a plan's ads publish as (ads.plan). */
export async function selectPlanIdentity(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  planId: string,
  identityId: string,
): Promise<void> {
  assertCan(ctx, "ads.plan");
  const plan = await loadPlan(db, ctx, planId);
  if (plan.status !== "DRAFT") throw planLocked();
  if (await hasExternalObjects(db, ctx.workspaceId, plan.id)) {
    throw adsError("CONFLICT", "ads_external_objects_exist");
  }
  const option = readIdentityOptions(plan.identityOptions).find((item) => item.id === identityId);
  if (option === undefined) throw adsError("CONFLICT", "ads_identity_missing");
  await db.$transaction(async (tx) => {
    const updated = await tx.adPlan.updateMany({
      where: { workspaceId: ctx.workspaceId, id: plan.id, status: "DRAFT", version: plan.version },
      data: {
        identityExternalId: option.id,
        identityName: option.name,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) throw planLocked();
    await recordAudit(tx, ctx, {
      action: "ads.identity_selected",
      entityType: "ad_plan",
      entityId: plan.id,
      metadata: { platform: plan.platform, identity: option.id },
    });
  });
}
