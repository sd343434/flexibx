import type { Prisma } from "@/generated/prisma/client";
import type { AiOperation, BrandLanguage } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db, GuardedTransactionClient } from "../db/types";
import { AppError } from "../errors/app-error";
import type { ErrorCode } from "../errors/codes";
import { conflict, fieldError, resolveReference, workspaceTimeZone } from "../marketing/common";
import { contentMetadata, createContentIn, updateContentIn } from "../marketing/content-service";
import { utcToZonedLocal, zonedDateKey, zonedLocalToUtc } from "../marketing/time";
import type { TenantContext } from "../tenancy/context";
import { assertCan, can, type Action } from "../tenancy/permissions";
import type { ValidationCode } from "../validation/field-errors";

import { assistedFields, newContentFields, type DraftFields } from "./apply-fields";
import { loadContext, renderContext, type ContextFocus } from "./context";
import type {
  AssistContentInput,
  GenerateBriefInput,
  GenerateCopyInput,
  GenerateIdeasInput,
} from "./inputs";
import {
  choiceCount,
  forbiddenWordsIn,
  isAssistOperation,
  isContentOperation,
  MAX_OUTPUT_TOKENS,
  NEW_CONTENT_OPERATIONS,
  parseOutput,
  readStoredOutput,
  type AnyAiOutput,
} from "./operations";
import { buildSystemPrompt, buildUserPrompt, type PromptParams } from "./prompts";
import { isAiProviderError, type AiFailure, type AiLanguage, type AiProvider } from "./provider";
import { AiRunError, runProvider } from "./run";

// The AI Marketing Engine (Phase 4). AI assists; people decide. A generation is a
// suggestion stored on the server; nothing reaches content until the person who asked
// for it chooses "Use", which runs through the regular content services (new content is
// created as DRAFT; assistance applies only to a DRAFT). Nothing here approves,
// schedules, publishes, or changes a workflow status.
//
// Permissions (existing actions only): new-content generation and using it needs
// content.create; assistance on a draft and using it needs content.edit; the usage
// summary needs audit.view.
//
// Daily cap: every generation attempt that reaches the provider stage is recorded first
// (status PENDING), under a lock on the workspace row, and counts towards
// DAILY_GENERATION_CAP for the current day in the workspace's time zone — whether it
// later succeeds or fails. Requests refused earlier (not configured, invalid input,
// permission, rate limit, cap reached) are not recorded and do not count.

export const DAILY_GENERATION_CAP = 300;
export const HISTORY_LIMIT = 10;
export const USAGE_WINDOW_DAYS = 30;

export interface AiRuntime {
  /** null = AI is not configured (AI_PROVIDER=disabled). */
  readonly provider: AiProvider | null;
  readonly timeoutMs: number;
  readonly now?: () => Date;
}

// ── Errors ───────────────────────────────────────────────────────────────────

function aiError(code: ErrorCode, field: ValidationCode, metadata: Record<string, unknown> = {}) {
  return new AppError(code, {
    message: `AI: ${field}`,
    fields: [{ path: "ai", code: field }],
    metadata,
  });
}

export function aiNotConfigured(): AppError {
  return aiError("SERVICE_UNAVAILABLE", "ai_not_configured");
}

export function dailyCapReached(): AppError {
  return new AppError("RATE_LIMITED", {
    message: "AI daily generation cap reached",
    fields: [{ path: "ai", code: "ai_daily_cap", params: { maximum: DAILY_GENERATION_CAP } }],
    metadata: { cap: DAILY_GENERATION_CAP },
  });
}

const FAILURE_ERRORS: Readonly<Record<AiFailure, { code: ErrorCode; field: ValidationCode }>> = {
  timeout: { code: "SERVICE_UNAVAILABLE", field: "ai_timeout" },
  unavailable: { code: "SERVICE_UNAVAILABLE", field: "ai_unavailable" },
  rate_limited: { code: "RATE_LIMITED", field: "ai_provider_busy" },
  refused: { code: "SERVICE_UNAVAILABLE", field: "ai_refused" },
  invalid_output: { code: "SERVICE_UNAVAILABLE", field: "ai_invalid_output" },
};

