import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole, WorkspaceType } from "@/generated/prisma/enums";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

describe("database constraints (PostgreSQL)", () => {
  it("generates UUID primary keys in the database", async () => {
    const user = await system.user.create({
      data: { email: "uuid@test.flexibx.local", name: "U" },
    });
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("treats emails case-insensitively (citext unique)", async () => {
    await system.user.create({ data: { email: "Sara@Example.com", name: "Sara" } });
    await expect(
      system.user.create({ data: { email: "sara@example.com", name: "Dup" } }),
    ).rejects.toThrow();
    expect(await system.user.findUnique({ where: { email: "SARA@EXAMPLE.COM" } })).not.toBeNull();
  });

  it.each(["Bad-Slug", "ab", "has space", "a".repeat(49), "عربي"])(
    "rejects invalid slug %j",
    async (slug) => {
      await expect(system.workspace.create({ data: { name: "W", slug } })).rejects.toThrow(
        /workspaces_slug_format_check/,
      );
    },
  );

  it("accepts valid slugs", async () => {
    await expect(
      system.workspace.create({ data: { name: "W", slug: "my-store-2" } }),
    ).resolves.toBeDefined();
  });

  it("prevents a workspace from being its own parent", async () => {
    const ws = await system.workspace.create({
      data: { name: "A", slug: "self-parent", type: WorkspaceType.AGENCY },
    });
    await expect(
      system.workspace.update({ where: { id: ws.id }, data: { parentWorkspaceId: ws.id } }),
    ).rejects.toThrow(/workspaces_parent_not_self_check/);
  });

  it("prevents duplicate memberships", async () => {
    const tenant = await createTenant(system);
    await expect(
      system.workspaceMember.create({
        data: { workspaceId: tenant.workspaceId, userId: tenant.userId, role: WorkspaceRole.ADMIN },
      }),
    ).rejects.toThrow();
  });

  it("blocks hard-deleting a workspace that has audit history (ON DELETE RESTRICT)", async () => {
    const tenant = await createTenant(system);
    await system.auditLog.create({
      data: {
        workspaceId: tenant.workspaceId,
        action: "workspace.created",
        entityType: "workspace",
      },
    });
    await expect(system.workspace.delete({ where: { id: tenant.workspaceId } })).rejects.toThrow();
    expect(await system.auditLog.count({ where: { workspaceId: tenant.workspaceId } })).toBe(1);
  });

  it("blocks hard-deleting an agency that still has client workspaces", async () => {
    const agency = await createTenant(system, { type: WorkspaceType.AGENCY });
    await createTenant(system, { parentWorkspaceId: agency.workspaceId });
    await expect(system.workspace.delete({ where: { id: agency.workspaceId } })).rejects.toThrow();
  });

  it("cascades memberships when a workspace without audit history is purged", async () => {
    const tenant = await createTenant(system);
    await system.workspace.delete({ where: { id: tenant.workspaceId } });
    expect(await system.workspaceMember.count({ where: { workspaceId: tenant.workspaceId } })).toBe(
      0,
    );
  });

  it("keeps audit rows but clears the actor when a user is deleted", async () => {
    const tenant = await createTenant(system);
    const log = await system.auditLog.create({
      data: {
        workspaceId: tenant.workspaceId,
        actorUserId: tenant.userId,
        action: "member.added",
        entityType: "member",
      },
    });
    await system.user.delete({ where: { id: tenant.userId } });
    expect(
      (await system.auditLog.findUniqueOrThrow({ where: { id: log.id } })).actorUserId,
    ).toBeNull();
  });
});
