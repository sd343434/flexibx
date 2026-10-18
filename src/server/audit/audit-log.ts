import type { Prisma } from "@/generated/prisma/client";

import type { Db } from "../db/types";
import { redactSecrets } from "../redact";
import type { TenantContext } from "../tenancy/context";

/** Audit actions. Extend as modules ship; names are `<entity>.<past_tense_verb>`. */
export const AUDIT_ACTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.soft_deleted",
  "member.added",
  "member.role_changed",
  "member.removed",
  "member.left",
  "member.invited",
  "invitation.revoked",
  "invitation.accepted",
  "user.email_verified",
  "user.password_reset_requested",
  "user.password_reset",
  "user.password_changed",
  // Two-factor authentication. Metadata: method ("totp" | "backup_code") only — never
  // secrets, codes or URIs.
  "user.mfa_enabled",
  "user.mfa_disabled",
  "user.mfa_backup_codes_regenerated",
  "user.mfa_sign_in",
  "user.mfa_reset_by_operator",
  // Platform administrators (docs/runbooks/ADMIN_PROVISIONING.md). Metadata: operator,
  // redacted reason, denial code — never codes or secrets.
  "platform_admin.granted",
  "platform_admin.grant_denied",
  "platform_admin.revoked",
  // Marketing Core (Phase 3).
  "brand.created",
  "brand.updated",
  "audience.created",
  "audience.updated",
  "audience.deleted",
  "goal.created",
  "goal.updated",
  "pillar.created",
  "pillar.updated",
  "campaign.created",
  "campaign.updated",
  "campaign.archived",
  "campaign.plan_updated",
  "campaign.plan_generated",
  "campaign.plan_approved",
  "campaign.plan_reopened",
  "campaign.plan_drafts_created",
  "metrics.imported",
  "metrics.import_failed",
  "metrics.import_voided",
  "recommendation.reviewed",
  "recommendation.dismissed",
  "recommendation.snoozed",
  "recommendation.acted",
  "insights.source_enabled",
  "insights.source_disabled",
  "insights.synced",
  "insights.sync_failed",
  "insights.access_revoked",
  "content.created",
  "content.updated",
  "content.status_changed",
  "content.deleted",
  "asset.created",
  "asset.updated",
  "asset.deleted",
  // AI Marketing Engine (Phase 4). Metadata: operation, provider, model, status, token
  // counts, error code, related content id — never prompts or generated text.
  "ai.generated",
  "ai.failed",
  "ai.applied",
  // Generated video retention. Metadata: ids, counts, sizes, timestamps, attempt numbers,
  // delivery outcomes — never storage keys, titles, prompts or email addresses.
  "video.generated",
  "video.expiry_reminder",
  "video.files_deleted",
  "video.deletion_failed",
  "video.metadata_purged",
  // Generative video jobs. Metadata: job/attempt ids, states, tier, duration, failure
  // codes, money in micros — never prompts, titles or provider output URLs.
  "video.job_requested",
  "video.job_finished",
  "video.attempt_failed",
  "video.job_reviewed",
  // AI Creator Studio (Pass 8). Metadata: kinds, codes and flags only.
  "creator.project_created",
  "creator.processing_requested",
  "creator.export_requested",
  "creator.job_cancelled",
  "creator.project_deletion_requested",
  "creator.project_purged",
  "creator.project_data_exported",
  // Orchestration (AI Marketing Manager). Metadata: run/task ids and keys, workflow,
  // states, failure codes, policy field names, counts and content ids — never prompts or
  // generated text.
  "automation.policy_updated",
  "automation.paused",
  "automation.resumed",
  "automation.run_created",
  "automation.run_finished",
  "automation.run_cancelled",
  "automation.task_failed",
  "automation.approval_required",
  // Approval decisions carry the exact action decided on (snapshot, hash, amount).
  "automation.approval_granted",
  "automation.approval_rejected",
  "automation.approval_stale",
  "automation.approval_used",
  "automation.drafts_created",
  // Advertising platforms. Metadata: platform, account/plan ids, external ids, unified
  // statuses, error codes, counts, granted permission names and amounts — never tokens,
  // authorization codes, state values or raw platform responses.
  // Credits: the workspace's caps and automatic top-up; credits added or a plan changed
  // by a platform administrator (metadata: amounts, plan codes, references only).
  "billing.settings_updated",
  "billing.credits_added",
  "billing.plan_changed",
  "billing.auto_recharge",
  // AI Social Manager: agents, channels, replies and what the agents learned.
  "social.agent_saved",
  "social.agent_activated",
  "social.agent_paused",
  "social.channel_saved",
  "social.access_revoked",
  "social.reply_sent",
  "social.reply_rejected",
  "social.reply_uncertain",
  "social.interaction_ignored",
  "social.guidance_applied",
  "social.lesson_dismissed",
  "social.post_queued",
  "social.post_rescheduled",
  "social.post_cancelled",
  "social.post_published",
  "social.post_uncertain",
  "ads.connect_started",
  "ads.connected",
  "ads.connect_failed",
  "ads.disconnected",
  // Meta callbacks (no actor): the person removed the app or asked for data deletion.
  "ads.platform_deauthorized",
  "ads.platform_data_deleted",
  "ads.accounts_refreshed",
  "ads.account_selected",
  "ads.synced",
  "ads.sync_failed",
  "ads.plan_created",
  "ads.plan_updated",
  "ads.plan_discarded",
  "ads.launch_requested",
  "ads.launch_succeeded",
  "ads.launch_failed",
  // WhatsApp Business. Metadata: account ids, counts and error codes — never phone
  // numbers, message ids, message contents or tokens.
  "whatsapp.synced",
  "whatsapp.sync_failed",
  // Execution (external writes). Metadata: plan/step names, external object ids, amounts,
  // codes — never tokens, numbers or message contents.
  "ads.step_succeeded",
  "ads.step_failed",
  "ads.step_uncertain",
  "ads.step_reconciled",
  "ads.activation_requested",
  "ads.activation_succeeded",
  "ads.activation_failed",
  "ads.state_reconciled",
  "ads.spend_limit_set",
  "ads.identities_listed",
  "ads.identity_selected",
  "whatsapp.marketing_opted_out",
  "whatsapp.marketing_resumed",
  "whatsapp.message_resolved",
  "whatsapp.send_cancelled",
  "whatsapp.contact_added",
  "whatsapp.contact_opted_out",
  "whatsapp.send_requested",
  "whatsapp.send_succeeded",
  "whatsapp.send_failed",
  "whatsapp.send_uncertain",
  // Platform storage administration (platform scope, workspaceId = null). Metadata:
  // provider ids and changed field names — never keys, endpoints or bucket names.
  "storage.settings_updated",
  "storage.write_provider_changed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Who/where: a workspace context, or a platform-level actor (workspaceId = null). */
export type AuditScope =
  | TenantContext
  | { readonly workspaceId: null; readonly userId: string | null }
  // A scheduled system job acting inside one workspace (e.g. video retention): no actor.
  | { readonly workspaceId: string; readonly userId: null };

const MAX_USER_AGENT_LENGTH = 512;

/**
 * Appends an audit record. Pass a transaction client to make the audit entry atomic
 * with the change it describes. Metadata is redacted before it is stored. Audit rows
 * are append-only (enforced by the tenant guard) and survive workspace deletion
 * (AuditLog → Workspace is ON DELETE RESTRICT).
 */
export async function recordAudit(db: Db, scope: AuditScope, entry: AuditEntry) {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    workspaceId: scope.workspaceId,
    actorUserId: scope.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: redactSecrets(entry.metadata ?? {}) as Prisma.InputJsonObject,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
  };
  return db.auditLog.create({ data });
}

/** Lists a workspace's audit trail, newest first, with cursor pagination. */
export async function listAuditLogs(
  db: Db,
  ctx: TenantContext,
  options: { readonly limit?: number; readonly cursor?: string } = {},
) {
  const take = Math.min(Math.max(options.limit ?? 50, 1), 100);
  return db.auditLog.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
  });
}
