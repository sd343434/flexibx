import { WorkspaceRole } from "@/generated/prisma/enums";

export { WorkspaceRole };
export type Role = WorkspaceRole;

export const ROLES: readonly Role[] = Object.values(WorkspaceRole);

/**
 * Internal team roles from most to least privileged. CLIENT is deliberately NOT in
 * this hierarchy: it is an external role (an agency's customer) with its own narrow
 * permission set and is never "above" or "below" a team role.
 */
export const TEAM_ROLE_HIERARCHY = [
  WorkspaceRole.OWNER,
  WorkspaceRole.ADMIN,
  WorkspaceRole.MANAGER,
  WorkspaceRole.EDITOR,
  WorkspaceRole.VIEWER,
] as const satisfies readonly Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
