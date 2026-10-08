// Phase 3 — Marketing Core services on the real database: CRUD and audit, tenant
// isolation (every entity, every id-taking operation), the role matrix, the content
// workflow, database-level guarantees, the calendar, the dashboard and media.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { AppError } from "@/server/errors/app-error";
import {
  createAudience,
  deleteAudience,
  getAudience,
  listAudiences,
  updateAudience,
} from "@/server/marketing/audience-service";
import { getBrand, saveBrand } from "@/server/marketing/brand-service";
import {
  changeCampaignStatus,
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from "@/server/marketing/campaign-service";
import {
  availableTransitions,
  createContent,
  deleteContent,
  getContent,
  listContent,
  rescheduleContent,
  transitionContent,
  updateContent,
} from "@/server/marketing/content-service";
import { createGoal, getGoal, listGoals, updateGoal } from "@/server/marketing/goal-service";
import {
  audienceFieldsSchema,
  brandFieldsSchema,
  campaignFieldsSchema,
  contentFieldsSchema,
  goalFieldsSchema,
  pillarFieldsSchema,
  type ContentTransition,
} from "@/server/marketing/inputs";
import {
  deleteMedia,
  listMedia,
  readMedia,
  updateMediaAltText,
  uploadMedia,
} from "@/server/marketing/media-service";
import { getCalendar, getDashboard, listActivity } from "@/server/marketing/overview-service";
import {
  createPillar,
  getPillar,
  listPillars,
  movePillar,
  updatePillar,
} from "@/server/marketing/pillar-service";
import { MemoryStorageService } from "@/server/storage/memory-storage";
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

const brandFields = (overrides: Record<string, unknown> = {}) =>
  brandFieldsSchema.parse({ name: "Qahwa", language: "AR", keywords: "coffee", ...overrides });
const audienceFields = (overrides: Record<string, unknown> = {}) =>
  audienceFieldsSchema.parse({ name: "Pros", attributes: "Age: 25–34", ...overrides });
const goalFields = (overrides: Record<string, unknown> = {}) =>
  goalFieldsSchema.parse({ type: "SALES", title: "Grow", status: "ACTIVE", ...overrides });
const pillarFields = (overrides: Record<string, unknown> = {}) =>
  pillarFieldsSchema.parse({ name: "Education", ...overrides });
const campaignFields = (overrides: Record<string, unknown> = {}) =>
  campaignFieldsSchema.parse({ name: "Launch", ...overrides });
const contentFields = (overrides: Record<string, unknown> = {}) =>
  contentFieldsSchema.parse({ title: "Teaser", type: "POST", ...overrides });

/** Another member of the same workspace with `role`. */
async function memberOf(ctx: TenantContext, role: WorkspaceRole): Promise<TenantContext> {
  const user = await system.user.create({
    data: { email: `${role.toLowerCase()}-${crypto.randomUUID()}@test.flexibx.local`, name: role },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return { userId: user.id, workspaceId: ctx.workspaceId, role };
}

async function auditActions(ctx: TenantContext) {
  const rows = await system.auditLog.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => row.action);
}

/** Every marketing record kind, created in `ctx`'s workspace. */
async function seedWorkspace(ctx: TenantContext) {
  const storage = new MemoryStorageService();
  const { audienceId } = await createAudience(db, ctx, audienceFields());
  const { goalId } = await createGoal(db, ctx, goalFields());
  const { pillarId } = await createPillar(db, ctx, pillarFields({ audienceId }));
  const { campaignId } = await createCampaign(
    db,
    ctx,
    campaignFields({ audienceId, goalIds: [goalId], pillarIds: [pillarId] }),
  );
  const { assetId } = await uploadMedia(db, storage, ctx, pngFile());
  const { contentId } = await createContent(
    db,
    ctx,
    contentFields({ campaignId, pillarId, audienceId, goalId, assetIds: [assetId] }),
  );
  return { storage, audienceId, goalId, pillarId, campaignId, assetId, contentId };
}

function png(width = 2, height = 1): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
function pngFile(name = "cup.png", bytes = png()) {
  return { name, size: bytes.byteLength, bytes: () => Promise.resolve(bytes) };
}

const FUTURE = "2099-01-15T10:30";

// ── CRUD and audit ───────────────────────────────────────────────────────────

describe("brand profile", () => {
  it("is created once, updated in place and audited with field names only", async () => {
    const ctx = await createTenant(system);
    expect(await getBrand(db, ctx)).toBeNull();
    const first = await saveBrand(db, ctx, brandFields({ toneOfVoice: "Warm" }));
    expect(first.created).toBe(true);
    const second = await saveBrand(db, ctx, brandFields({ toneOfVoice: "Bold" }));
    expect(second).toEqual({ brandId: first.brandId, created: false });
    // Saving the same values again changes nothing and records nothing.
    await saveBrand(db, ctx, brandFields({ toneOfVoice: "Bold" }));

    const brand = await getBrand(db, ctx);
    expect(brand?.toneOfVoice).toBe("Bold");
    expect(brand?.keywords).toEqual(["coffee"]);
    expect(await system.brand.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
    expect(await auditActions(ctx)).toEqual(["brand.created", "brand.updated"]);
    const updated = await system.auditLog.findFirstOrThrow({ where: { action: "brand.updated" } });
    expect(updated.metadata).toEqual({ fields: ["toneOfVoice"] });
    expect(JSON.stringify(updated.metadata)).not.toContain("Bold");
  });

  it("stays one row under concurrent first saves", async () => {
    const ctx = await createTenant(system);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        saveBrand(db, ctx, brandFields({ name: `B${String(index)}` })),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await system.brand.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
  });
});

describe("audiences, goals and pillars", () => {
  it("create, read, update and delete audiences", async () => {
    const ctx = await createTenant(system);
    const { audienceId } = await createAudience(db, ctx, audienceFields());
    expect((await getAudience(db, ctx, audienceId)).attributes).toEqual([
      { label: "Age", value: "25–34" },
    ]);
    await updateAudience(db, ctx, audienceId, audienceFields({ buyingIntent: "HIGH" }));
    expect((await listAudiences(db, ctx)).map((row) => row.buyingIntent)).toEqual(["HIGH"]);
    await deleteAudience(db, ctx, audienceId);
    await expectCode(getAudience(db, ctx, audienceId), "NOT_FOUND");
    await expectCode(deleteAudience(db, ctx, audienceId), "NOT_FOUND");
    expect(await auditActions(ctx)).toEqual([
      "audience.created",
      "audience.updated",
      "audience.deleted",
    ]);
  });

  it("deleting an audience unlinks pillars, campaigns and content instead of deleting them", async () => {
    const ctx = await createTenant(system);
    const seeded = await seedWorkspace(ctx);
    await deleteAudience(db, ctx, seeded.audienceId);
    expect((await getPillar(db, ctx, seeded.pillarId)).audienceId).toBeNull();
    expect((await getCampaign(db, ctx, seeded.campaignId)).audienceId).toBeNull();
    expect((await getContent(db, ctx, seeded.contentId)).audienceId).toBeNull();
  });

  it("stores goal targets and dates exactly and audits status changes", async () => {
    const ctx = await createTenant(system);
    const { goalId } = await createGoal(
      db,
      ctx,
      goalFields({ target: "1500.5", startDate: "2030-01-01", endDate: "2030-03-31" }),
    );
    const goal = await getGoal(db, ctx, goalId);
    expect(String(goal.target)).toBe("1500.5");
    expect(goal.startDate?.toISOString().slice(0, 10)).toBe("2030-01-01");
    // Same values in a different text form: no change recorded.
    await updateGoal(
      db,
      ctx,
      goalId,
      goalFields({ target: "1500.50", startDate: "2030-01-01", endDate: "2030-03-31" }),
    );
    await updateGoal(
      db,
      ctx,
      goalId,
      goalFields({
        target: "1500.5",
        startDate: "2030-01-01",
        endDate: "2030-03-31",
        status: "ACHIEVED",
      }),
    );
    expect(await auditActions(ctx)).toEqual(["goal.created", "goal.updated"]);
    const audit = await system.auditLog.findFirstOrThrow({ where: { action: "goal.updated" } });
    expect(audit.metadata).toEqual({ fields: ["status"], from: "ACTIVE", to: "ACHIEVED" });
    expect((await listGoals(db, ctx)).map((row) => row.status)).toEqual(["ACHIEVED"]);
  });

  it("orders pillars, moves them and archives them", async () => {
    const ctx = await createTenant(system);
    const a = await createPillar(db, ctx, pillarFields({ name: "A" }));
    const b = await createPillar(db, ctx, pillarFields({ name: "B" }));
    const c = await createPillar(db, ctx, pillarFields({ name: "C" }));
    const names = async () => (await listPillars(db, ctx)).map((row) => row.name);
    expect(await names()).toEqual(["A", "B", "C"]);
    expect(await movePillar(db, ctx, c.pillarId, "up")).toEqual({ moved: true });
    expect(await names()).toEqual(["A", "C", "B"]);
    expect(await movePillar(db, ctx, a.pillarId, "up")).toEqual({ moved: false });
    expect(await movePillar(db, ctx, b.pillarId, "down")).toEqual({ moved: false });
    await updatePillar(db, ctx, a.pillarId, pillarFields({ name: "A", archived: "on" }));
    expect((await getPillar(db, ctx, a.pillarId)).status).toBe("ARCHIVED");
  });
});

describe("campaigns", () => {
  it("link goals and pillars, store the budget in minor units and audit", async () => {
    const ctx = await createTenant(system);
    const g1 = await createGoal(db, ctx, goalFields({ title: "G1" }));
    const g2 = await createGoal(db, ctx, goalFields({ title: "G2" }));
    const p1 = await createPillar(db, ctx, pillarFields());
    const { campaignId } = await createCampaign(
      db,
      ctx,
      campaignFields({
        goalIds: [g1.goalId],
        pillarIds: [p1.pillarId],
        budgetAmount: "1500.5",
        budgetCurrency: "sar",
      }),
    );
    let campaign = await getCampaign(db, ctx, campaignId);
    expect(campaign.budgetAmountMinor).toBe(150050n);
    expect(campaign.budgetCurrency).toBe("SAR");
    expect(campaign.goals.map((link) => link.goal.title)).toEqual(["G1"]);

    await updateCampaign(
      db,
      ctx,
      campaignId,
      campaignFields({
        goalIds: [g2.goalId, g1.goalId],
        pillarIds: [],
        budgetAmount: "1500.50",
        budgetCurrency: "SAR",
      }),
    );
    campaign = await getCampaign(db, ctx, campaignId);
    expect(campaign.goals.map((link) => link.goal.title).sort()).toEqual(["G1", "G2"]);
    expect(campaign.pillars).toEqual([]);
    const audit = await system.auditLog.findFirstOrThrow({ where: { action: "campaign.updated" } });
    expect(audit.metadata).toEqual({ fields: ["goalIds", "pillarIds"] });
  });

  it("follow the lifecycle; archived campaigns are read-only and cannot be newly linked", async () => {
    const ctx = await createTenant(system);
    const { campaignId } = await createCampaign(db, ctx, campaignFields());
    await expectCode(
      changeCampaignStatus(db, ctx, campaignId, "COMPLETED"),
      "CONFLICT",
      "invalid_transition",
    );
    await changeCampaignStatus(db, ctx, campaignId, "ACTIVE");
    await changeCampaignStatus(db, ctx, campaignId, "ARCHIVED");
    await expectCode(changeCampaignStatus(db, ctx, campaignId, "ACTIVE"), "CONFLICT");
    await expectCode(
      updateCampaign(db, ctx, campaignId, campaignFields({ name: "Renamed" })),
      "CONFLICT",
      "campaign_locked",
    );
    await expectCode(
      createContent(db, ctx, contentFields({ campaignId })),
      "VALIDATION_FAILED",
      "reference_archived",
    );
    expect(await listCampaigns(db, ctx)).toEqual([]);
    expect(await listCampaigns(db, ctx, { includeArchived: true })).toHaveLength(1);
    expect(await auditActions(ctx)).toEqual([
      "campaign.created",
      "campaign.updated",
      "campaign.archived",
    ]);
  });

  it("keep an already-linked archived goal but refuse to link a newly archived one", async () => {
    const ctx = await createTenant(system);
    const kept = await createGoal(db, ctx, goalFields({ title: "Kept" }));
    const other = await createGoal(db, ctx, goalFields({ title: "Other", status: "ARCHIVED" }));
    const { campaignId } = await createCampaign(
      db,
      ctx,
      campaignFields({ goalIds: [kept.goalId] }),
    );
    await updateGoal(db, ctx, kept.goalId, goalFields({ title: "Kept", status: "ARCHIVED" }));
    await updateCampaign(
      db,
      ctx,
      campaignId,
      campaignFields({ name: "Still", goalIds: [kept.goalId] }),
    );
    await expectCode(
      updateCampaign(db, ctx, campaignId, campaignFields({ goalIds: [kept.goalId, other.goalId] })),
      "VALIDATION_FAILED",
      "reference_archived",
    );
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("another workspace's ids are NOT_FOUND for every read, update and delete", async () => {
    const owner = await createTenant(system);
    const other = await createTenant(system);
    const s = await seedWorkspace(owner);
    const storage = s.storage;

    const attempts: [string, () => Promise<unknown>][] = [
      ["getAudience", () => getAudience(db, other, s.audienceId)],
      ["updateAudience", () => updateAudience(db, other, s.audienceId, audienceFields())],
      ["deleteAudience", () => deleteAudience(db, other, s.audienceId)],
      ["getGoal", () => getGoal(db, other, s.goalId)],
      ["updateGoal", () => updateGoal(db, other, s.goalId, goalFields())],
      ["getPillar", () => getPillar(db, other, s.pillarId)],
      ["updatePillar", () => updatePillar(db, other, s.pillarId, pillarFields())],
      ["movePillar", () => movePillar(db, other, s.pillarId, "up")],
      ["getCampaign", () => getCampaign(db, other, s.campaignId)],
      ["updateCampaign", () => updateCampaign(db, other, s.campaignId, campaignFields())],
      ["changeCampaignStatus", () => changeCampaignStatus(db, other, s.campaignId, "ARCHIVED")],
      ["getContent", () => getContent(db, other, s.contentId)],
      ["updateContent", () => updateContent(db, other, s.contentId, contentFields())],
      ["deleteContent", () => deleteContent(db, other, s.contentId)],
      [
        "transitionContent",
        () =>
          transitionContent(db, other, {
            contentId: s.contentId,
            transition: "submit",
            scheduledAt: null,
          }),
      ],
      [
        "rescheduleContent",
        () => rescheduleContent(db, other, { contentId: s.contentId, scheduledAt: FUTURE }),
      ],
      ["updateMediaAltText", () => updateMediaAltText(db, other, s.assetId, "x")],
      ["deleteMedia", () => deleteMedia(db, storage, other, s.assetId)],
      ["readMedia", () => readMedia(db, storage, other, s.assetId)],
    ];
    for (const [name, attempt] of attempts) {
      const error = await rejection(attempt());
      expect(`${name}:${error.code}`).toBe(`${name}:NOT_FOUND`);
    }

    // Nothing of the owner's changed, and nothing leaked into the other workspace's lists.
    expect((await getContent(db, owner, s.contentId)).status).toBe("DRAFT");
    expect(await listAudiences(db, other)).toEqual([]);
    expect(await listGoals(db, other)).toEqual([]);
    expect(await listPillars(db, other)).toEqual([]);
    expect(await listCampaigns(db, other, { includeArchived: true })).toEqual([]);
    expect((await listContent(db, other, { page: 1 })).total).toBe(0);
    expect(await listMedia(db, other)).toEqual([]);
    expect(await getBrand(db, other)).toBeNull();
    expect(await auditActions(other)).toEqual([]);
    expect(storage.objects.size).toBe(1);
  });

  it("refuses to link another workspace's records (service check)", async () => {
    const owner = await createTenant(system);
    const other = await createTenant(system);
    const s = await seedWorkspace(owner);
    const links: [string, () => Promise<unknown>][] = [
      [
        "pillar.audienceId",
        () => createPillar(db, other, pillarFields({ audienceId: s.audienceId })),
      ],
      [
        "campaign.audienceId",
        () => createCampaign(db, other, campaignFields({ audienceId: s.audienceId })),
      ],
      [
        "campaign.goalIds",
        () => createCampaign(db, other, campaignFields({ goalIds: [s.goalId] })),
      ],
      [
        "campaign.pillarIds",
        () => createCampaign(db, other, campaignFields({ pillarIds: [s.pillarId] })),
      ],
      [
        "content.campaignId",
        () => createContent(db, other, contentFields({ campaignId: s.campaignId })),
      ],
      ["content.pillarId", () => createContent(db, other, contentFields({ pillarId: s.pillarId }))],
      [
        "content.audienceId",
        () => createContent(db, other, contentFields({ audienceId: s.audienceId })),
      ],
      ["content.goalId", () => createContent(db, other, contentFields({ goalId: s.goalId }))],
      [
        "content.assetIds",
        () => createContent(db, other, contentFields({ assetIds: [s.assetId] })),
      ],
    ];
    for (const [name, attempt] of links) {
      const error = await rejection(attempt());
      expect(`${name}:${error.code}:${error.fields[0]?.code ?? ""}`).toBe(
        `${name}:VALIDATION_FAILED:reference_not_found`,
      );
    }
    expect(await system.contentItem.count({ where: { workspaceId: other.workspaceId } })).toBe(0);
    expect(await system.campaign.count({ where: { workspaceId: other.workspaceId } })).toBe(0);
  });

  it("the database itself rejects cross-workspace links and workspace moves", async () => {
    const owner = await createTenant(system);
    const other = await createTenant(system);
    const s = await seedWorkspace(owner);
    const t = await seedWorkspace(other);
    await saveBrand(db, owner, brandFields());
    const fk = /foreign key|cross-workspace|another workspace|workspace/i;

    // Direct writes on the UNGUARDED client, as a buggy future code path might do.
    await expect(
      system.contentItem.update({ where: { id: t.contentId }, data: { campaignId: s.campaignId } }),
    ).rejects.toThrow(fk);
    await expect(
      system.contentItem.update({ where: { id: t.contentId }, data: { pillarId: s.pillarId } }),
    ).rejects.toThrow(fk);
    await expect(
      system.contentItem.update({ where: { id: t.contentId }, data: { audienceId: s.audienceId } }),
    ).rejects.toThrow(fk);
    await expect(
      system.contentItem.update({ where: { id: t.contentId }, data: { goalId: s.goalId } }),
    ).rejects.toThrow(fk);
    await expect(
      system.campaignGoal.create({
        data: { workspaceId: other.workspaceId, campaignId: t.campaignId, goalId: s.goalId },
      }),
    ).rejects.toThrow(fk);
    await expect(
      system.campaignPillar.create({
        data: { workspaceId: other.workspaceId, campaignId: t.campaignId, pillarId: s.pillarId },
      }),
    ).rejects.toThrow(fk);
    await expect(
      system.contentItemAsset.create({
        data: {
          workspaceId: other.workspaceId,
          contentItemId: t.contentId,
          mediaAssetId: s.assetId,
        },
      }),
    ).rejects.toThrow(fk);
    await expect(
      system.contentPillar.update({
        where: { id: t.pillarId },
        data: { audienceId: s.audienceId },
      }),
    ).rejects.toThrow(fk);
    await expect(
      system.campaign.update({ where: { id: t.campaignId }, data: { audienceId: s.audienceId } }),
    ).rejects.toThrow(fk);
    // A link row claiming the right workspace but pointing at foreign rows.
    await expect(
      system.campaignGoal.create({
        data: { workspaceId: owner.workspaceId, campaignId: t.campaignId, goalId: s.goalId },
      }),
    ).rejects.toThrow(fk);
    // Records never move between workspaces.
    for (const update of [
      () =>
        system.brand.updateMany({
          where: { workspaceId: owner.workspaceId },
          data: { workspaceId: other.workspaceId },
        }),
      () =>
        system.contentItem.update({
          where: { id: s.contentId },
          data: { workspaceId: other.workspaceId },
        }),
      () =>
        system.mediaAsset.update({
          where: { id: s.assetId },
          data: { workspaceId: other.workspaceId },
        }),
      () =>
        system.campaign.update({
          where: { id: s.campaignId },
          data: { workspaceId: other.workspaceId },
        }),
    ]) {
      await expect(update()).rejects.toThrow();
    }
  });

  it("the tenant guard rejects unscoped queries and nested writes on every new model", async () => {
    await createTenant(system);
    const unscoped = [
      () => db.brand.findMany(),
      () => db.audience.findMany(),
      () => db.marketingGoal.findMany(),
      () => db.contentPillar.findMany(),
      () => db.campaign.findMany(),
      () => db.campaignGoal.findMany(),
      () => db.campaignPillar.findMany(),
      () => db.contentItem.findMany(),
      () => db.mediaAsset.findMany(),
      () => db.contentItemAsset.findMany(),
      () => db.contentItem.updateMany({ data: { title: "x" } }),
      () => db.mediaAsset.deleteMany(),
    ];
    for (const query of unscoped) await expectCode(query(), "TENANT_SCOPE_MISSING");
    const ctx = await createTenant(system);
    await expectCode(
      db.workspace.update({
        where: { id: ctx.workspaceId },
        data: { contentItems: { create: { title: "x" } } },
      }),
      "TENANT_SCOPE_MISSING",
    );
    await expectCode(
      db.user.findMany({ include: { contentCreated: true } }),
      "TENANT_SCOPE_MISSING",
    );
  });
});

// ── permissions ──────────────────────────────────────────────────────────────

describe("role matrix", () => {
  const ROLES = Object.values(WorkspaceRole);

  async function attempt(role: WorkspaceRole) {
    const owner = await createTenant(system);
    const s = await seedWorkspace(owner);
    const ctx = await memberOf(owner, role);
    const ok = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return "ok";
      } catch (error) {
        if (error instanceof AppError) return error.code;
        throw error;
      }
    };
    return {
      viewBrand: await ok(getBrand(db, ctx)),
      editBrand: await ok(saveBrand(db, ctx, brandFields())),
      viewAudiences: await ok(listAudiences(db, ctx)),
      editAudience: await ok(createAudience(db, ctx, audienceFields())),
      viewGoals: await ok(listGoals(db, ctx)),
      editGoal: await ok(createGoal(db, ctx, goalFields())),
      editPillar: await ok(createPillar(db, ctx, pillarFields())),
      viewCampaigns: await ok(listCampaigns(db, ctx)),
      editCampaign: await ok(createCampaign(db, ctx, campaignFields())),
      viewContent: await ok(listContent(db, ctx, { page: 1 })),
      createContent: await ok(createContent(db, ctx, contentFields())),
      editContent: await ok(
        updateContent(db, ctx, s.contentId, contentFields({ title: "Edited" })),
      ),
      upload: await ok(uploadMedia(db, s.storage, ctx, pngFile())),
      editMedia: await ok(updateMediaAltText(db, ctx, s.assetId, "alt")),
      calendar: await ok(getCalendar(db, ctx, { view: "week" })),
      activity: await ok(listActivity(db, ctx)),
    };
  }

  it("matches the permission matrix for every role", async () => {
    const results: Record<string, Awaited<ReturnType<typeof attempt>>> = {};
    for (const role of ROLES) {
      await resetDatabase(system);
      results[role] = await attempt(role);
    }
    const F = "FORBIDDEN";
    const all = (value: string) => ({
      viewBrand: value,
      editBrand: value,
      viewAudiences: value,
      editAudience: value,
      viewGoals: value,
      editGoal: value,
      editPillar: value,
      viewCampaigns: value,
      editCampaign: value,
      viewContent: value,
      createContent: value,
      editContent: value,
      upload: value,
      editMedia: value,
      calendar: value,
      activity: value,
    });
    expect(results).toEqual({
      OWNER: all("ok"),
      ADMIN: all("ok"),
      MANAGER: { ...all("ok"), activity: F },
      EDITOR: { ...all("ok"), editGoal: F, editCampaign: F, activity: F },
      VIEWER: {
        ...all(F),
        viewBrand: "ok",
        viewAudiences: "ok",
        viewGoals: "ok",
        viewCampaigns: "ok",
        viewContent: "ok",
        calendar: "ok",
      },
      CLIENT: {
        ...all(F),
        viewBrand: "ok",
        viewAudiences: "ok",
        viewGoals: "ok",
        viewCampaigns: "ok",
        viewContent: "ok",
        calendar: "ok",
      },
    });
  });

  it("each workflow step needs its own permission", async () => {
    const owner = await createTenant(system);
    const transitionAs = async (
      role: WorkspaceRole,
      transition: ContentTransition,
      from: string,
    ) => {
      const { contentId } = await createContent(db, owner, contentFields());
      await system.contentItem.update({
        where: { id: contentId },
        data: {
          status: from as "DRAFT",
          scheduledAt: from === "SCHEDULED" ? new Date("2099-01-01T00:00:00Z") : null,
        },
      });
      const ctx = await memberOf(owner, role);
      try {
        await transitionContent(db, ctx, { contentId, transition, scheduledAt: FUTURE });
        return "ok";
      } catch (error) {
        if (error instanceof AppError) return error.code;
        throw error;
      }
    };
    const cases: [ContentTransition, string][] = [
      ["submit", "DRAFT"],
      ["withdraw", "IN_REVIEW"],
      ["approve", "IN_REVIEW"],
      ["request_changes", "IN_REVIEW"],
      ["reopen", "APPROVED"],
      ["schedule", "APPROVED"],
      ["unschedule", "SCHEDULED"],
      ["publish", "SCHEDULED"],
    ];
    const table: Record<string, string> = {};
    for (const role of ["EDITOR", "MANAGER", "VIEWER", "CLIENT"] as const) {
      for (const [transition, from] of cases) {
        table[`${role}:${transition}`] = await transitionAs(role, transition, from);
      }
    }
    expect(table).toEqual({
      "EDITOR:submit": "ok",
      "EDITOR:withdraw": "ok",
      "EDITOR:approve": "FORBIDDEN",
      "EDITOR:request_changes": "FORBIDDEN",
      "EDITOR:reopen": "ok",
      "EDITOR:schedule": "FORBIDDEN",
      "EDITOR:unschedule": "FORBIDDEN",
      "EDITOR:publish": "FORBIDDEN",
      "MANAGER:submit": "ok",
      "MANAGER:withdraw": "ok",
      "MANAGER:approve": "ok",
      "MANAGER:request_changes": "ok",
      "MANAGER:reopen": "ok",
      "MANAGER:schedule": "ok",
      "MANAGER:unschedule": "ok",
      "MANAGER:publish": "ok",
      "VIEWER:submit": "FORBIDDEN",
      "VIEWER:withdraw": "FORBIDDEN",
      "VIEWER:approve": "FORBIDDEN",
      "VIEWER:request_changes": "FORBIDDEN",
      "VIEWER:reopen": "FORBIDDEN",
      "VIEWER:schedule": "FORBIDDEN",
      "VIEWER:unschedule": "FORBIDDEN",
      "VIEWER:publish": "FORBIDDEN",
      // CLIENT reviews: approve or request changes, nothing else.
      "CLIENT:submit": "FORBIDDEN",
      "CLIENT:withdraw": "FORBIDDEN",
      "CLIENT:approve": "ok",
      "CLIENT:request_changes": "ok",
      "CLIENT:reopen": "FORBIDDEN",
      "CLIENT:schedule": "FORBIDDEN",
      "CLIENT:unschedule": "FORBIDDEN",
      "CLIENT:publish": "FORBIDDEN",
    });
    expect(availableTransitions({ role: "CLIENT" }, "IN_REVIEW")).toEqual([
      "approve",
      "request_changes",
    ]);
  });

  it("deleting or moving content past draft needs content.publish", async () => {
    const owner = await createTenant(system);
    const editor = await memberOf(owner, WorkspaceRole.EDITOR);
    const manager = await memberOf(owner, WorkspaceRole.MANAGER);
    const draft = await createContent(db, owner, contentFields());
    const scheduled = await createContent(db, owner, contentFields());
    await system.contentItem.update({
      where: { id: scheduled.contentId },
      data: { status: "SCHEDULED", scheduledAt: new Date("2099-01-01T00:00:00Z") },
    });
    await expectCode(
      rescheduleContent(db, editor, { contentId: scheduled.contentId, scheduledAt: FUTURE }),
      "FORBIDDEN",
    );
    await rescheduleContent(db, editor, { contentId: draft.contentId, scheduledAt: FUTURE });
    await rescheduleContent(db, manager, { contentId: scheduled.contentId, scheduledAt: FUTURE });
    await expectCode(deleteContent(db, editor, scheduled.contentId), "FORBIDDEN");
    await deleteContent(db, editor, draft.contentId);
    await deleteContent(db, manager, scheduled.contentId);
    expect(await system.contentItem.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
  });
});

// ── content workflow ─────────────────────────────────────────────────────────

describe("content workflow", () => {
  it("runs the whole lifecycle with audit from/to, and publishing is final", async () => {
    const ctx = await createTenant(system);
    const { contentId } = await createContent(db, ctx, contentFields({ plannedAt: FUTURE }));
    const run = (transition: ContentTransition, scheduledAt: string | null = null) =>
      transitionContent(db, ctx, { contentId, transition, scheduledAt });

    expect((await run("submit")).status).toBe("IN_REVIEW");
    expect((await run("request_changes")).status).toBe("DRAFT");
    await run("submit");
    expect((await run("approve")).status).toBe("APPROVED");
    // No time given: the planned time is used.
    expect((await run("schedule")).status).toBe("SCHEDULED");
    expect((await getContent(db, ctx, contentId)).scheduledAt?.toISOString()).toBe(
      "2099-01-15T07:30:00.000Z",
    );
    expect((await run("unschedule")).status).toBe("APPROVED");
    await run("schedule", "2099-02-01T09:00");
    const now = new Date("2030-01-01T00:00:00Z");
    expect(
      (
        await transitionContent(
          db,
          ctx,
          { contentId, transition: "publish", scheduledAt: null },
          now,
        )
      ).status,
    ).toBe("PUBLISHED");
    const published = await getContent(db, ctx, contentId);
    expect(published.publishedAt?.toISOString()).toBe(now.toISOString());
    expect(published.transitions).toEqual([]);
    expect(published.canEdit).toBe(false);
    expect(published.canReschedule).toBe(false);

    for (const transition of [
      "submit",
      "withdraw",
      "approve",
      "reopen",
      "schedule",
      "unschedule",
      "publish",
    ] as const) {
      await expectCode(run(transition, FUTURE), "CONFLICT", "invalid_transition");
    }
    await expectCode(
      rescheduleContent(db, ctx, { contentId, scheduledAt: FUTURE }),
      "CONFLICT",
      "invalid_transition",
    );
    const changes = await system.auditLog.findMany({
      where: { workspaceId: ctx.workspaceId, action: "content.status_changed" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(changes.map((row) => row.metadata)).toEqual([
      { transition: "submit", from: "DRAFT", to: "IN_REVIEW" },
      { transition: "request_changes", from: "IN_REVIEW", to: "DRAFT" },
      { transition: "submit", from: "DRAFT", to: "IN_REVIEW" },
      { transition: "approve", from: "IN_REVIEW", to: "APPROVED" },
      { transition: "schedule", from: "APPROVED", to: "SCHEDULED" },
      { transition: "unschedule", from: "SCHEDULED", to: "APPROVED" },
      { transition: "schedule", from: "APPROVED", to: "SCHEDULED" },
      { transition: "publish", from: "SCHEDULED", to: "PUBLISHED" },
    ]);
  });

  it("rejects invalid transitions and schedules without changing anything", async () => {
    const ctx = await createTenant(system);
    const { contentId } = await createContent(db, ctx, contentFields());
    const run = (transition: ContentTransition, scheduledAt: string | null = null) =>
      transitionContent(db, ctx, { contentId, transition, scheduledAt });
    await expectCode(run("approve"), "CONFLICT", "invalid_transition");
    await expectCode(run("publish"), "CONFLICT", "invalid_transition");
    await run("submit");
    await run("approve");
    await expectCode(run("schedule"), "VALIDATION_FAILED", "schedule_required");
    await expectCode(run("schedule", "2000-01-01T10:00"), "VALIDATION_FAILED", "schedule_in_past");
    await expectCode(run("schedule", "2099-02-30T10:00"), "VALIDATION_FAILED", "invalid_format");
    const item = await getContent(db, ctx, contentId);
    expect(item.status).toBe("APPROVED");
    expect(item.scheduledAt).toBeNull();
  });

  it("only drafts can be edited; edits are conditional on still being a draft", async () => {
    const ctx = await createTenant(system);
    const { contentId } = await createContent(db, ctx, contentFields());
    await updateContent(db, ctx, contentId, contentFields({ title: "v2", hashtags: "#a" }));
    expect((await getContent(db, ctx, contentId)).title).toBe("v2");
    await transitionContent(db, ctx, { contentId, transition: "submit", scheduledAt: null });
    await expectCode(
      updateContent(db, ctx, contentId, contentFields({ title: "v3" })),
      "CONFLICT",
      "content_locked",
    );
    expect((await getContent(db, ctx, contentId)).title).toBe("v2");
  });

  it("two concurrent transitions from the same status: exactly one applies", async () => {
    const ctx = await createTenant(system);
    const { contentId } = await createContent(db, ctx, contentFields());
    await transitionContent(db, ctx, { contentId, transition: "submit", scheduledAt: null });
    const results = await Promise.allSettled([
      transitionContent(db, ctx, { contentId, transition: "approve", scheduledAt: null }),
      transitionContent(db, ctx, { contentId, transition: "request_changes", scheduledAt: null }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" &&
        rejected.reason instanceof AppError &&
        rejected.reason.code,
    ).toBe("CONFLICT");
    expect(
      await system.auditLog.count({
        where: { workspaceId: ctx.workspaceId, action: "content.status_changed" },
      }),
    ).toBe(2);
  });

  it("the database enforces schedule and publish invariants", async () => {
    const ctx = await createTenant(system);
    const { contentId } = await createContent(db, ctx, contentFields());
    await expect(
      system.contentItem.update({ where: { id: contentId }, data: { status: "SCHEDULED" } }),
    ).rejects.toThrow();
    await expect(
      system.contentItem.update({ where: { id: contentId }, data: { status: "PUBLISHED" } }),
    ).rejects.toThrow();
    await expect(
      system.contentItem.update({ where: { id: contentId }, data: { publishedAt: new Date() } }),
    ).rejects.toThrow();
  });
});

// ── calendar, dashboard, activity ────────────────────────────────────────────

describe("calendar", () => {
  it("places planned, scheduled and published items on workspace-time-zone days", async () => {
    const ctx = await createTenant(system);
    const planned = await createContent(
      db,
      ctx,
      contentFields({ title: "Planned", plannedAt: "2030-01-15T23:30" }),
    );
    const scheduled = await createContent(db, ctx, contentFields({ title: "Scheduled" }));
    await system.contentItem.update({
      where: { id: scheduled.contentId },
      data: { status: "SCHEDULED", scheduledAt: new Date("2030-01-13T21:00:00Z") }, // Jan 14 00:00 Riyadh
    });
    const published = await createContent(db, ctx, contentFields({ title: "Published" }));
    await system.contentItem.update({
      where: { id: published.contentId },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date("2030-01-19T20:59:00Z"),
        scheduledAt: null,
      },
    });
    await createContent(
      db,
      ctx,
      contentFields({ title: "Next week", plannedAt: "2030-01-20T00:00" }),
    );
    await createContent(db, ctx, contentFields({ title: "Unplanned" }));

    const week = await getCalendar(
      db,
      ctx,
      { view: "week", date: "2030-01-15" },
      new Date("2030-01-15T12:00:00Z"),
    );
    expect(week.timeZone).toBe("Asia/Riyadh");
    expect(week.today).toBe("2030-01-15");
    expect(week.items.map((item) => `${item.title}@${item.dateKey}`)).toEqual([
      "Scheduled@2030-01-14",
      "Planned@2030-01-15",
      "Published@2030-01-19",
    ]);
    expect(week.items.map((item) => item.canReschedule)).toEqual([true, true, false]);
    expect(planned.contentId).toBeDefined();

    const day = await getCalendar(db, ctx, { view: "day", date: "2030-01-20" });
    expect(day.items.map((item) => item.title)).toEqual(["Next week"]);
    // An unusable date falls back to today.
    const fallback = await getCalendar(
      db,
      ctx,
      { view: "day", date: "2030-02-31" },
      new Date("2030-03-01T12:00:00Z"),
    );
    expect(fallback.date).toBe("2030-03-01");
  });

  it("uses the workspace's own time zone", async () => {
    const ctx = await createTenant(system);
    await system.workspace.update({
      where: { id: ctx.workspaceId },
      data: { timezone: "America/New_York" },
    });
    await createContent(db, ctx, contentFields({ title: "NY", plannedAt: "2030-01-15T23:30" }));
    const item = await system.contentItem.findFirstOrThrow({
      where: { workspaceId: ctx.workspaceId },
    });
    expect(item.scheduledAt?.toISOString()).toBe("2030-01-16T04:30:00.000Z");
    const week = await getCalendar(db, ctx, { view: "day", date: "2030-01-15" });
    expect(week.items.map((entry) => entry.dateKey)).toEqual(["2030-01-15"]);
  });
});

describe("dashboard and activity", () => {
  it("shows each section only to roles that may see it", async () => {
    const owner = await createTenant(system);
    await seedWorkspace(owner);
    const full = await getDashboard(db, owner);
    expect(full.setup).toEqual({
      brand: false,
      audiences: 1,
      pillars: 1,
      goals: 1,
      campaigns: 1,
      content: 1,
    });
    expect(full.content?.byStatus.DRAFT).toBe(1);
    expect(full.campaigns?.list).toHaveLength(0);
    expect(full.activity?.length).toBeGreaterThan(0);

    const client = await getDashboard(db, await memberOf(owner, WorkspaceRole.CLIENT));
    expect(client.activity).toBeNull();
    expect(client.content).not.toBeNull();
    expect(client.can).toEqual({ editBrand: false, createContent: false, manageCampaigns: false });
  });

  it("lists activity newest first, paginated, with status names only", async () => {
    const ctx = await createTenant(system);
    const { contentId } = await createContent(db, ctx, contentFields());
    await transitionContent(db, ctx, { contentId, transition: "submit", scheduledAt: null });
    for (let index = 0; index < 3; index += 1) {
      await createAudience(db, ctx, audienceFields({ name: `A${String(index)}` }));
    }
    const first = await listActivity(db, ctx, { limit: 2 });
    expect(first.entries.map((entry) => entry.action)).toEqual([
      "audience.created",
      "audience.created",
    ]);
    expect(first.next).not.toBeNull();
    const second = await listActivity(db, ctx, { limit: 10, before: first.next ?? undefined });
    expect(second.entries.map((entry) => entry.action)).toEqual([
      "audience.created",
      "content.status_changed",
      "content.created",
    ]);
    expect(second.entries[1]).toMatchObject({
      from: "DRAFT",
      to: "IN_REVIEW",
      entityId: contentId,
    });
    expect(second.next).toBeNull();
    // A foreign cursor is ignored (no cross-workspace probing).
    const other = await createTenant(system);
    expect((await listActivity(db, other, { before: first.next ?? undefined })).entries).toEqual(
      [],
    );
  });
});

// ── media ────────────────────────────────────────────────────────────────────

describe("media", () => {
  it("stores sniffed images under the workspace prefix and serves them back", async () => {
    const ctx = await createTenant(system);
    const storage = new MemoryStorageService();
    const { assetId } = await uploadMedia(
      db,
      storage,
      ctx,
      pngFile("../../evil‮.png", png(640, 480)),
      "Cup",
    );
    const [asset] = await listMedia(db, ctx);
    expect(asset).toMatchObject({
      filename: "evil.png",
      contentType: "image/png",
      width: 640,
      height: 480,
      altText: "Cup",
    });
    const row = await system.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(row.storageKey).toMatch(
      new RegExp(`^workspaces/${ctx.workspaceId}/content-media/[0-9a-f-]{36}\\.png$`),
    );
    expect(row.storageKey).not.toContain("evil");
    const served = await readMedia(db, storage, ctx, assetId);
    expect(served.contentType).toBe("image/png");
    expect(served.body.byteLength).toBe(40);
  });

  it("rejects non-images, empty and oversized files without storing anything", async () => {
    const ctx = await createTenant(system);
    const storage = new MemoryStorageService();
    const svg = new Uint8Array(Buffer.from("<svg onload=alert(1)>"));
    await expectCode(
      uploadMedia(db, storage, ctx, pngFile("x.png", svg)),
      "UNSUPPORTED_MEDIA_TYPE",
      "image_invalid",
    );
    await expectCode(
      uploadMedia(db, storage, ctx, pngFile("x.png", new Uint8Array())),
      "VALIDATION_FAILED",
      "file_required",
    );
    let read = false;
    const huge = {
      name: "x.png",
      size: 10 * 1024 * 1024 + 1,
      bytes: () => {
        read = true;
        return Promise.resolve(png());
      },
    };
    await expectCode(uploadMedia(db, storage, ctx, huge), "PAYLOAD_TOO_LARGE");
    expect(read).toBe(false);
    expect(storage.objects.size).toBe(0);
    expect(await system.mediaAsset.count()).toBe(0);
  });

  it("removes the stored object when the row cannot be written", async () => {
    const ctx = await createTenant(system);
    const storage = new MemoryStorageService();
    await system.workspace.update({
      where: { id: ctx.workspaceId },
      data: { deletedAt: new Date() },
    });
    const broken: TenantContext = { ...ctx, workspaceId: crypto.randomUUID() };
    await expect(uploadMedia(db, storage, broken, pngFile())).rejects.toThrow();
    expect(storage.objects.size).toBe(0);
  });

  it("deletes the row, its content links and the stored object", async () => {
    const ctx = await createTenant(system);
    const s = await seedWorkspace(ctx);
    expect((await getContent(db, ctx, s.contentId)).assets).toHaveLength(1);
    await deleteMedia(db, s.storage, ctx, s.assetId);
    expect((await getContent(db, ctx, s.contentId)).assets).toHaveLength(0);
    expect(s.storage.objects.size).toBe(0);
    await expectCode(readMedia(db, s.storage, ctx, s.assetId), "NOT_FOUND");
    expect(await auditActions(ctx)).toContain("asset.deleted");
  });
});
