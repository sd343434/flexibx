import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listAuditLogs, recordAudit } from "@/server/audit/audit-log";
import { REDACTED } from "@/server/redact";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

describe("audit logging", () => {
  it("records workspace events with redacted metadata", async () => {
    const tenant = await createTenant(system);
    const entry = await recordAudit(db, tenant, {
      action: "member.added",
      entityType: "member",
      entityId: tenant.userId,
      metadata: { invitedEmail: "new@example.com", accessToken: "should-not-be-stored" },
      userAgent: "x".repeat(1000),
    });
    expect(entry.workspaceId).toBe(tenant.workspaceId);
    expect(entry.metadata).toEqual({ invitedEmail: "new@example.com", accessToken: REDACTED });
    expect(entry.userAgent).toHaveLength(512);
  });

  it("records platform-level events without a workspace", async () => {
    const tenant = await createTenant(system);
    const entry = await recordAudit(
      db,
      { workspaceId: null, userId: tenant.userId },
      {
        action: "workspace.created",
        entityType: "workspace",
      },
    );
    expect(entry.workspaceId).toBeNull();
  });

  it("lists only the context workspace's entries, newest first, with pagination", async () => {
    const alpha = await createTenant(system);
    const beta = await createTenant(system);
    for (let index = 0; index < 3; index += 1) {
      await recordAudit(db, alpha, {
        action: "workspace.updated",
        entityType: "workspace",
        metadata: { index },
      });
    }
    await recordAudit(db, beta, { action: "workspace.updated", entityType: "workspace" });

    const firstPage = await listAuditLogs(db, alpha, { limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(firstPage.every((entry) => entry.workspaceId === alpha.workspaceId)).toBe(true);
    expect(firstPage[0]?.metadata).toEqual({ index: 2 });

    const cursor = firstPage[1]?.id;
    if (cursor === undefined) throw new Error("expected a second entry");
    const secondPage = await listAuditLogs(db, alpha, { limit: 2, cursor });
    expect(secondPage.map((entry) => entry.metadata)).toEqual([{ index: 0 }]);
  });
});
