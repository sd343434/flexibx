// Phase 4 — AI Marketing Engine on the real database with the fake provider: every
// operation, using a suggestion exactly once, DRAFT-only assistance, the role matrix,
// tenant isolation, invalid and foreign references, provider failures, the concurrent
// daily cap, audit metadata without prompts or generated text, and the usage summary.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import {
  applyGeneration,
  assistContent,
  DAILY_GENERATION_CAP,
  generateBrief,
  generateCopy,
  generateIdeas,
  getMyGeneration,
  getUsageSummary,
  listMyGenerations,
  type AiRuntime,
} from "@/server/ai/ai-service";
import { createFakeProvider, type FakeProviderOptions } from "@/server/ai/fake-provider";
import { AppError } from "@/server/errors/app-error";
import { saveBrand } from "@/server/marketing/brand-service";
import { createCampaign, changeCampaignStatus } from "@/server/marketing/campaign-service";
import { createContent, getContent, transitionContent } from "@/server/marketing/content-service";
import {
  brandFieldsSchema,
  campaignFieldsSchema,
  contentFieldsSchema,
  pillarFieldsSchema,
} from "@/server/marketing/inputs";
import { createPillar, updatePillar } from "@/server/marketing/pillar-service";
import type { TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const runtime = (options: FakeProviderOptions = {}, timeoutMs = 2000): AiRuntime => ({
  provider: createFakeProvider(options),
  timeoutMs,
});
const disabled: AiRuntime = { provider: null, timeoutMs: 2000 };

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw error;
  return error;
}
async function expectCode(promise: Promise<unknown>, code: string, field?: string) {
  const error = await rejection(promise);
  expect(error.code).toBe(code);
  if (field !== undefined) expect(error.fields.map((f) => f.code)).toContain(field);
}

