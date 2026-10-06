import { describe, expect, it } from "vitest";

import { AppError } from "@/server/errors/app-error";
import {
  assertSameWorkspace,
  createTenantContext,
  isUuid,
  scopedWhere,
} from "@/server/tenancy/context";
import { WorkspaceRole } from "@/server/tenancy/roles";

const ctx = createTenantContext({
  userId: "0d6f4a52-1b6e-4b0c-9a55-2f4f0a1d9e33",
  workspaceId: "6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10",
  role: WorkspaceRole.EDITOR,
});

describe("tenant context", () => {
  it("is immutable", () => {
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("rejects non-UUID identifiers", () => {
    expect(() => createTenantContext({ ...ctx, workspaceId: "1 OR 1=1" })).toThrow(AppError);
    expect(isUuid("6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10")).toBe(true);
    expect(isUuid("6b1f8e1e")).toBe(false);
  });

  it("scopedWhere always pins the context workspace, even if the caller passes another", () => {
    expect(scopedWhere(ctx)).toEqual({ workspaceId: ctx.workspaceId });
    expect(scopedWhere(ctx, { id: "x", workspaceId: "attacker-workspace" })).toEqual({
      id: "x",
      workspaceId: ctx.workspaceId,
    });
  });

  it("assertSameWorkspace reports foreign or missing records as NOT_FOUND", () => {
    expect(() => {
      assertSameWorkspace(ctx, { workspaceId: ctx.workspaceId });
    }).not.toThrow();
    for (const record of [
      null,
      { workspaceId: "11111111-1111-1111-1111-111111111111" },
      { workspaceId: null },
    ]) {
      try {
        assertSameWorkspace(ctx, record);
        expect.unreachable();
      } catch (error) {
        expect((error as AppError).code).toBe("NOT_FOUND");
      }
    }
  });
});
