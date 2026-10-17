// Pass 4 — campaign content plans on the real database, with the fake AI provider only:
// campaign → brief → AI-proposed items (dates and channels assigned by the server) →
// edits → approval → content drafts (each item once) → review → progress and next
// steps from recorded facts. Roles, tenant isolation (services and database triggers),
// stale versions, concurrent conversion, AI failures and locked states.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceRole } from "@/generated/prisma/enums";
import type { AiRuntime } from "@/server/ai/ai-service";
import { createFakeProvider, type FakeProviderOptions } from "@/server/ai/fake-provider";
import { AppError } from "@/server/errors/app-error";
import { createAudience } from "@/server/marketing/audience-service";
import { changeCampaignStatus, createCampaign } from "@/server/marketing/campaign-service";
import { planBriefFieldsSchema, planItemFieldsSchema } from "@/server/marketing/campaign-plan";
import { campaignProgress } from "@/server/marketing/campaign-progress";
import { deleteContent, transitionContent } from "@/server/marketing/content-service";
import { createGoal } from "@/server/marketing/goal-service";
import {
  audienceFieldsSchema,
  campaignFieldsSchema,
  goalFieldsSchema,
} from "@/server/marketing/inputs";
import {
  addPlanItem,
  approvePlan,
  campaignProgressFacts,
  createDraftsFromPlan,
  generatePlanItems,
  getCampaignPlan,
  removePlanItem,
  reopenPlan,
  savePlanBrief,
  updatePlanItem,
} from "@/server/marketing/plan-service";
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

const runtime = (options: FakeProviderOptions = {}): AiRuntime => ({
  provider: createFakeProvider(options),
  timeoutMs: 2000,
});
const TODAY = new Date("2030-03-01T09:00:00Z");

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

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

async function campaignWithLinks(ctx: TenantContext) {
  const { goalId } = await createGoal(
    db,
    ctx,
    goalFieldsSchema.parse({ type: "SALES", title: "Spring orders", status: "ACTIVE" }),
  );
  const { audienceId } = await createAudience(
    db,
    ctx,
    audienceFieldsSchema.parse({ name: "Office workers" }),
  );
  const { campaignId } = await createCampaign(
    db,
    ctx,
    campaignFieldsSchema.parse({
      name: "Spring launch",
      objective: "Introduce the spring menu",
      startDate: "2030-03-05",
      endDate: "2030-03-19",
      audienceId,
      goalIds: [goalId],
    }),
  );
  return { campaignId, goalId, audienceId };
}

const brief = (overrides: Record<string, unknown> = {}) =>
  planBriefFieldsSchema.parse({
    offer: "Two drinks for the price of one before 10am",
    channels: ["FACEBOOK_PAGE", "INSTAGRAM"],
    budgetNotes: "No paid promotion; organic posts only",
    ...overrides,
  });
const item = (overrides: Record<string, unknown> = {}) =>
  planItemFieldsSchema.parse({
    title: "Behind the counter",
    brief: "Show the barista preparing the new drink",
    contentType: "REEL",
    channel: "INSTAGRAM",
    plannedDate: "2030-03-10",
    included: "on",
    ...overrides,
  });

async function planVersion(ctx: TenantContext, campaignId: string) {
  return (await getCampaignPlan(db, ctx, campaignId))?.version ?? 0;
}

async function progressOf(ctx: TenantContext, campaignId: string, blockers: string[] = []) {
  const facts = await campaignProgressFacts(db, ctx, campaignId);
  return campaignProgress({ ...facts, publishingBlockers: blockers, now: TODAY });
}

// ── the journey ──────────────────────────────────────────────────────────────

