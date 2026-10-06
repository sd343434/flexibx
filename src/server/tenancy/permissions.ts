import { AppError } from "../errors/app-error";
import { WorkspaceRole, type Role } from "./roles";

/**
 * Central permission matrix — the ONLY place that decides what a role may do.
 * Services call `assertCan(ctx, action)`; UI may call `can()` to hide controls, but the
 * server-side check is always authoritative. Actions are added here as modules ship.
 */
export const ACTIONS = [
  "workspace.view",
  "workspace.update",
  "workspace.delete",
  "member.view",
  "member.invite",
  "member.updateRole",
  "member.remove",
  "brand.view",
  "brand.edit",
  "content.view",
  "content.create",
  "content.edit",
  "content.approve",
  "content.publish",
  "campaign.view",
  "campaign.manage",
  "analytics.view",
  "billing.view",
  "billing.manage",
  "audit.view",
] as const;

export type Action = (typeof ACTIONS)[number];

const VIEW_ACTIONS = [
  "workspace.view",
  "member.view",
  "brand.view",
  "content.view",
  "campaign.view",
  "analytics.view",
] as const satisfies readonly Action[];

const EDITOR_ACTIONS = [
  ...VIEW_ACTIONS,
  "brand.edit",
  "content.create",
  "content.edit",
] as const satisfies readonly Action[];

const MANAGER_ACTIONS = [
  ...EDITOR_ACTIONS,
  "content.approve",
  "content.publish",
  "campaign.manage",
] as const satisfies readonly Action[];

const ADMIN_ACTIONS = [
  ...MANAGER_ACTIONS,
  "workspace.update",
  "member.invite",
  "member.updateRole",
  "member.remove",
  "billing.view",
  "audit.view",
] as const satisfies readonly Action[];

const OWNER_ACTIONS = [
  ...ADMIN_ACTIONS,
  "workspace.delete",
  "billing.manage",
] as const satisfies readonly Action[];

/** External agency client: can see their brand, content and results, and approve content. */
const CLIENT_ACTIONS = [
  "workspace.view",
  "brand.view",
  "content.view",
  "content.approve",
  "campaign.view",
  "analytics.view",
] as const satisfies readonly Action[];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Action>>> = {
  [WorkspaceRole.OWNER]: new Set(OWNER_ACTIONS),
  [WorkspaceRole.ADMIN]: new Set(ADMIN_ACTIONS),
  [WorkspaceRole.MANAGER]: new Set(MANAGER_ACTIONS),
  [WorkspaceRole.EDITOR]: new Set(EDITOR_ACTIONS),
  [WorkspaceRole.VIEWER]: new Set(VIEW_ACTIONS),
  [WorkspaceRole.CLIENT]: new Set(CLIENT_ACTIONS),
};

export function can(role: Role, action: Action): boolean {
  return ROLE_PERMISSIONS[role].has(action);
}

export function assertCan(subject: { readonly role: Role }, action: Action): void {
  if (!can(subject.role, action)) {
    throw new AppError("FORBIDDEN", {
      message: `Role ${subject.role} may not perform ${action}`,
      metadata: { role: subject.role, action },
    });
  }
}

/**
 * Who may grant which role. Only an OWNER can create another OWNER; ADMINs can grant
 * any non-owner role. Nobody else manages roles.
 */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === WorkspaceRole.OWNER) return true;
  if (actor === WorkspaceRole.ADMIN) return target !== WorkspaceRole.OWNER;
  return false;
}