async function memberOf(ctx: TenantContext, role: WorkspaceRole): Promise<TenantContext> {
  const user = await system.user.create({
    data: { email: `${role.toLowerCase()}-${crypto.randomUUID()}@test.flexibx.local`, name: role },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return { userId: user.id, workspaceId: ctx.workspaceId, role };
}

async function seed(ctx: TenantContext) {
  await saveBrand(
    db,
    ctx,
    brandFieldsSchema.parse({
      name: "Qahwa",
      language: "AR",
      keywords: "coffee",
      forbiddenWords: "cheap",
    }),
  );
  const { pillarId } = await createPillar(db, ctx, pillarFieldsSchema.parse({ name: "Education" }));
  const { campaignId } = await createCampaign(
    db,
    ctx,
    campaignFieldsSchema.parse({ name: "Winter launch" }),
  );
  return { pillarId, campaignId };
}

const draft = (ctx: TenantContext, overrides: Record<string, unknown> = {}) =>
  createContent(
    db,
    ctx,
    contentFieldsSchema.parse({ title: "Teaser", type: "POST", body: "Old body", ...overrides }),
  );

const ideasInput = (overrides: Record<string, unknown> = {}) => ({
  language: undefined,
  topic: "Winter drinks",
  count: 5,
  pillarId: null,
  campaignId: null,
  ...overrides,
});

// ── generation ───────────────────────────────────────────────────────────────

describe("generation with the fake provider", () => {
  it("generates ideas, a brief and copy, stored as validated suggestions", async () => {
    const ctx = await createTenant(system);
    const { pillarId, campaignId } = await seed(ctx);

    const ideas = await generateIdeas(
      db,
      ctx,
      runtime(),
      ideasInput({ pillarId, campaignId }),
      "en",
    );
    const brief = await generateBrief(
      db,
      ctx,
      runtime(),
      { language: "en", topic: "Cold brew", contentType: "REEL", pillarId: null, campaignId },
      "en",
    );
    const copy = await generateCopy(
      db,
      ctx,
      runtime(),
      {
        language: undefined,
        topic: "Friday offer",
        contentType: "POST",
        campaignId: null,
        variants: 2,
      },
      "en",
    );

    const rows = await system.aiGeneration.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((row) => [row.operation, row.status])).toEqual([
      ["IDEAS", "SUCCEEDED"],
      ["BRIEF", "SUCCEEDED"],
      ["COPY", "SUCCEEDED"],
    ]);
    for (const row of rows) {
      expect(row.userId).toBe(ctx.userId);
      expect(row.provider).toBe("fake");
      expect(row.inputTokens).toBeNull();
      expect(row.outputTokens).toBeNull();
      expect(row.costMicros).toBeNull();
      expect(row.latencyMs).not.toBeNull();
      expect(row.output).not.toBeNull();
    }
    // Brand language AR wins when no language is requested; an explicit one is kept.
    expect(rows.map((row) => row.language)).toEqual(["ar", "en", "ar"]);
    // Handles map to ids server-side only.
    expect(rows[0]?.references).toEqual({ P1: pillarId, C1: campaignId });

    const view = await getMyGeneration(db, ctx, ideas.generationId);
    expect(view.usable).toBe(true);
    expect(view.choices).toBeGreaterThanOrEqual(3);
    expect(view.referenceNames).toEqual({ P1: "Education", C1: "Winter launch" });
    expect((await getMyGeneration(db, ctx, brief.generationId)).operation).toBe("BRIEF");
    expect((await getMyGeneration(db, ctx, copy.generationId)).choices).toBe(3);
  });

  it("fails clearly when AI is not configured, without recording anything", async () => {
    const ctx = await createTenant(system);
    await expectCode(
      generateIdeas(db, ctx, disabled, ideasInput(), "ar"),
      "SERVICE_UNAVAILABLE",
      "ai_not_configured",
    );
    expect(await system.aiGeneration.count()).toBe(0);
  });

  it.each([
    ["malformed", "SERVICE_UNAVAILABLE", "ai_invalid_output", "invalid_output"],
    ["empty", "SERVICE_UNAVAILABLE", "ai_invalid_output", "invalid_output"],
    ["oversized", "SERVICE_UNAVAILABLE", "ai_invalid_output", "invalid_output"],
    ["schema_mismatch", "SERVICE_UNAVAILABLE", "ai_invalid_output", "invalid_output"],
    ["refused", "SERVICE_UNAVAILABLE", "ai_refused", "refused"],
    ["rate_limited", "RATE_LIMITED", "ai_provider_busy", "rate_limited"],
    ["unavailable", "SERVICE_UNAVAILABLE", "ai_unavailable", "unavailable"],
  ] as const)(
    "records a %s provider result as a failed attempt",
    async (scenario, code, field, stored) => {
      const ctx = await createTenant(system);
      await expectCode(
        generateIdeas(db, ctx, runtime({ scenario }), ideasInput(), "ar"),
        code,
        field,
      );
      const row = await system.aiGeneration.findFirstOrThrow({
        where: { workspaceId: ctx.workspaceId },
      });
      expect(row.status).toBe("FAILED");
      expect(row.errorCode).toBe(stored);
      expect(row.output).toBeNull();
      const audit = await system.auditLog.findFirstOrThrow({
        where: { workspaceId: ctx.workspaceId, action: "ai.failed" },
      });
      expect(audit.entityId).toBe(row.id);
    },
  );

  it("times out, retries once, then fails", async () => {
    const ctx = await createTenant(system);
    const provider = createFakeProvider({ scenario: "timeout" });
    await expectCode(
      generateIdeas(db, ctx, { provider, timeoutMs: 50 }, ideasInput(), "ar"),
      "SERVICE_UNAVAILABLE",
      "ai_timeout",
    );
    expect(provider.calls).toBe(2);
    const row = await system.aiGeneration.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(row.errorCode).toBe("timeout");
  });

  it("succeeds after one transient failure", async () => {
    const ctx = await createTenant(system);
    const provider = createFakeProvider({ scenario: "unavailable", failTimes: 1 });
    await generateIdeas(db, ctx, { provider, timeoutMs: 2000 }, ideasInput(), "ar");
    expect(provider.calls).toBe(2);
    expect((await system.aiGeneration.findFirstOrThrow()).status).toBe("SUCCEEDED");
  });

  it("drops reference handles the model was not shown", async () => {
    const ctx = await createTenant(system);
    await seed(ctx);
    const { generationId } = await generateIdeas(
      db,
      ctx,
      runtime({ scenario: "unknown_references" }),
      ideasInput(),
      "en",
    );
    const view = await getMyGeneration(db, ctx, generationId);
    const ideas = (
      view.output as { ideas: { pillarRef: string | null; campaignRef: string | null }[] }
    ).ideas;
    expect(ideas.every((idea) => idea.pillarRef === null && idea.campaignRef === null)).toBe(true);
  });

  it("rejects a pillar or campaign from another workspace", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const { pillarId, campaignId } = await seed(other);
    await expectCode(
      generateIdeas(db, ctx, runtime(), ideasInput({ pillarId }), "ar"),
      "VALIDATION_FAILED",
      "reference_not_found",
    );
    await expectCode(
      generateIdeas(db, ctx, runtime(), ideasInput({ campaignId }), "ar"),
      "VALIDATION_FAILED",
      "reference_not_found",
    );
    expect(await system.aiGeneration.count()).toBe(0);
  });
});

