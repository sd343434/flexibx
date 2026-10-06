import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole, WorkspaceType } from "@/generated/prisma/enums";
import { AppError } from "@/server/errors/app-error";
import {
  findMember,
  listMembers,
  listMembershipsForUser,
} from "@/server/workspaces/member-repository";
import { getWorkspace, softDeleteWorkspace } from "@/server/workspaces/workspace-service";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (error) => error instanceof AppError && error.code === code,
  );
}

describe("tenant guard on a real Prisma client", () => {
  it("rejects unscoped queries on workspace-owned models before they reach the database", async () => {
    await createTenant(system);
    await expectCode(db.workspaceMember.findMany(), "TENANT_SCOPE_MISSING");
    await expectCode(db.workspaceMember.count(), "TENANT_SCOPE_MISSING");
    await expectCode(db.auditLog.findMany(), "TENANT_SCOPE_MISSING");
    await expectCode(db.workspace.findMany(), "TENANT_SCOPE_MISSING");
  });

  it("blocks hard deletes of workspaces and any mutation of audit logs", async () => {
    const tenant = await createTenant(system);
    await expectCode(
      db.workspace.delete({ where: { id: tenant.workspaceId } }),
      "TENANT_SCOPE_MISSING",
    );
    await expectCode(
      db.auditLog.deleteMany({ where: { workspaceId: tenant.workspaceId } }),
      "TENANT_SCOPE_MISSING",
    );
    await expectCode(
      db.auditLog.updateMany({
        where: { workspaceId: tenant.workspaceId },
        data: { action: "tampered" },
      }),
      "TENANT_SCOPE_MISSING",
    );
  });

  it("keeps enforcing inside interactive transactions", async () => {
    await createTenant(system);
    await expectCode(
      db.$transaction(async (tx) => tx.workspaceMember.findMany()),
      "TENANT_SCOPE_MISSING",
    );
  });

  it("blocks reaching memberships through the global User model", async () => {
    const tenant = await createTenant(system);
    await expectCode(
      db.user.findUnique({ where: { id: tenant.userId }, include: { memberships: true } }),
      "TENANT_SCOPE_MISSING",
    );
  });
});

describe("workspace-scoped repositories", () => {
  it("only return members of the context's workspace", async () => {
    const alpha = await createTenant(system);
    const beta = await createTenant(system);
    const alphaMembers = await listMembers(db, alpha);
    expect(alphaMembers.map((member) => member.workspaceId)).toEqual([alpha.workspaceId]);
    expect(alphaMembers.map((member) => member.userId)).not.toContain(beta.userId);
  });

  it("cannot read another workspace's member by id (reported as not found)", async () => {
    const alpha = await createTenant(system);
    const beta = await createTenant(system);
    const [betaMember] = await listMembers(db, beta);
    if (betaMember === undefined) throw new Error("expected a member");
    expect(await findMember(db, alpha, betaMember.id)).toBeNull();
    expect((await findMember(db, beta, betaMember.id))?.id).toBe(betaMember.id);
  });

  it("enforces permissions in services, not only in the UI", async () => {
    const client = await createTenant(system, { role: WorkspaceRole.CLIENT });
    await expectCode(listMembers(db, client), "FORBIDDEN");
  });

  it("lists a user's own memberships through the reviewed system path", async () => {
    const agency = await createTenant(system, { type: WorkspaceType.AGENCY });
    const client = await createTenant(system, { parentWorkspaceId: agency.workspaceId });
    await system.workspaceMember.create({
      data: { workspaceId: client.workspaceId, userId: agency.userId, role: WorkspaceRole.ADMIN },
    });
    const memberships = await listMembershipsForUser(system, agency.userId);
    expect(memberships.map((membership) => membership.workspace.id).sort()).toEqual(
      [agency.workspaceId, client.workspaceId].sort(),
    );
  });
});

describe("workspace soft deletion", () => {
  it("only an OWNER may delete a workspace", async () => {
    const admin = await createTenant(system, { role: WorkspaceRole.ADMIN });
    await expectCode(softDeleteWorkspace(db, admin), "FORBIDDEN");
  });

  it("marks the workspace deleted, keeps its data and writes an audit entry atomically", async () => {
    const owner = await createTenant(system);
    await softDeleteWorkspace(db, owner, { ip: "203.0.113.7", userAgent: "vitest" });

    const row = await system.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(await system.workspaceMember.count({ where: { workspaceId: owner.workspaceId } })).toBe(
      1,
    );

    const audit = await system.auditLog.findMany({ where: { workspaceId: owner.workspaceId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "workspace.soft_deleted",
      actorUserId: owner.userId,
      ip: "203.0.113.7",
    });

    await expectCode(getWorkspace(db, owner), "NOT_FOUND");
    await expectCode(softDeleteWorkspace(db, owner), "NOT_FOUND");
    expect(await listMembershipsForUser(system, owner.userId)).toEqual([]);
  });
});
