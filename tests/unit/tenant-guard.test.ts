import { describe, expect, it } from "vitest";

import { AppError } from "@/server/errors/app-error";
import { assertTenantSafe, hasWorkspaceScope } from "@/server/db/tenant-guard";

const WS = "6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10";
const USER = "0d6f4a52-1b6e-4b0c-9a55-2f4f0a1d9e33";

function rejects(model: string, operation: string, args: unknown) {
  try {
    assertTenantSafe(model, operation, args);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("TENANT_SCOPE_MISSING");
    return;
  }
  throw new Error(`${model}.${operation} should have been rejected`);
}

describe("hasWorkspaceScope", () => {
  it("accepts a concrete workspace id, equals form and compound unique keys", () => {
    expect(hasWorkspaceScope({ workspaceId: WS }, "required")).toBe(true);
    expect(hasWorkspaceScope({ workspaceId: { equals: WS } }, "required")).toBe(true);
    expect(
      hasWorkspaceScope({ workspaceId_userId: { workspaceId: WS, userId: USER } }, "required"),
    ).toBe(true);
  });

  it("rejects missing, empty, multi-workspace and null scopes", () => {
    expect(hasWorkspaceScope(undefined, "required")).toBe(false);
    expect(hasWorkspaceScope({}, "required")).toBe(false);
    expect(hasWorkspaceScope({ workspaceId: "" }, "required")).toBe(false);
    expect(hasWorkspaceScope({ workspaceId: { in: [WS] } }, "required")).toBe(false);
    expect(hasWorkspaceScope({ workspaceId: { not: WS } }, "required")).toBe(false);
    expect(hasWorkspaceScope({ workspaceId: null }, "required")).toBe(false);
    expect(hasWorkspaceScope({ OR: [{ workspaceId: WS }] }, "required")).toBe(false);
  });

  it("allows an explicit null only for nullable tenant models", () => {
    expect(hasWorkspaceScope({ workspaceId: null }, "nullable")).toBe(true);
  });
});

describe("assertTenantSafe — workspace-owned models", () => {
  it.each([
    "findMany",
    "findFirst",
    "findFirstOrThrow",
    "findUnique",
    "count",
    "aggregate",
    "groupBy",
    "updateMany",
    "deleteMany",
    "update",
    "delete",
  ])("WorkspaceMember.%s requires where.workspaceId", (operation) => {
    rejects("WorkspaceMember", operation, { where: { userId: USER } });
    rejects("WorkspaceMember", operation, {});
    expect(() => {
      assertTenantSafe("WorkspaceMember", operation, { where: { workspaceId: WS, userId: USER } });
    }).not.toThrow();
  });

  it("requires workspaceId on every created row", () => {
    rejects("WorkspaceMember", "create", { data: { userId: USER, role: "OWNER" } });
    rejects("WorkspaceMember", "createMany", {
      data: [{ workspaceId: WS, userId: USER }, { userId: USER }],
    });
    expect(() => {
      assertTenantSafe("WorkspaceMember", "createMany", {
        data: [{ workspaceId: WS, userId: USER, role: "OWNER" }],
      });
    }).not.toThrow();
  });

  it("forbids moving records to another workspace", () => {
    rejects("WorkspaceMember", "update", {
      where: { workspaceId: WS, id: USER },
      data: { workspaceId: USER },
    });
    rejects("WorkspaceMember", "updateMany", {
      where: { workspaceId: WS },
      data: { workspace: { connect: { id: USER } } },
    });
    rejects("WorkspaceMember", "upsert", {
      where: { workspaceId_userId: { workspaceId: WS, userId: USER } },
      update: { workspaceId: USER },
      create: { workspaceId: WS, userId: USER, role: "OWNER" },
    });
  });

  it("validates both halves of an upsert", () => {
    rejects("WorkspaceMember", "upsert", {
      where: { workspaceId_userId: { workspaceId: WS, userId: USER } },
      update: { role: "ADMIN" },
      create: { userId: USER, role: "ADMIN" },
    });
    expect(() => {
      assertTenantSafe("WorkspaceMember", "upsert", {
        where: { workspaceId_userId: { workspaceId: WS, userId: USER } },
        update: { role: "ADMIN" },
        create: { workspaceId: WS, userId: USER, role: "ADMIN" },
      });
    }).not.toThrow();
  });
});

describe("assertTenantSafe — AuditLog", () => {
  it("is append-only", () => {
    for (const operation of ["update", "updateMany", "upsert", "delete", "deleteMany"]) {
      rejects("AuditLog", operation, { where: { workspaceId: WS }, data: {} });
    }
  });

  it("requires an explicit scope (workspace id, or null for platform events)", () => {
    rejects("AuditLog", "findMany", {});
    rejects("AuditLog", "create", { data: { action: "x", entityType: "y" } });
    expect(() => {
      assertTenantSafe("AuditLog", "findMany", { where: { workspaceId: WS } });
      assertTenantSafe("AuditLog", "findMany", { where: { workspaceId: null } });
      assertTenantSafe("AuditLog", "create", {
        data: { workspaceId: null, action: "x", entityType: "y" },
      });
    }).not.toThrow();
  });
});

describe("assertTenantSafe — Workspace (tenant root)", () => {
  it("blocks hard deletes (soft delete only)", () => {
    rejects("Workspace", "delete", { where: { id: WS } });
    rejects("Workspace", "deleteMany", { where: { id: WS } });
  });

  it("requires reads and updates to target a single workspace by id", () => {
    rejects("Workspace", "findMany", {});
    rejects("Workspace", "findFirst", { where: { slug: "acme" } });
    rejects("Workspace", "updateMany", { where: { deletedAt: null }, data: {} });
    expect(() => {
      assertTenantSafe("Workspace", "findFirst", { where: { id: WS, deletedAt: null } });
      assertTenantSafe("Workspace", "create", { data: { name: "n", slug: "new-ws" } });
    }).not.toThrow();
  });
});

describe("assertTenantSafe — global models", () => {
  it("blocks reaching tenant data through User relations", () => {
    rejects("User", "findMany", { include: { memberships: true } });
    rejects("User", "findUnique", { where: { id: USER }, select: { auditLogs: true } });
    rejects("User", "update", {
      where: { id: USER },
      data: { memberships: { create: { workspaceId: WS, role: "OWNER" } } },
    });
    expect(() => {
      assertTenantSafe("User", "findUnique", {
        where: { id: USER },
        select: { id: true, memberships: false },
      });
      assertTenantSafe("User", "findUnique", { where: { id: USER } });
    }).not.toThrow();
  });
});