describe("campaign plan journey", () => {
  it("goes from a brief to AI-proposed items, approval, drafts, review and progress", async () => {
    const owner = await createTenant(system);
    const { campaignId, goalId, audienceId } = await campaignWithLinks(owner);

    // No plan yet: the next step is to write one.
    expect(await getCampaignPlan(db, owner, campaignId)).toBeNull();
    expect((await progressOf(owner, campaignId)).steps.map((s) => s.action)).toEqual([
      "write_plan",
    ]);

    await savePlanBrief(db, owner, campaignId, 0, brief());
    const generated = await generatePlanItems(db, owner, runtime(), campaignId, 1, {
      count: 4,
      uiLocale: "en",
      today: TODAY,
    });
    expect(generated.items).toBe(4);

    let plan = await getCampaignPlan(db, owner, campaignId);
    expect(plan?.status).toBe("DRAFT");
    expect(plan?.generationId).toBe(generated.generationId);
    expect(plan?.generation?.provider).toBe("fake");
    expect(plan?.items).toHaveLength(4);
    // Channels follow the person's order; dates are spread over the campaign window.
    expect(plan?.items.map((i) => i.channel)).toEqual([
      "FACEBOOK_PAGE",
      "INSTAGRAM",
      "FACEBOOK_PAGE",
      "INSTAGRAM",
    ]);
    expect(plan?.items.map((i) => i.plannedDate?.toISOString().slice(0, 10))).toEqual([
      "2030-03-05",
      "2030-03-10",
      "2030-03-14",
      "2030-03-19",
    ]);
    expect(plan?.items.every((i) => i.aiGenerated && i.included && i.brief.length > 0)).toBe(true);
    // The suggestion is used once: it cannot also become content in AI Studio.
    const generation = await system.aiGeneration.findUniqueOrThrow({
      where: { id: generated.generationId },
    });
    expect(generation.appliedAt).not.toBeNull();

    // A person edits, adds and removes items before approving.
    const [first, second, third] = must(plan).items;
    await updatePlanItem(
      db,
      owner,
      campaignId,
      must(first).id,
      must(plan).version,
      item({
        title: "Morning offer",
        channel: "FACEBOOK_PAGE",
        contentType: "POST",
      }),
    );
    await addPlanItem(db, owner, campaignId, await planVersion(owner, campaignId), item());
    await removePlanItem(
      db,
      owner,
      campaignId,
      must(third).id,
      await planVersion(owner, campaignId),
    );
    await updatePlanItem(
      db,
      owner,
      campaignId,
      must(second).id,
      await planVersion(owner, campaignId),
      item({ title: must(second).title, included: "" }),
    );
    plan = await getCampaignPlan(db, owner, campaignId);
    expect(plan?.items.map((i) => [i.title, i.included, i.aiGenerated])).toEqual([
      ["Morning offer", true, true],
      [must(second).title, false, true],
      [must(must(plan).items[2]).title, true, true],
      ["Behind the counter", true, false],
    ]);
    expect((await progressOf(owner, campaignId)).steps.map((s) => s.action)).toContain(
      "approve_plan",
    );

    await approvePlan(db, owner, campaignId, must(plan).version);
    plan = await getCampaignPlan(db, owner, campaignId);
    expect(plan?.status).toBe("APPROVED");
    expect(plan?.approvedAt).not.toBeNull();
    expect((await progressOf(owner, campaignId)).steps).toContainEqual({
      action: "create_drafts",
      count: 3,
    });

    // Drafts: one per included item, linked to the campaign, its audience and goal.
    expect(await createDraftsFromPlan(db, owner, campaignId, must(plan).version)).toEqual({
      created: 3,
    });
    const drafts = await system.contentItem.findMany({
      where: { workspaceId: owner.workspaceId, campaignId },
      orderBy: { createdAt: "asc" },
    });
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.status === "DRAFT")).toBe(true);
    expect(drafts.every((d) => d.audienceId === audienceId && d.goalId === goalId)).toBe(true);
    expect(drafts[0]?.title).toBe("Morning offer");
    expect(drafts[0]?.notes).toBe("Show the barista preparing the new drink");
    expect(drafts[0]?.scheduledAt).not.toBeNull();
    const linked = await system.campaignPlanItem.findMany({
      where: { contentItemId: { not: null } },
    });
    expect(linked).toHaveLength(3);
    expect(linked.every((row) => row.included)).toBe(true);

    // Repeating creates nothing new.
    expect(
      await createDraftsFromPlan(db, owner, campaignId, await planVersion(owner, campaignId)),
    ).toEqual({ created: 0 });
    expect(await system.contentItem.count({ where: { campaignId } })).toBe(3);

    // The regular content workflow takes over: review, change request, approval.
    const [morning, counter] = [must(drafts[0]).id, must(drafts[2]).id];
    const editor = await memberOf(owner, "EDITOR");
    await transitionContent(db, editor, {
      contentId: morning,
      transition: "submit",
      scheduledAt: null,
    });
    await transitionContent(db, editor, {
      contentId: counter,
      transition: "submit",
      scheduledAt: null,
    });
    await transitionContent(db, owner, {
      contentId: counter,
      transition: "request_changes",
      scheduledAt: null,
      reason: "Use the new cup",
    });
    await transitionContent(db, owner, {
      contentId: morning,
      transition: "approve",
      scheduledAt: null,
    });

    const progress = await progressOf(owner, campaignId);
    const stageOf = (id: string) => progress.rows.find((r) => r.contentId === id)?.stage;
    expect(stageOf(morning)).toBe("approved");
    expect(stageOf(counter)).toBe("changes_requested");
    expect(progress.total).toBe(3);
    expect(progress.published).toBe(0);
    expect(progress.steps).toEqual([
      { action: "revise_changes", count: 1 },
      { action: "queue_approved", count: 1 },
    ]);
    // With publishing held, the approved Facebook post is reported as blocked.
    expect((await progressOf(owner, campaignId, ["not_connected"])).steps[0]).toEqual({
      action: "unblock_publishing",
      count: 1,
    });

    // Every decision is audited.
    const actions = (
      await system.auditLog.findMany({
        where: { workspaceId: owner.workspaceId, action: { startsWith: "campaign.plan" } },
        select: { action: true },
      })
    ).map((row) => row.action);
    expect(new Set(actions)).toEqual(
      new Set([
        "campaign.plan_updated",
        "campaign.plan_generated",
        "campaign.plan_approved",
        "campaign.plan_drafts_created",
      ]),
    );
  });

  it("works without AI: hand-written items, and reports Facebook outcomes as recorded", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief({ channels: ["FACEBOOK_PAGE"] }));
    for (const title of ["One", "Two", "Three"]) {
      await addPlanItem(
        db,
        owner,
        campaignId,
        await planVersion(owner, campaignId),
        item({ title, channel: "FACEBOOK_PAGE", contentType: "POST" }),
      );
    }
    await approvePlan(db, owner, campaignId, await planVersion(owner, campaignId));
    await createDraftsFromPlan(db, owner, campaignId, await planVersion(owner, campaignId));
    const contents = await system.contentItem.findMany({
      where: { campaignId },
      orderBy: { title: "asc" },
    });
    const channel = await system.socialChannel.create({
      data: {
        workspaceId: owner.workspaceId,
        platform: "FACEBOOK",
        externalId: "777000",
        pageId: "777000",
        name: "Test Page",
      },
    });
    const [one, three, two] = contents;
    for (const content of contents) {
      await system.contentItem.update({ where: { id: content.id }, data: { status: "APPROVED" } });
    }
    // Recorded outcomes: confirmed, unknown, failed for certain.
    await system.contentItem.update({
      where: { id: must(one).id },
      data: { status: "PUBLISHED", publishedAt: TODAY },
    });
    const post = (contentItemId: string, status: string, extra: Record<string, unknown> = {}) =>
      system.socialPost.create({
        data: {
          workspaceId: owner.workspaceId,
          contentItemId,
          channelId: channel.id,
          status,
          scheduledAt: TODAY,
          message: "text",
          ...extra,
        },
      });
    await post(must(one).id, "PUBLISHED", { externalPostId: "777000_1029", publishedAt: TODAY });
    await post(must(two).id, "UNCERTAIN");
    await post(must(three).id, "FAILED", { errorCode: "token_expired" });

    const progress = await progressOf(owner, campaignId);
    const rowOf = (id: string) => progress.rows.find((r) => r.contentId === id);
    expect(rowOf(must(one).id)).toMatchObject({
      stage: "published",
      externalPostId: "777000_1029",
    });
    expect(rowOf(must(two).id)).toMatchObject({ stage: "uncertain" });
    expect(rowOf(must(three).id)).toMatchObject({ stage: "failed", errorCode: "token_expired" });
    expect(progress.published).toBe(1);
    // Uncertain first: someone must look at the Page; never retried automatically.
    expect(progress.steps.slice(0, 2)).toEqual([
      { action: "check_uncertain", count: 1 },
      { action: "fix_failed", count: 1 },
    ]);
  });
});

