import { describe, expect, it } from "vitest";

import { AppError } from "@/server/errors/app-error";
import {
  ACTIONS,
  assertCan,
  can,
  canAssignRole,
  ROLE_PERMISSIONS,
  type Action,
} from "@/server/tenancy/permissions";
import { ROLES, TEAM_ROLE_HIERARCHY, WorkspaceRole } from "@/server/tenancy/roles";

describe("permission matrix", () => {
  it("defines permissions for every role using only known actions", () => {
    for (const role of ROLES) {
      for (const action of ROLE_PERMISSIONS[role]) expect(ACTIONS).toContain(action);
    }
  });

  it("is monotonic across the team hierarchy (higher roles keep lower roles' rights)", () => {
    for (let index = 0; index < TEAM_ROLE_HIERARCHY.length - 1; index += 1) {
      const higher = TEAM_ROLE_HIERARCHY[index];
      const lower = TEAM_ROLE_HIERARCHY[index + 1];
      if (higher === undefined || lower === undefined) throw new Error("hierarchy index");
      for (const action of ROLE_PERMISSIONS[lower]) expect(can(higher, action)).toBe(true);
    }
  });

  it("gives OWNER every action", () => {
    for (const action of ACTIONS) expect(can(WorkspaceRole.OWNER, action)).toBe(true);
  });

  it.each<[WorkspaceRole, Action, boolean]>([
    [WorkspaceRole.ADMIN, "workspace.delete", false],
    [WorkspaceRole.ADMIN, "billing.manage", false],
    [WorkspaceRole.ADMIN, "member.invite", true],
    [WorkspaceRole.MANAGER, "content.publish", true],
    [WorkspaceRole.MANAGER, "member.invite", false],
    [WorkspaceRole.EDITOR, "content.create", true],
    [WorkspaceRole.EDITOR, "content.approve", false],
    [WorkspaceRole.VIEWER, "content.view", true],
    [WorkspaceRole.VIEWER, "content.create", false],
    [WorkspaceRole.CLIENT, "content.approve", true],
    [WorkspaceRole.CLIENT, "content.view", true],
    [WorkspaceRole.CLIENT, "content.create", false],
    [WorkspaceRole.CLIENT, "member.view", false],
    [WorkspaceRole.CLIENT, "audit.view", false],
    [WorkspaceRole.CLIENT, "billing.view", false],
  ])("%s → %s = %s", (role, action, expected) => {
    expect(can(role, action)).toBe(expected);
  });

  it("assertCan throws FORBIDDEN without leaking into a 500", () => {
    expect(() => {
      assertCan({ role: WorkspaceRole.VIEWER }, "brand.edit");
    }).toThrow(AppError);
    try {
      assertCan({ role: WorkspaceRole.VIEWER }, "brand.edit");
    } catch (error) {
      expect((error as AppError).code).toBe("FORBIDDEN");
      expect((error as AppError).httpStatus).toBe(403);
    }
    expect(() => {
      assertCan({ role: WorkspaceRole.EDITOR }, "brand.edit");
    }).not.toThrow();
  });

  it("restricts role assignment", () => {
    expect(canAssignRole(WorkspaceRole.OWNER, WorkspaceRole.OWNER)).toBe(true);
    expect(canAssignRole(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)).toBe(false);
    expect(canAssignRole(WorkspaceRole.ADMIN, WorkspaceRole.EDITOR)).toBe(true);
    expect(canAssignRole(WorkspaceRole.MANAGER, WorkspaceRole.VIEWER)).toBe(false);
    expect(canAssignRole(WorkspaceRole.CLIENT, WorkspaceRole.CLIENT)).toBe(false);
  });
});
