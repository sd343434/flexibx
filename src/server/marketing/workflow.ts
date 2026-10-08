import type { CampaignStatus, ContentStatus } from "@/generated/prisma/enums";

import type { Action } from "../tenancy/permissions";

import type { ContentTransition } from "./inputs";

// Status machines for content and campaigns. Pure: the services enforce them, the UI
// only uses them to decide which buttons to show. Clients never send a target status for
// content — they send a transition name, and the server decides the result.

export interface ContentTransitionRule {
  readonly from: readonly ContentStatus[];
  readonly to: ContentStatus;
  /** The permission the actor needs (checked against the role at execution time). */
  readonly permission: Action;
}

/**
 * The content workflow: DRAFT → IN_REVIEW → APPROVED → SCHEDULED → PUBLISHED, plus the
 * corrections that move work back (withdraw, request changes, reopen, unschedule).
 * PUBLISHED is final: Flexibx records that content went out, it does not un-publish it.
 */
export const CONTENT_TRANSITION_RULES: Readonly<Record<ContentTransition, ContentTransitionRule>> =
  {
    submit: { from: ["DRAFT"], to: "IN_REVIEW", permission: "content.edit" },
    withdraw: { from: ["IN_REVIEW"], to: "DRAFT", permission: "content.edit" },
    approve: { from: ["IN_REVIEW"], to: "APPROVED", permission: "content.approve" },
    request_changes: { from: ["IN_REVIEW"], to: "DRAFT", permission: "content.approve" },
    reopen: { from: ["APPROVED"], to: "DRAFT", permission: "content.edit" },
    schedule: { from: ["APPROVED"], to: "SCHEDULED", permission: "content.publish" },
    unschedule: { from: ["SCHEDULED"], to: "APPROVED", permission: "content.publish" },
    publish: { from: ["APPROVED", "SCHEDULED"], to: "PUBLISHED", permission: "content.publish" },
  };

export function contentTransitionRule(transition: ContentTransition): ContentTransitionRule {
  return CONTENT_TRANSITION_RULES[transition];
}

/** Whether `transition` may start from `status` (permission not considered). */
export function isTransitionAllowedFrom(
  transition: ContentTransition,
  status: ContentStatus,
): boolean {
  return CONTENT_TRANSITION_RULES[transition].from.includes(status);
}

/** Transitions that start from `status`, in workflow order. */
export function transitionsFrom(status: ContentStatus): ContentTransition[] {
  return (Object.keys(CONTENT_TRANSITION_RULES) as ContentTransition[]).filter((transition) =>
    isTransitionAllowedFrom(transition, status),
  );
}

/** Only drafts can be edited; anything further along must be moved back first. */
export function isContentEditable(status: ContentStatus): boolean {
  return status === "DRAFT";
}

/** Deleting a draft is editing work; deleting anything further along is a publishing call. */
export function contentDeletePermission(status: ContentStatus): Action {
  return status === "DRAFT" ? "content.edit" : "content.publish";
}

/**
 * Moving content on the calendar: a committed schedule is a publishing decision, a
 * planned date on unscheduled work is editing. Published content stays where it went out.
 */
export function reschedulePermission(status: ContentStatus): Action | null {
  if (status === "PUBLISHED") return null;
  return status === "SCHEDULED" ? "content.publish" : "content.edit";
}

/** Campaign lifecycle. ARCHIVED is final; COMPLETED can only be archived. */
export const CAMPAIGN_STATUS_TRANSITIONS: Readonly<
  Record<CampaignStatus, readonly CampaignStatus[]>
> = {
  DRAFT: ["PLANNED", "ACTIVE", "ARCHIVED"],
  PLANNED: ["DRAFT", "ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "COMPLETED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "COMPLETED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canChangeCampaignStatus(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_STATUS_TRANSITIONS[from].includes(to);
}

/** Archived campaigns are read-only: no edits and no new content linked to them. */
export function isCampaignEditable(status: CampaignStatus): boolean {
  return status !== "ARCHIVED";
}