export function failureError(kind: AiFailure): AppError {
  const mapped = FAILURE_ERRORS[kind];
  return aiError(mapped.code, mapped.field, { failure: kind });
}

function generationNotFound(): AppError {
  return new AppError("NOT_FOUND", { metadata: { resource: "ai_generation" } });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Requested language, else the brand's content language, else the person's UI locale. */
export function resolveLanguage(
  requested: AiLanguage | undefined,
  brandLanguage: BrandLanguage | null | undefined,
  uiLocale: AiLanguage,
): AiLanguage {
  if (requested !== undefined) return requested;
  if (brandLanguage === "AR") return "ar";
  if (brandLanguage === "EN") return "en";
  return uiLocale;
}

/**
 * Estimated cost in millionths of a dollar. Only providers with a known price table can
 * be estimated; none exists yet (the fake provider is free), so this is always null.
 */
export function estimateCostMicros(
  _provider: string,
  _model: string | null,
  _usage: { readonly inputTokens: number | null; readonly outputTokens: number | null },
): bigint | null {
  return null;
}

/** First instant of `now`'s day in the workspace time zone. */
export function startOfWorkspaceDay(now: Date, zone: string): Date {
  return zonedLocalToUtc(`${zonedDateKey(now, zone)}T00:00`, zone) ?? now;
}

const nowOf = (runtime: AiRuntime) => (runtime.now ?? (() => new Date()))();

/**
 * Records a PENDING generation if today's cap allows it. The workspace row lock makes
 * concurrent reservations take turns, so the cap cannot be exceeded.
 */
async function reserveGeneration(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  data: {
    readonly operation: AiOperation;
    readonly provider: string;
    readonly language: AiLanguage;
    readonly contentItemId: string | null;
    readonly references: Readonly<Record<string, string>>;
    readonly now: Date;
  },
): Promise<string> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId}::uuid FOR UPDATE`;
    const zone = await workspaceTimeZone(tx, ctx);
    const used = await tx.aiGeneration.count({
      where: {
        workspaceId: ctx.workspaceId,
        createdAt: { gte: startOfWorkspaceDay(data.now, zone) },
      },
    });
    if (used >= DAILY_GENERATION_CAP) throw dailyCapReached();
    const row = await tx.aiGeneration.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        operation: data.operation,
        status: "PENDING",
        provider: data.provider,
        language: data.language,
        contentItemId: data.contentItemId,
        references: { ...data.references },
        createdAt: data.now,
      },
      select: { id: true },
    });
    return row.id;
  });
}

export interface GenerateSpec {
  readonly operation: AiOperation;
  readonly permission: Action;
  readonly requestedLanguage: AiLanguage | undefined;
  readonly uiLocale: AiLanguage;
  readonly focus: ContextFocus;
  readonly contentItemId: string | null;
  readonly params: PromptParams;
  /** More handle → id references the request shows (e.g. media assets M1…), server-side. */
  readonly extraReferences?: Readonly<Record<string, string>>;
}

/** The shared generation pipeline. Returns the id of a SUCCEEDED generation, or throws. */
export async function generate(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runtime: AiRuntime,
  spec: GenerateSpec,
): Promise<{ readonly generationId: string }> {
  assertCan(ctx, spec.permission);
  const provider = runtime.provider;
  if (provider === null) throw aiNotConfigured();

  const loaded = await loadContext(db, ctx, spec.focus);
  const context = {
    ...loaded,
    references: { ...loaded.references, ...(spec.extraReferences ?? {}) },
  };
  const language = resolveLanguage(
    spec.requestedLanguage,
    context.data.brand?.language,
    spec.uiLocale,
  );
  const request = {
    operation: spec.operation,
    language,
    system: buildSystemPrompt(language),
    user: buildUserPrompt(
      spec.operation,
      language,
      renderContext(context.data, language),
      spec.params,
    ),
    maxOutputTokens: MAX_OUTPUT_TOKENS[spec.operation],
  };

  const generationId = await reserveGeneration(db, ctx, {
    operation: spec.operation,
    provider: provider.name,
    language,
    contentItemId: spec.contentItemId,
    references: context.references,
    now: nowOf(runtime),
  });

  let outcome:
    | {
        ok: true;
        output: AnyAiOutput;
        model: string;
        usage: { inputTokens: number | null; outputTokens: number | null };
        latencyMs: number;
      }
    | { ok: false; failure: AiFailure; model: string | null; latencyMs: number | null };
  try {
    const run = await runProvider(provider, request, { timeoutMs: runtime.timeoutMs });
    try {
      const output = parseOutput(
        spec.operation,
        run.response.text,
        new Set(Object.keys(context.references)),
      );
      outcome = {
        ok: true,
        output,
        model: run.response.model,
        usage: run.response.usage,
        latencyMs: run.latencyMs,
      };
    } catch (error) {
      outcome = {
        ok: false,
        failure: isAiProviderError(error) ? error.kind : "invalid_output",
        model: run.response.model,
        latencyMs: run.latencyMs,
      };
    }
  } catch (error) {
    outcome = {
      ok: false,
      failure: isAiProviderError(error) ? error.kind : "unavailable",
      model: null,
      latencyMs: error instanceof AiRunError ? error.latencyMs : null,
    };
  }

  // Record the outcome and its audit entry together (never a success without output).
  await db.$transaction(async (tx) => {
    const where = { workspaceId: ctx.workspaceId, id: generationId, status: "PENDING" as const };
    if (outcome.ok) {
      await tx.aiGeneration.updateMany({
        where,
        data: {
          status: "SUCCEEDED",
          model: outcome.model,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          costMicros: estimateCostMicros(provider.name, outcome.model, outcome.usage),
          latencyMs: outcome.latencyMs,
          output: outcome.output as Prisma.InputJsonValue,
        },
      });
    } else {
      await tx.aiGeneration.updateMany({
        where,
        data: {
          status: "FAILED",
          model: outcome.model,
          latencyMs: outcome.latencyMs,
          errorCode: outcome.failure,
        },
      });
    }
    await recordAudit(tx, ctx, {
      action: outcome.ok ? "ai.generated" : "ai.failed",
      entityType: "ai_generation",
      entityId: generationId,
      metadata: {
        operation: spec.operation,
        provider: provider.name,
        model: outcome.model,
        status: outcome.ok ? "SUCCEEDED" : "FAILED",
        ...(outcome.ok
          ? { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens }
          : { errorCode: outcome.failure }),
        ...(spec.contentItemId === null ? {} : { contentId: spec.contentItemId }),
      },
    });
  });

  if (!outcome.ok) throw failureError(outcome.failure);
  return { generationId };
}

// ── Generation entry points ──────────────────────────────────────────────────

export async function generateIdeas(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runtime: AiRuntime,
  input: Omit<GenerateIdeasInput, "slug" | "uiLocale">,
  uiLocale: AiLanguage,
) {
  assertCan(ctx, "content.create");
  const pillarId = await resolveReference(db, ctx, "pillar", input.pillarId, "pillarId");
  const campaignId = await resolveReference(db, ctx, "campaign", input.campaignId, "campaignId");
  return generate(db, ctx, runtime, {
    operation: "IDEAS",
    permission: "content.create",
    requestedLanguage: input.language,
    uiLocale,
    focus: { pillarId, campaignId },
    contentItemId: null,
    params: { request: input.topic, count: input.count },
  });
}

export async function generateBrief(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runtime: AiRuntime,
  input: Omit<GenerateBriefInput, "slug" | "uiLocale">,
  uiLocale: AiLanguage,
) {
  assertCan(ctx, "content.create");
  const pillarId = await resolveReference(db, ctx, "pillar", input.pillarId, "pillarId");
  const campaignId = await resolveReference(db, ctx, "campaign", input.campaignId, "campaignId");
  return generate(db, ctx, runtime, {
    operation: "BRIEF",
    permission: "content.create",
    requestedLanguage: input.language,
    uiLocale,
    focus: { pillarId, campaignId },
    contentItemId: null,
    params: { request: input.topic, contentType: input.contentType },
  });
}

export async function generateCopy(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runtime: AiRuntime,
  input: Omit<GenerateCopyInput, "slug" | "uiLocale">,
  uiLocale: AiLanguage,
) {
  assertCan(ctx, "content.create");
  const campaignId = await resolveReference(db, ctx, "campaign", input.campaignId, "campaignId");
  return generate(db, ctx, runtime, {
    operation: "COPY",
    permission: "content.create",
    requestedLanguage: input.language,
    uiLocale,
    focus: { campaignId },
    contentItemId: null,
    params: {
      request: input.topic,
      contentType: input.contentType,
      variants: input.variants,
    },
  });
}

/** Assistance on an existing DRAFT (content.edit). */
export async function assistContent(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  runtime: AiRuntime,
  input: Omit<AssistContentInput, "slug" | "uiLocale">,
  uiLocale: AiLanguage,
) {
  assertCan(ctx, "content.edit");
  const item = await db.contentItem.findFirst({
    where: { workspaceId: ctx.workspaceId, id: input.contentId },
    select: {
      id: true,
      title: true,
      type: true,
      body: true,
      status: true,
      metadata: true,
      campaignId: true,
      pillarId: true,
    },
  });
  if (item === null) throw new AppError("NOT_FOUND", { metadata: { resource: "content" } });
  if (item.status !== "DRAFT") throw conflict("ai", "ai_draft_only", { status: item.status });
  const metadata = contentMetadata(item.metadata);
  return generate(db, ctx, runtime, {
    operation: input.operation,
    permission: "content.edit",
    requestedLanguage: input.language,
    uiLocale,
    focus: {
      campaignId: item.campaignId,
      pillarId: item.pillarId,
      content: {
        title: item.title,
        type: item.type,
        body: item.body,
        callToAction: metadata.callToAction,
        hashtags: metadata.hashtags,
      },
    },
    contentItemId: item.id,
    params: { request: input.instructions },
  });
}

// ── Using a suggestion ───────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored handle → id map, defensively re-shaped (the column is JSON). */
export function storedReferences(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [handle, id] of Object.entries(value)) {
    if (/^[PC][1-9]$/.test(handle) && typeof id === "string" && UUID_PATTERN.test(id)) {
      result[handle] = id;
    }
  }
  return result;
}

/** A handle → a usable record id in this workspace now, or null (missing/archived). */
export async function resolveHandle(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  kind: "pillar" | "campaign",
  handle: string | null | undefined,
  references: Readonly<Record<string, string>>,
): Promise<string | null> {
  if (handle === null || handle === undefined) return null;
  const id = references[handle];
  if (id === undefined) return null;
  try {
    return await resolveReference(tx, ctx, kind, id, kind);
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") return null;
    throw error;
  }
}

async function currentDraft(
  tx: GuardedTransactionClient,
  ctx: TenantContext,
  contentId: string,
): Promise<DraftFields> {
  const item = await tx.contentItem.findFirst({
    where: { workspaceId: ctx.workspaceId, id: contentId },
    select: {
      title: true,
      body: true,
      type: true,
      status: true,
      campaignId: true,
      pillarId: true,
      audienceId: true,
      goalId: true,
      scheduledAt: true,
      notes: true,
      metadata: true,
      assets: { orderBy: { position: "asc" }, select: { mediaAssetId: true } },
    },
  });
  if (item === null) throw conflict("ai", "ai_not_usable", { reason: "content_missing" });
  if (item.status !== "DRAFT") throw conflict("ai", "ai_draft_only", { status: item.status });
  const zone = await workspaceTimeZone(tx, ctx);
  const metadata = contentMetadata(item.metadata);
  return {
    title: item.title,
    body: item.body,
    type: item.type,
    campaignId: item.campaignId,
    pillarId: item.pillarId,
    audienceId: item.audienceId,
    goalId: item.goalId,
    plannedAt: item.scheduledAt === null ? null : utcToZonedLocal(item.scheduledAt, zone),
    notes: item.notes,
    hashtags: metadata.hashtags,
    callToAction: metadata.callToAction,
    link: metadata.link,
    assetIds: item.assets.map((asset) => asset.mediaAssetId),
  };
}

/**
 * Uses one stored suggestion, exactly once, in one transaction: the generation is
 * re-read and re-validated, claimed with a conditional update (a concurrent second use
 * finds it already claimed), applied through the content service, and audited. Only the
 * person who generated it may use it. Returns the content item that was created/changed.
 */
export async function applyGeneration(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly generationId: string; readonly choice: number },
  runtime: { readonly now?: () => Date } = {},
): Promise<{ readonly contentId: string; readonly created: boolean }> {
  const now = (runtime.now ?? (() => new Date()))();
  return db.$transaction(async (tx) => {
    const row = await tx.aiGeneration.findFirst({
      where: { workspaceId: ctx.workspaceId, id: input.generationId },
      select: {
        id: true,
        userId: true,
        operation: true,
        status: true,
        language: true,
        output: true,
        references: true,
        appliedAt: true,
        contentItemId: true,
      },
    });
    if (row?.userId !== ctx.userId) throw generationNotFound();
    // Advertising proposals are used by the advertising area, never as content.
    if (!isContentOperation(row.operation)) throw generationNotFound();
    const assist = isAssistOperation(row.operation);
    assertCan(ctx, assist ? "content.edit" : "content.create");
    if (row.status !== "SUCCEEDED") throw conflict("ai", "ai_not_usable", { status: row.status });
    if (row.appliedAt !== null) throw conflict("ai", "ai_already_used", {});
    const output = readStoredOutput(row.operation, row.output);
    if (output === null) throw conflict("ai", "ai_not_usable", { reason: "invalid_output" });
    if (input.choice >= choiceCount(row.operation, output)) {
      throw fieldError("choice", "invalid_value");
    }

    const claimed = await tx.aiGeneration.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        id: row.id,
        status: "SUCCEEDED",
        appliedAt: null,
      },
      data: { appliedAt: now },
    });
    if (claimed.count === 0) throw conflict("ai", "ai_already_used", {});

    const language = row.language;
    let contentId: string;
    let created: boolean;
    if (assist) {
      if (row.contentItemId === null) {
        throw conflict("ai", "ai_not_usable", { reason: "content_missing" });
      }
      const current = await currentDraft(tx, ctx, row.contentItemId);
      const fields = assistedFields(
        row.operation as Parameters<typeof assistedFields>[0],
        output,
        input.choice,
        current,
        language,
      );
      ({ contentId } = await updateContentIn(tx, ctx, row.contentItemId, fields));
      created = false;
    } else {
      const references = storedReferences(row.references);
      const record = output as {
        pillarRef?: string | null;
        campaignRef?: string | null;
        ideas?: { pillarRef: string | null; campaignRef: string | null }[];
      };
      const source = row.operation === "IDEAS" ? record.ideas?.[input.choice] : record;
      const refs = {
        pillarId: await resolveHandle(tx, ctx, "pillar", source?.pillarRef, references),
        campaignId: await resolveHandle(
          tx,
          ctx,
          "campaign",
          source?.campaignRef ?? (row.operation === "COPY" ? "C1" : null),
          references,
        ),
      };
      const fields = newContentFields(row.operation, output, input.choice, refs, language);
      ({ contentId } = await createContentIn(tx, ctx, fields));
      created = true;
    }

    await tx.aiGeneration.updateMany({
      where: { workspaceId: ctx.workspaceId, id: row.id },
      data: { appliedContentItemId: contentId },
    });
    await recordAudit(tx, ctx, {
      action: "ai.applied",
      entityType: "ai_generation",
      entityId: row.id,
      metadata: { operation: row.operation, choice: input.choice, contentId, created },
    });
    return { contentId, created };
  });
}

// ── Reading suggestions ──────────────────────────────────────────────────────

const historySelect = {
  id: true,
  operation: true,
  status: true,
  language: true,
  errorCode: true,
  appliedAt: true,
  appliedContentItemId: true,
  createdAt: true,
} as const;

export type GenerationSummary = Prisma.AiGenerationGetPayload<{ select: typeof historySelect }>;

/** The person's own recent generations: new-content ones, or those for one draft. */
export async function listMyGenerations(
  db: Db,
  ctx: TenantContext,
  scope: { readonly contentItemId: string } | { readonly newContent: true },
): Promise<GenerationSummary[]> {
  const assist = "contentItemId" in scope;
  assertCan(ctx, assist ? "content.edit" : "content.create");
  return db.aiGeneration.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      ...(assist
        ? { contentItemId: scope.contentItemId }
        : { operation: { in: [...NEW_CONTENT_OPERATIONS] } }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT,
    select: historySelect,
  });
}

export interface GenerationView {
  readonly id: string;
  readonly operation: AiOperation;
  readonly status: GenerationSummary["status"];
  readonly language: AiLanguage;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly appliedAt: Date | null;
  readonly appliedContentItemId: string | null;
  readonly contentItemId: string | null;
  /** Validated output (null unless SUCCEEDED and still valid). */
  readonly output: AnyAiOutput | null;
  readonly choices: number;
  /** Brand forbidden words found in the output (a warning for the reviewer). */
  readonly forbiddenWords: readonly string[];
  /** Names of the pillars/campaigns the suggestion cites, by handle (current names). */
  readonly referenceNames: Readonly<Record<string, string>>;
  readonly usable: boolean;
}

/** One of the person's own generations, re-validated for display. */
export async function getMyGeneration(
  db: Db,
  ctx: TenantContext,
  generationId: string,
): Promise<GenerationView> {
  const row = await db.aiGeneration.findFirst({
    where: { workspaceId: ctx.workspaceId, id: generationId },
    select: { ...historySelect, userId: true, output: true, references: true, contentItemId: true },
  });
  if (row?.userId !== ctx.userId) throw generationNotFound();
  if (!isContentOperation(row.operation)) throw generationNotFound();
  const assist = isAssistOperation(row.operation);
  assertCan(ctx, assist ? "content.edit" : "content.create");
  const output = row.status === "SUCCEEDED" ? readStoredOutput(row.operation, row.output) : null;
  const references = storedReferences(row.references);
  const pillarIds = Object.entries(references).filter(([h]) => h.startsWith("P"));
  const campaignIds = Object.entries(references).filter(([h]) => h.startsWith("C"));
  const [brand, pillars, campaigns] = await Promise.all([
    db.brand.findFirst({
      where: { workspaceId: ctx.workspaceId },
      select: { forbiddenWords: true },
    }),
    pillarIds.length === 0
      ? Promise.resolve([])
      : db.contentPillar.findMany({
          where: { workspaceId: ctx.workspaceId, id: { in: pillarIds.map(([, id]) => id) } },
          select: { id: true, name: true },
        }),
    campaignIds.length === 0
      ? Promise.resolve([])
      : db.campaign.findMany({
          where: { workspaceId: ctx.workspaceId, id: { in: campaignIds.map(([, id]) => id) } },
          select: { id: true, name: true },
        }),
  ]);
  const names = new Map([...pillars, ...campaigns].map((record) => [record.id, record.name]));
  const referenceNames: Record<string, string> = {};
  for (const [handle, id] of Object.entries(references)) {
    const name = names.get(id);
    if (name !== undefined) referenceNames[handle] = name;
  }
  return {
    id: row.id,
    operation: row.operation,
    status: row.status,
    language: row.language,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
    appliedContentItemId: row.appliedContentItemId,
    contentItemId: row.contentItemId,
    output,
    choices: output === null ? 0 : choiceCount(row.operation, output),
    forbiddenWords: output === null ? [] : forbiddenWordsIn(output, brand?.forbiddenWords ?? []),
    referenceNames,
    usable:
      output !== null &&
      row.appliedAt === null &&
      can(ctx.role, assist ? "content.edit" : "content.create"),
  };
}

// ── Usage summary (audit.view) ───────────────────────────────────────────────

export interface UsageSummary {
  readonly windowDays: number;
  readonly since: Date;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly pending: number;
  readonly applied: number;
  /** Token totals over rows that reported them; `unreported` rows had no figures. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly unreported: number;
  /** Null when no generation in the window had a calculable cost. */
  readonly costMicros: bigint | null;
  readonly byOperation: readonly { readonly operation: AiOperation; readonly count: number }[];
  readonly byProvider: readonly {
    readonly provider: string;
    readonly model: string | null;
    readonly count: number;
  }[];
  readonly today: number;
  readonly dailyCap: number;
}

export async function getUsageSummary(
  db: Db,
  ctx: TenantContext,
  now: Date = new Date(),
): Promise<UsageSummary> {
  assertCan(ctx, "audit.view");
  const workspaceId = ctx.workspaceId;
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const zone = await workspaceTimeZone(db, ctx);
  const window = { workspaceId, createdAt: { gte: since } };
  const [byStatus, byOperation, byProvider, applied, tokens, unreported, today] = await Promise.all(
    [
      db.aiGeneration.groupBy({ by: ["status"], where: window, _count: { _all: true } }),
      db.aiGeneration.groupBy({ by: ["operation"], where: window, _count: { _all: true } }),
      db.aiGeneration.groupBy({
        by: ["provider", "model"],
        where: window,
        _count: { _all: true },
      }),
      db.aiGeneration.count({ where: { ...window, appliedAt: { not: null } } }),
      db.aiGeneration.aggregate({
        where: window,
        _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      }),
      db.aiGeneration.count({
        where: { ...window, status: "SUCCEEDED", inputTokens: null, outputTokens: null },
      }),
      db.aiGeneration.count({
        where: { workspaceId, createdAt: { gte: startOfWorkspaceDay(now, zone) } },
      }),
    ],
  );
  const status = (value: string) =>
    byStatus.find((group) => group.status === value)?._count._all ?? 0;
  return {
    windowDays: USAGE_WINDOW_DAYS,
    since,
    attempts: byStatus.reduce((sum, group) => sum + group._count._all, 0),
    succeeded: status("SUCCEEDED"),
    failed: status("FAILED"),
    pending: status("PENDING"),
    applied,
    inputTokens: tokens._sum.inputTokens ?? 0,
    outputTokens: tokens._sum.outputTokens ?? 0,
    unreported,
    costMicros: tokens._sum.costMicros ?? null,
    byOperation: byOperation
      .map((group) => ({ operation: group.operation, count: group._count._all }))
      .sort((a, b) => b.count - a.count || a.operation.localeCompare(b.operation)),
    byProvider: byProvider
      .map((group) => ({ provider: group.provider, model: group.model, count: group._count._all }))
      .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider)),
    today,
    dailyCap: DAILY_GENERATION_CAP,
  };
}
