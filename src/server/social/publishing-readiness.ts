import { TICK_STALE_SECONDS } from "../monitoring/ops-status";

import { hasActiveMetaGrant } from "./channel-access";
import type { SocialDeps } from "./social-service";

// Why a queued post is not going out. Publishing is scheduler-based: "queue now" sets the
// post's time to now and the automation tick (every few minutes) publishes it — never the
// request itself. publishPost (publishing.ts) silently skips a post while any of these
// holds, so the content page names the reason instead of showing a plain "Scheduled".
// Read-only: computing readiness never changes a post.

export const PUBLISHING_BLOCKERS = [
  /** SOCIAL_SENDING_ENABLED=false on this server: nothing is published. */
  "sending_disabled",
  /** The Meta app is not configured on this server (no Meta credentials). */
  "meta_not_configured",
  /** No Meta connection in this workspace. */
  "not_connected",
  /** The Meta connection expired or lost its token: it must be reconnected. */
  "connection_expired",
  /** The workspace's emergency stop (automation paused) holds every scheduled post. */
  "emergency_stop",
  /** The scheduler has not run recently (or never): queued posts wait for it. */
  "scheduler_stale",
] as const;
export type PublishingBlocker = (typeof PUBLISHING_BLOCKERS)[number];

/** The scheduler counts as running when its last run started within this many seconds. */
export const SCHEDULER_FRESH_SECONDS = TICK_STALE_SECONDS;

export interface PublishingReadiness {
  /** Empty: a due post goes out at the next scheduler run. */
  readonly blockers: readonly PublishingBlocker[];
  /** When the scheduler last started a run (null: never on this database). */
  readonly schedulerLastRunAt: Date | null;
}

/**
 * The reasons queued posts of this workspace are held right now, in the order a person
 * should fix them. Everything is read through the workspace-scoped client (the scheduler
 * heartbeat is a global row with no workspace data).
 */
export async function publishingReadiness(
  deps: Pick<SocialDeps, "db" | "meta" | "sendingEnabled" | "now">,
  workspaceId: string,
): Promise<PublishingReadiness> {
  const now = (deps.now ?? (() => new Date()))();
  const [granted, connection, policy, heartbeat] = await Promise.all([
    hasActiveMetaGrant(deps.db, workspaceId, now),
    deps.db.adConnection.findFirst({
      where: { workspaceId, platform: "META" },
      select: { id: true },
    }),
    deps.db.automationPolicy.findFirst({ where: { workspaceId }, select: { paused: true } }),
    deps.db.systemHeartbeat.findUnique({
      where: { name: "automation-tick" },
      select: { lastStartedAt: true },
    }),
  ]);
  const blockers: PublishingBlocker[] = [];
  if (!deps.sendingEnabled) blockers.push("sending_disabled");
  if (deps.meta === null) blockers.push("meta_not_configured");
  else if (!granted) blockers.push(connection === null ? "not_connected" : "connection_expired");
  if (policy?.paused === true) blockers.push("emergency_stop");
  const lastRunAt = heartbeat?.lastStartedAt ?? null;
  if (lastRunAt === null || now.getTime() - lastRunAt.getTime() > SCHEDULER_FRESH_SECONDS * 1000) {
    blockers.push("scheduler_stale");
  }
  return { blockers, schedulerLastRunAt: lastRunAt };
}

// ── Failure codes → what a person can do ─────────────────────────────────────

/**
 * Every error code a post can carry (publishing.ts: publishPost, resolveUncertainPost;
 * queued-posts.ts; the stuck-post recovery; pageFor's social_* / ads_* codes), grouped by what the person
 * should do. Unknown codes fall back to `other`; the table is tested against the codes.
 */
export const PUBLICATION_ERROR_KINDS = [
  "content_not_approved",
  "unscheduled",
  "marked_published",
  "channel_disabled",
  "missed_window",
  "not_published_confirmed",
  "reconnect",
  "permission_missing",
  "page_unavailable",
  "not_configured",
  "rate_limited",
  "provider_error",
  "no_answer",
  "image_missing",
  "image_unavailable",
  "image_invalid",
  "other",
] as const;
export type PublicationErrorKind = (typeof PUBLICATION_ERROR_KINDS)[number];

const ERROR_KIND: Readonly<Record<string, PublicationErrorKind>> = {
  content_not_approved: "content_not_approved",
  unscheduled: "unscheduled",
  marked_published: "marked_published",
  channel_disabled: "channel_disabled",
  missed_window: "missed_window",
  not_published_confirmed: "not_published_confirmed",
  token_expired: "reconnect",
  ads_token_expired: "reconnect",
  ads_not_connected: "reconnect",
  ads_oauth_invalid: "reconnect",
  permission_missing: "permission_missing",
  ads_permission_missing: "permission_missing",
  social_page_unavailable: "page_unavailable",
  page_unavailable: "page_unavailable",
  social_not_configured: "not_configured",
  ads_not_configured: "not_configured",
  rate_limited: "rate_limited",
  ads_rate_limited: "rate_limited",
  provider_error: "provider_error",
  invalid_request: "provider_error",
  ads_provider_error: "provider_error",
  ads_operation_unavailable: "provider_error",
  no_answer: "no_answer",
  ads_outcome_unknown: "no_answer",
  image_missing: "image_missing",
  image_unavailable: "image_unavailable",
  image_invalid: "image_invalid",
};

export function publicationErrorKind(code: string | null): PublicationErrorKind | null {
  if (code === null) return null;
  return ERROR_KIND[code] ?? "other";
}

// ── What a person sees for one post ──────────────────────────────────────────

export const PUBLICATION_DISPLAY_STATES = [
  /** Due, nothing holds it: the next scheduler run publishes it. */
  "queued",
  /** Waiting for its time. */
  "scheduled",
  /** Due, but the server holds it (see the readiness reasons). */
  "on_hold",
  /** Claimed by the scheduler, being sent now. */
  "publishing",
  /** Confirmed on the Page (provider id stored). */
  "published",
  /** Not published, for certain (actionable error). */
  "failed",
  /** Unknown whether it was published: never retried until checked on the Page. */
  "uncertain",
  /** Withdrawn (with the reason). */
  "cancelled",
] as const;
export type PublicationDisplayState = (typeof PUBLICATION_DISPLAY_STATES)[number];

/**
 * The state shown for a post. Only a confirmed outcome reads as published: queuing never
 * does, and an UNCERTAIN post stays uncertain until a person checks it on the Page.
 */
export function publicationDisplayState(
  post: { readonly status: string; readonly scheduledAt: Date },
  now: Date,
  blockers: readonly PublishingBlocker[],
): PublicationDisplayState {
  switch (post.status) {
    case "SCHEDULED":
      if (post.scheduledAt.getTime() > now.getTime()) return "scheduled";
      return blockers.length > 0 ? "on_hold" : "queued";
    case "PUBLISHING":
      return "publishing";
    case "PUBLISHED":
      return "published";
    case "UNCERTAIN":
      return "uncertain";
    case "CANCELLED":
      return "cancelled";
    default:
      return "failed";
  }
}