// ── states, versions and failures ────────────────────────────────────────────

describe("plan states and versions", () => {
  it("refuses stale versions, edits of an approved plan and an empty approval", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief());
    // A second "start" with version 0 is stale now.
    await expectCode(savePlanBrief(db, owner, campaignId, 0, brief()), "CONFLICT", "plan_changed");
    await expectCode(approvePlan(db, owner, campaignId, 1), "CONFLICT", "plan_empty");
    // The refused approval changed nothing (still version 1, still DRAFT).
    expect(await getCampaignPlan(db, owner, campaignId)).toMatchObject({
      status: "DRAFT",
      version: 1,
    });
    await addPlanItem(db, owner, campaignId, 1, item());
    await expectCode(addPlanItem(db, owner, campaignId, 1, item()), "CONFLICT", "plan_changed");
    await expectCode(
      createDraftsFromPlan(db, owner, campaignId, 2),
      "CONFLICT",
      "plan_not_approved",
    );
    await approvePlan(db, owner, campaignId, 2);
    await expectCode(addPlanItem(db, owner, campaignId, 3, item()), "CONFLICT", "plan_locked");
    await expectCode(
      generatePlanItems(db, owner, runtime(), campaignId, 3, {
        count: 3,
        uiLocale: "en",
        today: TODAY,
      }),
      "CONFLICT",
      "plan_locked",
    );
  });

  it("keeps drafted items when the plan is reopened and regenerated", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief());
    const { itemId } = await addPlanItem(db, owner, campaignId, 1, item());
    await approvePlan(db, owner, campaignId, 2);
    await createDraftsFromPlan(db, owner, campaignId, 3);
    await reopenPlan(db, owner, campaignId, 4);
    expect(await getCampaignPlan(db, owner, campaignId)).toMatchObject({
      status: "DRAFT",
      approvedAt: null,
    });
    await expectCode(
      updatePlanItem(db, owner, campaignId, itemId, 5, item({ title: "Changed" })),
      "CONFLICT",
      "plan_item_converted",
    );
    await expectCode(
      removePlanItem(db, owner, campaignId, itemId, 5),
      "CONFLICT",
      "plan_item_converted",
    );
    await generatePlanItems(db, owner, runtime(), campaignId, 5, {
      count: 3,
      uiLocale: "ar",
      today: TODAY,
    });
    const plan = await getCampaignPlan(db, owner, campaignId);
    expect(plan?.items).toHaveLength(4);
    expect(plan?.items[0]).toMatchObject({ id: itemId, aiGenerated: false });
    expect(plan?.items.slice(1).every((i) => i.contentItemId === null)).toBe(true);
    // Arabic brief labels for an Arabic generation.
    expect(plan?.items[1]?.brief).toContain("الزاوية");
  });

  it("leaves the plan unchanged when the AI provider fails or is not configured", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief());
    await addPlanItem(db, owner, campaignId, 1, item());
    const before = await getCampaignPlan(db, owner, campaignId);
    // The engine maps each provider failure to its own code; what matters here is that
    // the plan (items and version) is exactly as it was.
    await rejection(
      generatePlanItems(db, owner, runtime({ scenario: "unavailable" }), campaignId, 2, {
        count: 3,
        uiLocale: "en",
        today: TODAY,
      }),
    );
    await rejection(
      generatePlanItems(db, owner, runtime({ scenario: "malformed" }), campaignId, 2, {
        count: 3,
        uiLocale: "en",
        today: TODAY,
      }),
    );
    await rejection(
      generatePlanItems(db, owner, { provider: null, timeoutMs: 1000 }, campaignId, 2, {
        count: 3,
        uiLocale: "en",
        today: TODAY,
      }),
    );
    expect(await getCampaignPlan(db, owner, campaignId)).toEqual(before);
  });

  it("needs channels before proposing items, and an editable campaign", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief({ channels: [] }));
    await expectCode(
      generatePlanItems(db, owner, runtime(), campaignId, 1, {
        count: 3,
        uiLocale: "en",
        today: TODAY,
      }),
      "VALIDATION_FAILED",
      "required",
    );
    await changeCampaignStatus(db, owner, campaignId, "ARCHIVED");
    await expectCode(
      savePlanBrief(db, owner, campaignId, 1, brief()),
      "CONFLICT",
      "campaign_locked",
    );
  });

  it("creates each item's draft once when two people convert at the same time", async () => {
    const owner = await createTenant(system);
    const manager = await memberOf(owner, "MANAGER");
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief());
    for (let index = 0; index < 3; index += 1) {
      await addPlanItem(db, owner, campaignId, 1 + index, item({ title: `Item ${String(index)}` }));
    }
    await approvePlan(db, owner, campaignId, 4);
    const results = await Promise.allSettled([
      createDraftsFromPlan(db, owner, campaignId, 5),
      createDraftsFromPlan(db, manager, campaignId, 5),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected");
    expect((failed?.reason as AppError).fields[0]?.code).toBe("plan_changed");
    expect(await system.contentItem.count({ where: { campaignId } })).toBe(3);
  });

  it("starts a plan once when two people save the first brief at the same time", async () => {
    const owner = await createTenant(system);
    const manager = await memberOf(owner, "MANAGER");
    const { campaignId } = await campaignWithLinks(owner);
    const results = await Promise.allSettled([
      savePlanBrief(db, owner, campaignId, 0, brief()),
      savePlanBrief(db, manager, campaignId, 0, brief({ offer: "Other" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await system.campaignPlan.count({ where: { campaignId } })).toBe(1);
  });

  it("clears an item's link when its content is deleted, so it can be drafted again", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief());
    const { itemId } = await addPlanItem(db, owner, campaignId, 1, item());
    await approvePlan(db, owner, campaignId, 2);
    await createDraftsFromPlan(db, owner, campaignId, 3);
    const linked = await system.campaignPlanItem.findUniqueOrThrow({ where: { id: itemId } });
    await deleteContent(db, owner, must(linked.contentItemId));
    expect(
      (await system.campaignPlanItem.findUniqueOrThrow({ where: { id: itemId } })).contentItemId,
    ).toBeNull();
    expect(await createDraftsFromPlan(db, owner, campaignId, 4)).toEqual({ created: 1 });
  });
});

// ── roles and tenants ────────────────────────────────────────────────────────

describe("plan permissions and isolation", () => {
  it("lets managers plan, editors and viewers only read, clients see progress", async () => {
    const owner = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    const editor = await memberOf(owner, "EDITOR");
    const viewer = await memberOf(owner, "VIEWER");
    const client = await memberOf(owner, "CLIENT");
    const manager = await memberOf(owner, "MANAGER");

    for (const ctx of [editor, viewer, client]) {
      await expectCode(savePlanBrief(db, ctx, campaignId, 0, brief()), "FORBIDDEN");
    }
    await savePlanBrief(db, manager, campaignId, 0, brief());
    await expectCode(addPlanItem(db, editor, campaignId, 1, item()), "FORBIDDEN");
    await expectCode(
      generatePlanItems(db, viewer, runtime(), campaignId, 1, {
        count: 3,
        uiLocale: "en",
        today: TODAY,
      }),
      "FORBIDDEN",
    );
    await addPlanItem(db, manager, campaignId, 1, item());
    await expectCode(approvePlan(db, editor, campaignId, 2), "FORBIDDEN");
    await expectCode(approvePlan(db, client, campaignId, 2), "FORBIDDEN");
    await approvePlan(db, manager, campaignId, 2);
    await expectCode(createDraftsFromPlan(db, viewer, campaignId, 3), "FORBIDDEN");
    // Editors may create content, but turning a campaign's plan into drafts is a
    // campaign decision (campaign.manage).
    await expectCode(createDraftsFromPlan(db, editor, campaignId, 3), "FORBIDDEN");
    expect(await system.contentItem.count({ where: { campaignId } })).toBe(0);

    for (const ctx of [editor, viewer, client]) {
      expect((await getCampaignPlan(db, ctx, campaignId))?.status).toBe("APPROVED");
      expect((await progressOf(ctx, campaignId)).total).toBe(1);
    }
  });

  it("never reads or changes another workspace's plan", async () => {
    const owner = await createTenant(system);
    const other = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    await savePlanBrief(db, owner, campaignId, 0, brief());
    const { itemId } = await addPlanItem(db, owner, campaignId, 1, item());

    expect(await getCampaignPlan(db, other, campaignId)).toBeNull();
    await expectCode(campaignProgressFacts(db, other, campaignId), "NOT_FOUND");
    await expectCode(savePlanBrief(db, other, campaignId, 2, brief()), "NOT_FOUND");
    await expectCode(addPlanItem(db, other, campaignId, 2, item()), "NOT_FOUND");
    // Their own campaign, our item id: not found either.
    const { campaignId: theirs } = await campaignWithLinks(other);
    await savePlanBrief(db, other, theirs, 0, brief());
    await expectCode(
      updatePlanItem(db, other, theirs, itemId, 1, item({ title: "Hijack" })),
      "NOT_FOUND",
    );
    await expectCode(removePlanItem(db, other, theirs, itemId, 1), "NOT_FOUND");
    expect((await system.campaignPlanItem.findUniqueOrThrow({ where: { id: itemId } })).title).toBe(
      "Behind the counter",
    );
  });

  it("refuses cross-workspace rows and moved links in the database itself", async () => {
    const owner = await createTenant(system);
    const other = await createTenant(system);
    const { campaignId } = await campaignWithLinks(owner);
    const { campaignId: theirs } = await campaignWithLinks(other);
    await savePlanBrief(db, owner, campaignId, 0, brief());
    await savePlanBrief(db, other, theirs, 0, brief());
    const ours = await system.campaignPlan.findUniqueOrThrow({ where: { campaignId } });

    // A plan for another workspace's campaign.
    await expect(
      system.campaignPlan.create({
        data: { workspaceId: owner.workspaceId, campaignId: theirs },
      }),
    ).rejects.toThrow();
    // An item in our workspace pointing at their plan.
    const theirPlan = await system.campaignPlan.findUniqueOrThrow({
      where: { campaignId: theirs },
    });
    await expect(
      system.campaignPlanItem.create({
        data: {
          workspaceId: owner.workspaceId,
          planId: theirPlan.id,
          position: 0,
          title: "x",
          contentType: "POST",
          channel: "OTHER",
        },
      }),
    ).rejects.toThrow();
    // A plan never moves to another campaign.
    const { campaignId: second } = await createCampaign(
      db,
      owner,
      campaignFieldsSchema.parse({ name: "Second" }),
    );
    await expect(
      system.campaignPlan.update({ where: { id: ours.id }, data: { campaignId: second } }),
    ).rejects.toThrow(/immutable/);

    // An item's draft is set once: never moved to other content.
    const { itemId } = await addPlanItem(db, owner, campaignId, 1, item());
    await approvePlan(db, owner, campaignId, 2);
    await createDraftsFromPlan(db, owner, campaignId, 3);
    const extra = await system.contentItem.create({
      data: { workspaceId: owner.workspaceId, title: "Other" },
    });
    await expect(
      system.campaignPlanItem.update({ where: { id: itemId }, data: { contentItemId: extra.id } }),
    ).rejects.toThrow(/set once/);
    // An approved plan always records when.
    await expect(
      system.campaignPlan.update({ where: { id: ours.id }, data: { approvedAt: null } }),
    ).rejects.toThrow();
  });
});