// ── permissions and isolation ────────────────────────────────────────────────

describe("roles and tenant isolation", () => {
  it("lets EDITOR and above generate; VIEWER and CLIENT cannot", async () => {
    const owner = await createTenant(system);
    for (const role of [WorkspaceRole.EDITOR, WorkspaceRole.MANAGER, WorkspaceRole.ADMIN]) {
      const ctx = await memberOf(owner, role);
      await generateIdeas(db, ctx, runtime(), ideasInput(), "ar");
    }
    for (const role of [WorkspaceRole.VIEWER, WorkspaceRole.CLIENT]) {
      const ctx = await memberOf(owner, role);
      await expectCode(generateIdeas(db, ctx, runtime(), ideasInput(), "ar"), "FORBIDDEN");
      await expectCode(generateIdeas(db, ctx, disabled, ideasInput(), "ar"), "FORBIDDEN");
    }
    expect(await system.aiGeneration.count()).toBe(3);
  });

  it("keeps suggestions private to their author and workspace", async () => {
    const ctx = await createTenant(system);
    const colleague = await memberOf(ctx, WorkspaceRole.ADMIN);
    const stranger = await createTenant(system);
    const { generationId } = await generateIdeas(db, ctx, runtime(), ideasInput(), "ar");

    await expectCode(getMyGeneration(db, colleague, generationId), "NOT_FOUND");
    await expectCode(getMyGeneration(db, stranger, generationId), "NOT_FOUND");
    await expectCode(applyGeneration(db, colleague, { generationId, choice: 0 }), "NOT_FOUND");
    await expectCode(applyGeneration(db, stranger, { generationId, choice: 0 }), "NOT_FOUND");
    expect(await listMyGenerations(db, colleague, { newContent: true })).toHaveLength(0);
    expect(await listMyGenerations(db, ctx, { newContent: true })).toHaveLength(1);
    expect((await system.aiGeneration.findFirstOrThrow()).appliedAt).toBeNull();
  });

  it("cannot assist a draft from another workspace", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const { contentId } = await draft(other);
    await expectCode(
      assistContent(
        db,
        ctx,
        runtime(),
        { contentId, operation: "CONTENT_REWRITE", language: undefined, instructions: null },
        "ar",
      ),
      "NOT_FOUND",
    );
    expect(await system.aiGeneration.count()).toBe(0);
  });

  it("the database refuses a generation pointing at another workspace's content", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const { contentId } = await draft(other);
    await expect(
      system.aiGeneration.create({
        data: {
          workspaceId: ctx.workspaceId,
          operation: "CONTENT_HOOK",
          provider: "fake",
          language: "ar",
          contentItemId: contentId,
        },
      }),
    ).rejects.toThrow();
  });
});

