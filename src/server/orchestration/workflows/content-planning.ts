import "server-only";

import { z } from "zod";

import { recordAudit } from "../../audit/audit-log";
import { isAppError } from "../../errors/app-error";
import { newContentFields } from "../../ai/apply-fields";
import {
  generateIdeas,
  resolveHandle,
  storedReferences,
  type AiRuntime,
} from "../../ai/ai-service";
import { readStoredOutput } from "../../ai/operations";
import { createContentIn } from "../../marketing/content-service";
import { resolveTimeZone } from "../../marketing/time";
import { TaskError, type TaskContext, type WorkflowDefinition } from "../workflow";

// The AI Marketing Manager's content-planning cycle — the first workflow on the shared
// engine. Observe the workspace (deterministic queries) → plan ideas for the gaps (the
// AI engine, with its own daily cap and audit) → create drafts when the policy allows
// (never publishes, never schedules) → report. All four steps are INTERNAL: they read
// workspace data or write drafts inside Flexibx.

export interface PlanningServices {
  /** The AI provider (null when AI is not configured). */
  readonly ai: () => AiRuntime;
}

export const CONTENT_PLANNING_WORKFLOW = "content_planning";
const WINDOW_DAYS = 7;

const observeOutput = z.object({
  emptyDaysNext7: z.number().int(),
  plannedNext7Days: z.number().int(),
  language: z.enum(["ar", "en"]),
});
const ideasOutput = z.object({ generationId: z.string(), ideas: z.number().int() });
const draftsOutput = z.object({ contentIds: z.array(z.string()) });

function input<T>(schema: z.ZodType<T>, value: unknown, task: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TaskError(`missing_input:${task}`, false);
  return parsed.data;
}

const dayKey = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** 1. Observe: what exists, and which of the next 7 days have nothing planned. */
async function observe({ db, actor }: TaskContext<PlanningServices>) {
  const workspaceId = actor.workspaceId;
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  const now = rows[0]?.now ?? new Date();
  const until = new Date(now.getTime() + WINDOW_DAYS * 24 * 3_600_000);
  const [workspace, brand, goals, campaigns, pillars, drafts, upcoming] = await Promise.all([
    db.workspace.findFirst({
      where: { id: workspaceId },
      select: { timezone: true, defaultLocale: true },
    }),
    db.brand.findFirst({ where: { workspaceId }, select: { id: true } }),
    db.marketingGoal.count({ where: { workspaceId, status: "ACTIVE" } }),
    db.campaign.count({ where: { workspaceId, status: { in: ["PLANNED", "ACTIVE"] } } }),
    db.contentPillar.count({ where: { workspaceId, status: "ACTIVE" } }),
    db.contentItem.count({ where: { workspaceId, status: "DRAFT" } }),
    db.contentItem.findMany({
      where: { workspaceId, scheduledAt: { gte: now, lt: until } },
      select: { scheduledAt: true },
      take: 500,
    }),
  ]);
  const timeZone = resolveTimeZone(workspace?.timezone);
  const covered = new Set(
    upcoming.flatMap((item) =>
      item.scheduledAt === null ? [] : [dayKey(item.scheduledAt, timeZone)],
    ),
  );
  const window = Array.from({ length: WINDOW_DAYS }, (_, day) =>
    dayKey(new Date(now.getTime() + day * 24 * 3_600_000), timeZone),
  );
  return {
    status: "succeeded" as const,
    output: {
      hasBrand: brand !== null,
      activeGoals: goals,
      activeCampaigns: campaigns,
      activePillars: pillars,
      drafts,
      plannedNext7Days: upcoming.length,
      emptyDaysNext7: window.filter((day) => !covered.has(day)).length,
      language: workspace?.defaultLocale ?? "ar",
    },
  };
}

const RETRYABLE_AI = new Set(["ai_timeout", "ai_unavailable", "ai_provider_busy"]);

/** 2. Plan: ideas for the empty days, through the AI engine (its cap, audit and checks). */
async function planIdeas({ db, actor, inputs, services }: TaskContext<PlanningServices>) {
  const observed = input(observeOutput, inputs.observe, "observe");
  const count = Math.min(10, Math.max(3, observed.emptyDaysNext7));
  try {
    const { generationId } = await generateIdeas(
      db,
      actor,
      services.ai(),
      {
        topic: `Content for the next ${String(WINDOW_DAYS)} days: ${String(observed.emptyDaysNext7)} of them have nothing planned yet. Cover them with varied, on-brand ideas.`,
        count,
        language: undefined,
        pillarId: null,
        campaignId: null,
      },
      observed.language,
    );
    return { status: "succeeded" as const, output: { generationId, ideas: count } };
  } catch (error) {
    if (isAppError(error)) {
      const code = error.fields[0]?.code ?? error.code.toLowerCase();
      throw new TaskError(code, RETRYABLE_AI.has(code));
    }
    throw error;
  }
}