// ── using a suggestion ───────────────────────────────────────────────────────

describe("using a suggestion", () => {
  it("creates a DRAFT from an idea, with resolved references, exactly once", async () => {
    const ctx = await createTenant(system);
    const { pillarId, campaignId } = await seed(ctx);
    const { generationId } = await generateIdeas(
      db,
      ctx,
      runtime(),
      ideasInput({ pillarId, campaignId }),
      "en",
    );

    const results = await Promise.allSettled([
      applyGeneration(db, ctx, { generationId, choice: 0 }),
      applyGeneration(db, ctx, { generationId, choice: 1 }),
    ]);
    const done = results.filter((result) => result.status === "fulfilled");
    expect(done).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect((failed?.reason as AppError).code).toBe("CONFLICT");

    const contents = await system.contentItem.findMany({ where: { workspaceId: ctx.workspaceId } });
    expect(contents).toHaveLength(1);
    const content = contents[0];
    expect(content?.status).toBe("DRAFT");
    expect(content?.createdByUserId).toBe(ctx.userId);

    const row = await system.aiGeneration.findFirstOrThrow({ where: { id: generationId } });
    expect(row.appliedAt).not.toBeNull();
    expect(row.appliedContentItemId).toBe(content?.id);
    await expectCode(
      applyGeneration(db, ctx, { generationId, choice: 0 }),
      "CONFLICT",
      "ai_already_used",
    );
    expect(
      await system.auditLog.count({
        where: { workspaceId: ctx.workspaceId, action: "ai.applied" },
      }),
    ).toBe(1);
  });

  it("drops a reference that was archived after generation", async () => {
    const ctx = await createTenant(system);
    const { pillarId } = await seed(ctx);
    const { generationId } = await generateBrief(
      db,
      ctx,
      runtime(),
      { language: "ar", topic: "Beans", contentType: null, pillarId, campaignId: null },
      "ar",
    );
    await updatePillar(
      db,
      ctx,
      pillarId,
      pillarFieldsSchema.parse({ name: "Education", archived: true }),
    );
    const { contentId } = await applyGeneration(db, ctx, { generationId, choice: 0 });
    const content = await getContent(db, ctx, contentId);
    expect(content.pillarId).toBeNull();
    expect(content.notes).toContain("موجز");
  });

  it("uses a copy variant with its caption, hook and call to action", async () => {
    const ctx = await createTenant(system);
    const { campaignId } = await seed(ctx);
    const { generationId } = await generateCopy(
      db,
      ctx,
      runtime(),
      { language: "en", topic: "Offer", contentType: "STORY", campaignId, variants: 2 },
      "en",
    );
    await expectCode(applyGeneration(db, ctx, { generationId, choice: 3 }), "VALIDATION_FAILED");
    const { contentId } = await applyGeneration(db, ctx, { generationId, choice: 2 });
    const content = await getContent(db, ctx, contentId);
    expect(content.type).toBe("STORY");
    expect(content.campaignId).toBe(campaignId);
    expect(content.body).toContain("(2)");
    expect(content.metadata).toMatchObject({ callToAction: "Learn more" });
  });

  it("assists only drafts, and applies to the draft it was generated for", async () => {
    const ctx = await createTenant(system);
    const { contentId } = await draft(ctx, { callToAction: "Old CTA" });
    const { generationId } = await assistContent(
      db,
      ctx,
      runtime(),
      { contentId, operation: "CONTENT_CTA", language: "en", instructions: "Short" },
      "en",
    );
    const { contentId: changed, created } = await applyGeneration(db, ctx, {
      generationId,
      choice: 1,
    });
    expect(changed).toBe(contentId);
    expect(created).toBe(false);
    const content = await getContent(db, ctx, contentId);
    expect(content.metadata).toMatchObject({ callToAction: "Learn more 2" });
    expect(content.status).toBe("DRAFT");

    // A suggestion made while it was a draft cannot change it after submission.
    const hook = await assistContent(
      db,
      ctx,
      runtime(),
      { contentId, operation: "CONTENT_HOOK", language: "en", instructions: null },
      "en",
    );
    await transitionContent(db, ctx, { contentId, transition: "submit", scheduledAt: null });
    await expectCode(
      applyGeneration(db, ctx, { generationId: hook.generationId, choice: 0 }),
      "CONFLICT",
      "ai_draft_only",
    );
    expect(
      (await system.aiGeneration.findUniqueOrThrow({ where: { id: hook.generationId } })).appliedAt,
    ).toBeNull();
    await expectCode(
      assistContent(
        db,
        ctx,
        runtime(),
        { contentId, operation: "CONTENT_REWRITE", language: "en", instructions: null },
        "en",
      ),
      "CONFLICT",
      "ai_draft_only",
    );
  });

  it("never changes a workflow status or a campaign", async () => {
    const ctx = await createTenant(system);
    const { campaignId } = await seed(ctx);
    await changeCampaignStatus(db, ctx, campaignId, "PLANNED");
    const { contentId } = await draft(ctx, { campaignId });
    for (const operation of [
      "CONTENT_DRAFT",
      "CONTENT_REWRITE",
      "CONTENT_ALTERNATIVES",
      "CONTENT_BRIEF",
    ] as const) {
      const { generationId } = await assistContent(
        db,
        ctx,
        runtime(),
        { contentId, operation, language: "ar", instructions: null },
        "ar",
      );
      await applyGeneration(db, ctx, { generationId, choice: 0 });
    }
    const content = await getContent(db, ctx, contentId);
    expect(content.status).toBe("DRAFT");
    expect(content.scheduledAt).toBeNull();
    expect((await system.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(
      "PLANNED",
    );
  });

  it("requires content.edit to use assistance and content.create to use new content", async () => {
    const owner = await createTenant(system);
    const viewer = await memberOf(owner, WorkspaceRole.VIEWER);
    // A VIEWER's own suggestion cannot exist; simulate a demoted author instead.
    const editor = await memberOf(owner, WorkspaceRole.EDITOR);
    const { generationId } = await generateIdeas(db, editor, runtime(), ideasInput(), "ar");
    const demoted = { ...editor, role: WorkspaceRole.VIEWER };
    await expectCode(applyGeneration(db, demoted, { generationId, choice: 0 }), "FORBIDDEN");
    await expectCode(applyGeneration(db, viewer, { generationId, choice: 0 }), "NOT_FOUND");
    expect(await system.contentItem.count()).toBe(0);
  });

  it("refuses a failed generation", async () => {
    const ctx = await createTenant(system);
    await rejection(generateIdeas(db, ctx, runtime({ scenario: "malformed" }), ideasInput(), "ar"));
    const row = await system.aiGeneration.findFirstOrThrow();
    await expectCode(
      applyGeneration(db, ctx, { generationId: row.id, choice: 0 }),
      "CONFLICT",
      "ai_not_usable",
    );
  });

  it("refuses stored output that no longer matches its schema", async () => {
    const ctx = await createTenant(system);
    const { generationId } = await generateIdeas(db, ctx, runtime(), ideasInput(), "ar");
    await system.aiGeneration.update({
      where: { id: generationId },
      data: { output: { ideas: [{ title: "x", injected: "<script>" }] } },
    });
    await expectCode(
      applyGeneration(db, ctx, { generationId, choice: 0 }),
      "CONFLICT",
      "ai_not_usable",
    );
    expect((await getMyGeneration(db, ctx, generationId)).usable).toBe(false);
  });
});

// ── daily cap, audit and usage ───────────────────────────────────────────────

describe("daily cap, audit and usage", () => {
  it("never exceeds the daily cap under concurrent requests", async () => {
    const ctx = await createTenant(system);
    const now = new Date();
    await system.aiGeneration.createMany({
      data: Array.from({ length: DAILY_GENERATION_CAP - 3 }, () => ({
        workspaceId: ctx.workspaceId,
        operation: "IDEAS" as const,
        status: "FAILED" as const,
        errorCode: "timeout",
        provider: "fake",
        language: "ar" as const,
        createdAt: now,
      })),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        generateIdeas(db, ctx, { ...runtime(), now: () => now }, ideasInput(), "ar"),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      const error = result.reason as AppError;
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.fields[0]?.code).toBe("ai_daily_cap");
    }
    expect(await system.aiGeneration.count({ where: { workspaceId: ctx.workspaceId } })).toBe(
      DAILY_GENERATION_CAP,
    );
    // Another workspace is unaffected.
    const other = await createTenant(system);
    await generateIdeas(db, other, runtime(), ideasInput(), "ar");
  });

  it("counts failed attempts and resets with the workspace's day", async () => {
    const ctx = await createTenant(system);
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await system.aiGeneration.createMany({
      data: Array.from({ length: DAILY_GENERATION_CAP }, () => ({
        workspaceId: ctx.workspaceId,
        operation: "COPY" as const,
        status: "FAILED" as const,
        errorCode: "refused",
        provider: "fake",
        language: "en" as const,
        createdAt: yesterday,
      })),
    });
    await generateIdeas(db, ctx, runtime(), ideasInput(), "ar");
  });

  it("audits generations and uses without prompts or generated text", async () => {
    const ctx = await createTenant(system);
    await seed(ctx);
    const topic = "SECRET-TOPIC-MARKER";
    const { generationId } = await generateIdeas(db, ctx, runtime(), ideasInput({ topic }), "en");
    await applyGeneration(db, ctx, { generationId, choice: 0 });
    const view = await getMyGeneration(db, ctx, generationId);
    const firstTitle = (view.output as { ideas: { title: string }[] }).ideas[0]?.title ?? "";
    const rows = await system.auditLog.findMany({
      where: { workspaceId: ctx.workspaceId, action: { startsWith: "ai." } },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((row) => row.action)).toEqual(["ai.generated", "ai.applied"]);
    expect(rows[0]?.metadata).toMatchObject({
      operation: "IDEAS",
      provider: "fake",
      status: "SUCCEEDED",
      inputTokens: null,
      outputTokens: null,
    });
    const serialized = JSON.stringify(rows.map((row) => row.metadata));
    expect(serialized).not.toContain(topic);
    expect(serialized).not.toContain(firstTitle);
    expect(serialized).not.toContain("Qahwa");
  });

  it("shows usage to audit.view only, scoped to the workspace", async () => {
    const ctx = await createTenant(system);
    const other = await createTenant(system);
    const { generationId } = await generateIdeas(db, ctx, runtime(), ideasInput(), "ar");
    await rejection(generateIdeas(db, ctx, runtime({ scenario: "refused" }), ideasInput(), "ar"));
    await applyGeneration(db, ctx, { generationId, choice: 0 });
    await generateIdeas(db, other, runtime(), ideasInput(), "ar");

    const usage = await getUsageSummary(db, ctx);
    expect(usage).toMatchObject({
      attempts: 2,
      succeeded: 1,
      failed: 1,
      applied: 1,
      inputTokens: 0,
      outputTokens: 0,
      unreported: 1,
      costMicros: null,
      today: 2,
      dailyCap: DAILY_GENERATION_CAP,
    });
    expect(usage.byOperation).toEqual([{ operation: "IDEAS", count: 2 }]);

    for (const role of [
      WorkspaceRole.MANAGER,
      WorkspaceRole.EDITOR,
      WorkspaceRole.VIEWER,
      WorkspaceRole.CLIENT,
    ]) {
      await expectCode(getUsageSummary(db, await memberOf(ctx, role)), "FORBIDDEN");
    }
    expect((await getUsageSummary(db, await memberOf(ctx, WorkspaceRole.ADMIN))).attempts).toBe(2);
  });
});