/** 3. Draft: turn the best ideas into content drafts — only if the policy allows it. */
async function createDrafts({ db, actor, policy, inputs, runId }: TaskContext<PlanningServices>) {
  if (!policy.allowDrafts) {
    return { status: "skipped" as const, output: { reason: "drafts_not_allowed", contentIds: [] } };
  }
  const planned = input(ideasOutput, inputs.plan_ideas, "plan_ideas");
  const contentIds = await db.$transaction(async (tx) => {
    const generation = await tx.aiGeneration.findFirst({
      where: { workspaceId: actor.workspaceId, id: planned.generationId, userId: actor.userId },
      select: { id: true, status: true, output: true, references: true, language: true },
    });
    if (generation?.status !== "SUCCEEDED") throw new TaskError("ideas_unusable", false);
    const output = readStoredOutput("IDEAS", generation.output);
    if (output === null) throw new TaskError("ideas_unusable", false);
    // Claimed once: a repeated attempt can never draft the same ideas twice.
    const claimed = await tx.aiGeneration.updateMany({
      where: { workspaceId: actor.workspaceId, id: generation.id, appliedAt: null },
      data: { appliedAt: new Date() },
    });
    if (claimed.count === 0) throw new TaskError("ideas_already_used", false);
    const references = storedReferences(generation.references);
    const ids: string[] = [];
    const take = Math.min(policy.maxDraftsPerRun, output.ideas.length);
    for (let choice = 0; choice < take; choice += 1) {
      const idea = output.ideas[choice];
      const refs = {
        pillarId: await resolveHandle(tx, actor, "pillar", idea?.pillarRef, references),
        campaignId: await resolveHandle(tx, actor, "campaign", idea?.campaignRef, references),
      };
      const fields = newContentFields("IDEAS", output, choice, refs, generation.language);
      ids.push((await createContentIn(tx, actor, fields)).contentId);
    }
    await tx.aiGeneration.updateMany({
      where: { workspaceId: actor.workspaceId, id: generation.id },
      data: { appliedContentItemId: ids[0] ?? null },
    });
    await recordAudit(tx, actor, {
      action: "automation.drafts_created",
      entityType: "agent_run",
      entityId: runId,
      metadata: { count: ids.length, contentIds: ids, generationId: generation.id },
    });
    return ids;
  });
  return { status: "succeeded" as const, output: { contentIds } };
}

/** 4. Report: what was observed, planned and drafted (counts and ids only). */
function report({ inputs }: TaskContext<PlanningServices>) {
  const observed = input(observeOutput, inputs.observe, "observe");
  const planned = input(ideasOutput, inputs.plan_ideas, "plan_ideas");
  const drafted = draftsOutput.safeParse(inputs.create_drafts);
  return Promise.resolve({
    status: "succeeded" as const,
    output: {
      ...(inputs.observe as Record<string, unknown>),
      emptyDaysNext7: observed.emptyDaysNext7,
      ideas: planned.ideas,
      generationId: planned.generationId,
      draftsCreated: drafted.success ? drafted.data.contentIds.length : 0,
      contentIds: drafted.success ? drafted.data.contentIds : [],
    },
  });
}

export const contentPlanningWorkflow: WorkflowDefinition<PlanningServices> = {
  id: CONTENT_PLANNING_WORKFLOW,
  summaryTask: "report",
  tasks: [
    {
      key: "observe",
      dependsOn: [],
      risk: "INTERNAL",
      maxAttempts: 3,
      timeoutMs: 30_000,
      run: observe,
    },
    {
      key: "plan_ideas",
      dependsOn: ["observe"],
      risk: "INTERNAL",
      maxAttempts: 2,
      timeoutMs: 120_000,
      run: planIdeas,
    },
    {
      key: "create_drafts",
      dependsOn: ["plan_ideas"],
      risk: "INTERNAL",
      maxAttempts: 2,
      timeoutMs: 30_000,
      run: createDrafts,
    },
    {
      key: "report",
      dependsOn: ["observe", "plan_ideas", "create_drafts"],
      risk: "INTERNAL",
      maxAttempts: 1,
      timeoutMs: 10_000,
      run: report,
    },
  ],
};
