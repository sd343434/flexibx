import type { PrismaClient } from "@/generated/prisma/client";
import type { InsightsRunTrigger, InsightsSourceKind } from "@/generated/prisma/enums";

import { withPlatformToken, type AdsDeps } from "../ads/connections";
import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import { AppError, isAppError } from "../errors/app-error";
import { conflict } from "../marketing/common";
import { activeMetaGrant } from "../social/channel-access";
import type { ManagedPage, MetaSocial } from "../social/meta-social";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";
import type { ValidationCode } from "../validation/field-errors";

import { storeProviderBatch, type ProviderObservation } from "./ingestion";
import {
  createCallBudget,
  InsightsProviderError,
  META_INSIGHTS_SCOPES,
  META_METRIC_CATALOG,
  type CallBudget,
  type InsightsFailure,
  type MetaInsightsClient,
  type MetricSpec,
} from "./meta-insights";

// Meta Insights sync (Pass 6): which of a workspace's Meta channels are read, and reading
// them — by a person (Sync now) or by the scheduled tick — into the same imports and
// observations as every other number (VERIFIED, provider "meta").
//
// What is read, and what it is linked to:
// - A Page's or an Instagram account's DAILY numbers (views, reach, interactions): stored
//   at account level (no campaign). They are shown per source and never added to a
//   campaign's results or used by its recommendations: nothing links a Page's day to one
//   campaign, and none is invented.
// - Each Facebook Page post that Flexibx published for content in a campaign (SocialPost
//   with Meta's post id — a reliable link): its lifetime numbers, linked to that content
//   and campaign, so they count in the campaign's results and recommendations.
// Instagram media and advertising spend are not linked: Flexibx publishes nothing to
// Instagram, and an ad plan is not tied to a campaign (no reliable identifier).
//
// Safety: one run per source at a time (a lease on the source, and a database index that
// allows one RUNNING run); every run is bounded in days, posts, calls and time; the
// workspace's Meta grant is re-checked on every run (the Page must still be in it — a Page
// token is fetched for the run and never stored); a run that dies is marked ABANDONED by
// the next one, which resumes from the stored coverage. Tokens never reach a run record,
// an import, an audit entry or an error.

export interface InsightsDeps {
  readonly db: GuardedPrismaClient;
  readonly ads: AdsDeps;
  /** Lists the Pages a grant manages (with their transient tokens); null = no Meta app. */
  readonly meta: MetaSocial | null;
  /** null = Meta Insights is not enabled on this server (META_INSIGHTS_ENABLED). */
  readonly client: MetaInsightsClient | null;
  readonly now?: () => Date;
  /** Tighter limits (tests): calls per run and the run's deadline. */
  readonly limits?: { readonly maxCalls?: number; readonly deadlineMs?: number };
}

const DAY_MS = 86_400_000;
/** First sync: this many complete days back. */
export const INITIAL_DAYS = 28;
/** At most this many days of account numbers per run (the rest on the next runs). */
export const MAX_DAYS_PER_RUN = 14;
/** Days behind the stored coverage read again each run: Meta revises recent days. */
export const REVISE_DAYS = 3;
/** Never read account days older than this (Instagram keeps about 90 days). */
export const MAX_BACKFILL_DAYS = 90;
/** Posts published within this many days are read (their lifetime numbers so far). */
export const POST_LOOKBACK_DAYS = 60;
export const MAX_POSTS_PER_RUN = 25;
export const MAX_CALLS_PER_RUN = 200;
/** A run stops calling Meta after this long; what it read is stored. */
export const RUN_DEADLINE_MS = 90_000;
/** A source is held this long by its run (longer than the deadline plus storing). */
export const LEASE_MS = 5 * 60_000;
/** A person may start a sync of one source at most this often. */
export const MANUAL_MIN_INTERVAL_MS = 5 * 60_000;
export const SYNC_INTERVAL_MS = 24 * 3_600_000;
/** Data older than this (no successful sync) is shown as stale. */
export const STALE_AFTER_MS = 2 * SYNC_INTERVAL_MS;
export const MAX_RUN_ISSUES = 50;

const nowOf = (deps: { readonly now?: () => Date }) => (deps.now ?? (() => new Date()))();
const utcDay = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
const addDays = (day: Date, days: number) => new Date(day.getTime() + days * DAY_MS);
const isoDay = (day: Date) => day.toISOString().slice(0, 10);

const insightsError = (code: ValidationCode) => conflict("insights", code, {});
/** One answer for an unknown id and another workspace's id, so nothing leaks. */
const notFound = (resource: "social_channel" | "insights_source") =>
  new AppError("NOT_FOUND", { metadata: { resource } });

// ── Connection state ─────────────────────────────────────────────────────────

export type InsightsConnectionState = "not_configured" | "not_connected" | "needs_reauth" | "ready";

export interface InsightsConnection {
  readonly state: InsightsConnectionState;
  /** Permissions the grant lacks, per kind of source (empty when it has them all). */
  readonly missing: Readonly<Record<InsightsSourceKind, readonly string[]>>;
}

const NONE_MISSING = { FACEBOOK_PAGE: [], INSTAGRAM_ACCOUNT: [] } as const;

/** What the workspace's Meta grant allows for insights right now. */
export async function insightsConnection(
  deps: InsightsDeps,
  workspaceId: string,
): Promise<InsightsConnection> {
  if (
    deps.client === null ||
    deps.meta === null ||
    deps.ads.tokenKey === null ||
    !deps.ads.adapters.META.available
  ) {
    return { state: "not_configured", missing: NONE_MISSING };
  }
  const connection = await deps.db.adConnection.findFirst({
    where: { workspaceId, platform: "META" },
    select: { status: true, tokenCiphertext: true, tokenExpiresAt: true, scopes: true },
  });
  if (
    connection === null ||
    connection.status === "REVOKED" ||
    connection.tokenCiphertext === null
  ) {
    return { state: "not_connected", missing: NONE_MISSING };
  }
  const missingFor = (kind: InsightsSourceKind) =>
    META_INSIGHTS_SCOPES[kind].filter((scope) => !connection.scopes.includes(scope));
  const missing = {
    FACEBOOK_PAGE: missingFor("FACEBOOK_PAGE"),
    INSTAGRAM_ACCOUNT: missingFor("INSTAGRAM_ACCOUNT"),
  };
  const expired =
    connection.status !== "ACTIVE" ||
    (connection.tokenExpiresAt !== null && connection.tokenExpiresAt <= nowOf(deps));
  const nothingGranted = missing.FACEBOOK_PAGE.length > 0 && missing.INSTAGRAM_ACCOUNT.length > 0;
  return { state: expired || nothingGranted ? "needs_reauth" : "ready", missing };
}

// ── Sources ──────────────────────────────────────────────────────────────────

const kindOf = (platform: "FACEBOOK" | "INSTAGRAM"): InsightsSourceKind =>
  platform === "FACEBOOK" ? "FACEBOOK_PAGE" : "INSTAGRAM_ACCOUNT";

/**
 * Starts reading a channel's insights (social.manage): the channel must be one of the
 * workspace's own, still enabled (in its Meta grant), and the grant must hold the
 * permissions its kind needs. Re-enabling keeps the source's history and coverage.
 */
export async function enableSource(
  deps: InsightsDeps,
  ctx: TenantContext,
  channelId: string,
): Promise<{ readonly sourceId: string }> {
  assertCan(ctx, "social.manage");
  if (!isUuid(channelId)) throw notFound("social_channel");
  const channel = await deps.db.socialChannel.findFirst({
    where: { workspaceId: ctx.workspaceId, id: channelId },
    select: { id: true, platform: true, externalId: true, pageId: true, name: true, enabled: true },
  });
  if (channel === null) throw notFound("social_channel");
  if (!channel.enabled) throw insightsError("insights_channel_unavailable");
  const kind = kindOf(channel.platform);
  const connection = await insightsConnection(deps, ctx.workspaceId);
  if (connection.state === "not_configured") {
    throw new AppError("SERVICE_UNAVAILABLE", {
      fields: [{ path: "insights", code: "insights_not_configured" }],
    });
  }
  if (connection.state === "not_connected") throw insightsError("insights_not_connected");
  if (connection.state === "needs_reauth" || connection.missing[kind].length > 0) {
    throw insightsError("insights_permission_missing");
  }
  const now = nowOf(deps);
  return deps.db.$transaction(async (tx) => {
    const existing = await tx.insightsSource.findFirst({
      where: { workspaceId: ctx.workspaceId, socialChannelId: channel.id },
      select: { id: true },
    });
    let sourceId: string;
    if (existing === null) {
      const created = await tx.insightsSource.create({
        data: {
          workspaceId: ctx.workspaceId,
          socialChannelId: channel.id,
          kind,
          externalId: channel.externalId,
          pageId: channel.pageId,
          name: channel.name,
          nextSyncAt: now,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      sourceId = created.id;
    } else {
      await tx.insightsSource.updateMany({
        where: { workspaceId: ctx.workspaceId, id: existing.id },
        data: {
          enabled: true,
          disabledReason: null,
          name: channel.name,
          failureCount: 0,
          lastErrorCode: null,
          nextSyncAt: now,
          version: { increment: 1 },
        },
      });
      sourceId = existing.id;
    }
    await recordAudit(tx, ctx, {
      action: "insights.source_enabled",
      entityType: "insights_source",
      entityId: sourceId,
      metadata: { kind },
    });
    return { sourceId };
  });
}

/** Stops reading a source (social.manage). Its numbers stay as history. */
export async function disableSource(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  sourceId: string,
): Promise<void> {
  assertCan(ctx, "social.manage");
  if (!isUuid(sourceId)) throw notFound("insights_source");
  await db.$transaction(async (tx) => {
    const updated = await tx.insightsSource.updateMany({
      where: { workspaceId: ctx.workspaceId, id: sourceId, enabled: true },
      data: { enabled: false, disabledReason: null, nextSyncAt: null, version: { increment: 1 } },
    });
    if (updated.count === 0) throw notFound("insights_source");
    await recordAudit(tx, ctx, {
      action: "insights.source_disabled",
      entityType: "insights_source",
      entityId: sourceId,
      metadata: { reason: "person" },
    });
  });
}

// ── One run ──────────────────────────────────────────────────────────────────

/** Who started the run: a person (their workspace context) or the scheduler. */
export type SyncActor =
  | { readonly kind: "person"; readonly ctx: TenantContext }
  | { readonly kind: "system"; readonly workspaceId: string };

export interface SyncOutcome {
  readonly runId: string;
  readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly errorCode: string | null;
  readonly accepted: number;
  readonly revised: number;
  readonly duplicates: number;
  readonly calls: number;
  readonly unsupported: readonly string[];
}

interface RunIssue {
  readonly code: string;
  readonly metric?: string;
  readonly ref?: string;
}

/** Codes a person can act on: they stop scheduled retries until someone reconnects. */
const NEEDS_PERSON = new Set([
  "token_expired",
  "permission_missing",
  "access_lost",
  "not_connected",
]);

/** Next scheduled attempt after a failure: 1 h, 2 h, 4 h … up to a day. */
export function retryDelayMs(failures: number): number {
  return Math.min(SYNC_INTERVAL_MS, 3_600_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * The account days a run reads: from REVISE_DAYS before the stored coverage (or
 * INITIAL_DAYS back on the first run), never older than MAX_BACKFILL_DAYS, at most
 * MAX_DAYS_PER_RUN, up to yesterday (today is not complete). Null when nothing is due.
 */
export function syncWindow(
  coveredTo: Date | null,
  now: Date,
): { readonly from: Date; readonly to: Date } | null {
  const lastComplete = addDays(utcDay(now), -1);
  const oldest = addDays(lastComplete, -(MAX_BACKFILL_DAYS - 1));
  const wanted =
    coveredTo === null
      ? addDays(lastComplete, -(INITIAL_DAYS - 1))
      : addDays(utcDay(coveredTo), -REVISE_DAYS + 1);
  const from = wanted < oldest ? oldest : wanted;
  if (from > lastComplete) return null;
  const capped = addDays(from, MAX_DAYS_PER_RUN - 1);
  return { from, to: capped < lastComplete ? capped : lastComplete };
}

/** The first `from`, the last `to`: the account days known so far. */
function mergeCoverage(
  coveredFrom: Date | null,
  coveredTo: Date | null,
  window: { readonly from: Date; readonly to: Date },
): { readonly from: Date; readonly to: Date } {
  return {
    from: coveredFrom === null || window.from < coveredFrom ? window.from : coveredFrom,
    to: coveredTo === null || window.to > coveredTo ? window.to : coveredTo,
  };
}

/** A person's "Sync now" (campaign.manage), at most once per MANUAL_MIN_INTERVAL_MS. */
export async function syncSourceNow(
  deps: InsightsDeps,
  ctx: TenantContext,
  sourceId: string,
): Promise<SyncOutcome> {
  assertCan(ctx, "campaign.manage");
  if (!isUuid(sourceId)) throw notFound("insights_source");
  return runSync(deps, { kind: "person", ctx }, sourceId, "MANUAL");
}

async function claim(
  deps: InsightsDeps,
  actor: SyncActor,
  sourceId: string,
  trigger: InsightsRunTrigger,
  now: Date,
) {
  const workspaceId = actor.kind === "person" ? actor.ctx.workspaceId : actor.workspaceId;
  return deps.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM insights_sources
      WHERE id = ${sourceId}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound("insights_source");
    const source = await tx.insightsSource.findFirst({
      where: { workspaceId, id: sourceId },
      select: {
        id: true,
        enabled: true,
        kind: true,
        externalId: true,
        pageId: true,
        socialChannelId: true,
        leaseUntil: true,
        lastAttemptAt: true,
        coveredFrom: true,
        coveredTo: true,
        failureCount: true,
      },
    });
    if (source === null) throw notFound("insights_source");
    if (!source.enabled) throw insightsError("insights_source_disabled");
    if (source.leaseUntil !== null && source.leaseUntil > now) {
      throw insightsError("insights_sync_running");
    }
    if (
      trigger === "MANUAL" &&
      source.lastAttemptAt !== null &&
      now.getTime() - source.lastAttemptAt.getTime() < MANUAL_MIN_INTERVAL_MS
    ) {
      throw new AppError("RATE_LIMITED", { metadata: { resource: "insights_sync" } });
    }
    // A run whose lease ran out died (process stopped): it is closed, and this run resumes
    // from the coverage the source stored.
    await tx.insightsSyncRun.updateMany({
      where: { workspaceId, sourceId, status: "RUNNING" },
      data: { status: "ABANDONED", finishedAt: now, errorCode: "lease_expired" },
    });
    const run = await tx.insightsSyncRun.create({
      data: {
        workspaceId,
        sourceId,
        trigger,
        requestedByUserId: actor.kind === "person" ? actor.ctx.userId : null,
        startedAt: now,
      },
      select: { id: true },
    });
    await tx.insightsSource.updateMany({
      where: { workspaceId, id: sourceId },
      data: {
        leaseRunId: run.id,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        lastAttemptAt: now,
      },
    });
    return { runId: run.id, workspaceId, source };
  });
}

/** Which failures to report under which code (never a provider message). */
function failureCode(error: unknown): string | null {
  if (error instanceof InsightsProviderError) return error.code;
  if (isAppError(error)) {
    const field = error.fields[0]?.code;
    if (field === "ads_token_expired") return "token_expired";
    if (field === "ads_permission_missing") return "permission_missing";
    if (field === "social_page_unavailable") return "access_lost";
    if (error.code === "NOT_FOUND" || field === "ads_not_connected") return "not_connected";
    if (error.code === "SERVICE_UNAVAILABLE") return "not_configured";
  }
  return null;
}

/**
 * One run of one source. Claims it (or refuses: running, too soon, disabled), reads what
 * is due, stores it, and records how it ended. Never throws for a provider failure: the
 * run is recorded FAILED (or PARTIAL when something was read) with a code.
 */
export async function runSync(
  deps: InsightsDeps,
  actor: SyncActor,
  sourceId: string,
  trigger: InsightsRunTrigger,
): Promise<SyncOutcome> {
  const startedAt = nowOf(deps);
  const { runId, workspaceId, source } = await claim(deps, actor, sourceId, trigger, startedAt);
  const auditScope = actor.kind === "person" ? actor.ctx : { workspaceId, userId: null };
  const issues: RunIssue[] = [];
  const unsupported = new Set<string>();
  const issue = (entry: RunIssue) => {
    if (issues.length < MAX_RUN_ISSUES) issues.push(entry);
  };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.limits?.deadlineMs ?? RUN_DEADLINE_MS);
  const budget = createCallBudget(deps.limits?.maxCalls ?? MAX_CALLS_PER_RUN, controller.signal);
  const rows: ProviderObservation[] = [];
  const window = syncWindow(source.coveredTo, startedAt);
  let accountWindowRead = false;
  let fatal: string | null = null;

  try {
    if (deps.client === null || deps.meta === null) {
      throw new AppError("SERVICE_UNAVAILABLE", { metadata: { resource: "insights" } });
    }
    const client = deps.client;
    const meta = deps.meta;
    const connection = await insightsConnection(deps, workspaceId);
    if (connection.state === "not_connected") throw insightsError("ads_not_connected");
    if (connection.state === "not_configured") {
      throw new AppError("SERVICE_UNAVAILABLE", { metadata: { resource: "insights" } });
    }
    if (connection.missing[source.kind].length > 0) {
      throw new InsightsProviderError("permission_missing");
    }
    // The Page must still be in the workspace's own grant (ownership is re-checked on
    // every run); its token lives only for this run.
    const page: ManagedPage = await withPlatformToken(
      deps.ads,
      workspaceId,
      "META",
      async (token) => {
        const pages = await withinDeadline(meta.listPages(token), controller.signal);
        const found = pages.find((candidate) => candidate.id === source.pageId);
        if (found === undefined) throw insightsError("social_page_unavailable");
        if (source.kind === "INSTAGRAM_ACCOUNT" && found.instagram?.id !== source.externalId) {
          throw insightsError("social_page_unavailable");
        }
        return found;
      },
    );

    const channel: ProviderObservation["channel"] =
      source.kind === "FACEBOOK_PAGE" ? "FACEBOOK_PAGE" : "INSTAGRAM";
    // Account-level daily numbers.
    if (window !== null) {
      const specs: readonly MetricSpec[] =
        source.kind === "FACEBOOK_PAGE" ? META_METRIC_CATALOG.page : META_METRIC_CATALOG.instagram;
      for (const spec of specs) {
        const accountRef = (day: Date) =>
          `meta:${source.kind === "FACEBOOK_PAGE" ? "page" : "ig"}:${source.externalId}:${spec.graph}:${isoDay(day)}`;
        if (source.kind === "FACEBOOK_PAGE") {
          const result = await client.pageDaily(
            page.accessToken,
            source.externalId,
            spec,
            window.from,
            window.to,
            budget,
          );
          if (result.status !== "ok") {
            unsupported.add(spec.graph);
            issue({ code: "metric_unsupported", metric: spec.graph });
            continue;
          }
          for (const point of result.value) {
            rows.push(accountRow(spec, point.day, point.value, accountRef(point.day), channel));
          }
        } else {
          for (let day = window.from; day <= window.to; day = addDays(day, 1)) {
            const result = await client.instagramDay(
              page.accessToken,
              source.externalId,
              spec,
              day,
              budget,
            );
            if (result.status !== "ok") {
              unsupported.add(spec.graph);
              issue({ code: "metric_unsupported", metric: spec.graph });
              break;
            }
            // null: Meta has no value for that day (missing, not zero).
            if (result.value !== null) {
              rows.push(accountRow(spec, day, result.value, accountRef(day), channel));
            }
          }
        }
      }
      accountWindowRead = true;
    }

    // Posts Flexibx published on this Page for content in a campaign.
    if (source.kind === "FACEBOOK_PAGE") {
      const posts = await deps.db.socialPost.findMany({
        where: {
          workspaceId,
          channelId: source.socialChannelId,
          status: "PUBLISHED",
          externalPostId: { not: null },
          publishedAt: { gte: addDays(utcDay(startedAt), -POST_LOOKBACK_DAYS) },
          contentItem: { campaignId: { not: null } },
        },
        orderBy: { publishedAt: "desc" },
        take: MAX_POSTS_PER_RUN,
        select: {
          externalPostId: true,
          publishedAt: true,
          contentItem: { select: { id: true, campaignId: true } },
        },
      });
      for (const post of posts) {
        const postId = post.externalPostId;
        const campaignId = post.contentItem.campaignId;
        if (postId === null || campaignId === null || post.publishedAt === null) continue;
        const period = { start: utcDay(post.publishedAt), end: utcDay(startedAt) };
        const postRow = (metric: ProviderObservation["metric"], graph: string, value: bigint) => ({
          sourceRef: `meta:post:${postId}:${graph}`,
          metric,
          periodStart: period.start,
          periodEnd: period.end,
          value,
          channel,
          campaignId,
          contentItemId: post.contentItem.id,
        });
        const interactions = await client.postInteractions(page.accessToken, postId, budget);
        if (interactions.status === "not_found") {
          issue({ code: "post_unavailable", ref: postId });
          continue;
        }
        if (interactions.status === "ok") {
          rows.push(postRow("ENGAGEMENTS", "interactions", interactions.value));
        } else {
          unsupported.add("post_interactions");
        }
        for (const spec of META_METRIC_CATALOG.post) {
          const result = await client.postLifetime(page.accessToken, postId, spec, budget);
          if (result.status !== "ok") {
            unsupported.add(spec.graph);
            continue;
          }
          if (result.value !== null) rows.push(postRow(spec.metric, spec.graph, result.value));
        }
      }
    }
  } catch (error) {
    fatal = failureCode(error);
    if (fatal === null) {
      clearTimeout(timer);
      await finish(deps, {
        runId,
        workspaceId,
        sourceId,
        auditScope,
        status: "FAILED",
        errorCode: "internal_error",
        calls: budget.calls,
        issues,
        unsupported: [...unsupported],
        stored: null,
        window,
        coverage: null,
        startedAt,
        failureCount: source.failureCount,
      });
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }

  // Store what was read (also after a failure part-way: it is real and dated).
  let stored: Awaited<ReturnType<typeof storeProviderBatch>> | null = null;
  if (rows.length > 0) {
    stored = await storeProviderBatch(deps.db, auditScope, {
      provider: "meta",
      insightsSourceId: sourceId,
      externalId: `run:${runId}`,
      observedAt: startedAt,
      rows,
    });
  }
  const status: SyncOutcome["status"] =
    fatal === null
      ? issues.some((entry) => entry.code === "post_unavailable")
        ? "PARTIAL"
        : "SUCCEEDED"
      : rows.length > 0
        ? "PARTIAL"
        : "FAILED";
  const coverage =
    window !== null && accountWindowRead
      ? mergeCoverage(source.coveredFrom, source.coveredTo, window)
      : null;
  await finish(deps, {
    runId,
    workspaceId,
    sourceId,
    auditScope,
    status,
    errorCode: fatal,
    calls: budget.calls,
    issues,
    unsupported: [...unsupported],
    stored,
    window,
    coverage,
    startedAt,
    failureCount: source.failureCount,
  });
  return {
    runId,
    status,
    errorCode: fatal,
    accepted: stored?.accepted ?? 0,
    revised: stored?.revised ?? 0,
    duplicates: stored?.duplicates ?? 0,
    calls: budget.calls,
    unsupported: [...unsupported],
  };
}

/** `work`, or deadline_reached when the run's time runs out first (work is left to end). */
async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new InsightsProviderError("deadline_reached");
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new InsightsProviderError("deadline_reached"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Its own failure after the deadline is not this run's concern any more.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function accountRow(
  spec: MetricSpec,
  day: Date,
  value: bigint,
  sourceRef: string,
  channel: ProviderObservation["channel"],
): ProviderObservation {
  return {
    sourceRef,
    metric: spec.metric,
    periodStart: day,
    periodEnd: day,
    value,
    channel,
    campaignId: null,
    contentItemId: null,
  };
}

async function finish(
  deps: InsightsDeps,
  input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly auditScope: TenantContext | { readonly workspaceId: string; readonly userId: null };
    readonly status: SyncOutcome["status"];
    readonly errorCode: string | null;
    readonly calls: number;
    readonly issues: readonly RunIssue[];
    readonly unsupported: readonly string[];
    readonly stored: Awaited<ReturnType<typeof storeProviderBatch>> | null;
    readonly window: { readonly from: Date; readonly to: Date } | null;
    readonly coverage: { readonly from: Date; readonly to: Date } | null;
    readonly startedAt: Date;
    readonly failureCount: number;
  },
): Promise<void> {
  const finishedAt = nowOf(deps);
  const failed = input.status === "FAILED";
  const failures = failed ? input.failureCount + 1 : 0;
  const needsPerson = input.errorCode !== null && NEEDS_PERSON.has(input.errorCode);
  await deps.db.$transaction(async (tx) => {
    // The run's own record (a run marked ABANDONED meanwhile keeps that status).
    await tx.insightsSyncRun.updateMany({
      where: { workspaceId: input.workspaceId, id: input.runId, status: "RUNNING" },
      data: {
        status: input.status,
        finishedAt: finishedAt < input.startedAt ? input.startedAt : finishedAt,
        calls: input.calls,
        rowsStored: input.stored?.accepted ?? 0,
        importId: input.stored?.importId ?? null,
        errorCode: input.errorCode ?? (failed ? "internal_error" : null),
        issues: input.issues as object[],
        windowFrom: input.window?.from ?? null,
        windowTo: input.window?.to ?? null,
      },
    });
    // The source, only while this run still holds it.
    await tx.insightsSource.updateMany({
      where: { workspaceId: input.workspaceId, id: input.sourceId, leaseRunId: input.runId },
      data: {
        leaseRunId: null,
        leaseUntil: null,
        lastErrorCode: input.errorCode,
        failureCount: failures,
        ...(failed ? {} : { lastSuccessAt: finishedAt }),
        ...(input.coverage === null
          ? {}
          : { coveredFrom: input.coverage.from, coveredTo: input.coverage.to }),
        ...(input.status === "FAILED" && input.unsupported.length === 0
          ? {}
          : { unsupportedMetrics: [...input.unsupported].sort() }),
        // A person must reconnect first; a failure is retried after a growing pause; a run
        // cut short (rate limit, deadline) resumes soon; a complete one in a day.
        nextSyncAt: needsPerson
          ? null
          : new Date(
              finishedAt.getTime() +
                (failed
                  ? retryDelayMs(failures)
                  : input.errorCode !== null
                    ? retryDelayMs(1)
                    : SYNC_INTERVAL_MS),
            ),
        ...(input.errorCode === "access_lost"
          ? { enabled: false, disabledReason: "access_lost" }
          : {}),
      },
    });
    await recordAudit(tx, input.auditScope, {
      action: failed ? "insights.sync_failed" : "insights.synced",
      entityType: "insights_source",
      entityId: input.sourceId,
      metadata: {
        runId: input.runId,
        status: input.status,
        code: input.errorCode,
        calls: input.calls,
        accepted: input.stored?.accepted ?? 0,
        revised: input.stored?.revised ?? 0,
        duplicates: input.stored?.duplicates ?? 0,
        unsupported: [...input.unsupported],
      },
    });
    if (input.errorCode === "token_expired") {
      // Meta refused the grant's token: the connection needs a person to reconnect.
      await tx.adConnection.updateMany({
        where: { workspaceId: input.workspaceId, platform: "META", status: "ACTIVE" },
        data: { status: "EXPIRED", lastErrorCode: "token_expired", lastCheckedAt: finishedAt },
      });
    }
    if (input.errorCode === "access_lost") {
      await recordAudit(tx, input.auditScope, {
        action: "insights.access_revoked",
        entityType: "insights_source",
        entityId: input.sourceId,
        metadata: { reason: "access_lost" },
      });
    }
  });
}

// ── Scheduled runs ───────────────────────────────────────────────────────────

/** Sources read by one tick at most (each run is bounded on its own). */
export const SCHEDULED_SOURCES_PER_TICK = 5;

/**
 * The scheduler's phase: due, enabled sources of workspaces whose Meta grant is usable,
 * not held by a live run — each read in its own run; one failing never stops the others.
 * SYSTEM PATH (reviewed): sources are found across workspaces with the system client;
 * each run then works inside its own workspace through the guarded client.
 */
export async function runDueInsightsSyncs(
  deps: InsightsDeps,
  system: PrismaClient,
  options: { readonly limit?: number } = {},
): Promise<{ readonly started: number; readonly failed: number }> {
  if (deps.client === null || deps.meta === null) return { started: 0, failed: 0 };
  const now = nowOf(deps);
  const due = await system.insightsSource.findMany({
    where: {
      enabled: true,
      nextSyncAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      workspace: { deletedAt: null, ...activeMetaGrant(now) },
    },
    orderBy: { nextSyncAt: "asc" },
    take: Math.min(Math.max(options.limit ?? SCHEDULED_SOURCES_PER_TICK, 1), 25),
    select: { id: true, workspaceId: true },
  });
  let failed = 0;
  for (const source of due) {
    try {
      const outcome = await runSync(
        deps,
        { kind: "system", workspaceId: source.workspaceId },
        source.id,
        "SCHEDULED",
      );
      if (outcome.status === "FAILED") failed += 1;
    } catch {
      // Claimed by a person meanwhile, disabled, or an internal error (recorded on the
      // run): the next tick tries again.
      failed += 1;
    }
  }
  return { started: due.length, failed };
}

export type { CallBudget, InsightsFailure };

// ── Read side ────────────────────────────────────────────────────────────────

export type SourceStatus =
  "disabled" | "needs_reauth" | "running" | "never_synced" | "failed" | "stale" | "ready";

/** What a source's card says, from its stored state (pure). */
export function sourceStatus(
  source: {
    readonly enabled: boolean;
    readonly leaseUntil: Date | null;
    readonly lastSuccessAt: Date | null;
    readonly lastAttemptAt: Date | null;
    readonly lastErrorCode: string | null;
  },
  connection: InsightsConnectionState,
  now: Date,
): SourceStatus {
  if (!source.enabled) return "disabled";
  if (
    connection === "needs_reauth" ||
    connection === "not_connected" ||
    (source.lastErrorCode !== null && NEEDS_PERSON.has(source.lastErrorCode))
  ) {
    return "needs_reauth";
  }
  if (source.leaseUntil !== null && source.leaseUntil > now) return "running";
  if (source.lastSuccessAt === null) {
    return source.lastErrorCode === null ? "never_synced" : "failed";
  }
  if (
    source.lastErrorCode !== null &&
    source.lastAttemptAt !== null &&
    source.lastAttemptAt > source.lastSuccessAt
  ) {
    return "failed";
  }
  if (now.getTime() - source.lastSuccessAt.getTime() > STALE_AFTER_MS) return "stale";
  return "ready";
}

/** Days of account numbers summed on a source's card (ending at its coverage). */
export const OVERVIEW_DAYS = 28;

/**
 * The workspace's Meta channels and their insights sources (analytics.view): status,
 * last runs, coverage, metrics Meta does not offer, and the account-level totals of the
 * last OVERVIEW_DAYS covered days (latest revision of each day; never a campaign's).
 */
export async function getSourceOverview(
  deps: InsightsDeps,
  ctx: TenantContext,
): Promise<{
  readonly connection: InsightsConnection;
  readonly channels: readonly SourceCard[];
}> {
  assertCan(ctx, "analytics.view");
  const now = nowOf(deps);
  const connection = await insightsConnection(deps, ctx.workspaceId);
  const channels = await deps.db.socialChannel.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
    take: 100,
    select: {
      id: true,
      platform: true,
      name: true,
      enabled: true,
      insightsSource: {
        select: {
          id: true,
          kind: true,
          enabled: true,
          disabledReason: true,
          leaseUntil: true,
          lastAttemptAt: true,
          lastSuccessAt: true,
          lastErrorCode: true,
          coveredFrom: true,
          coveredTo: true,
          nextSyncAt: true,
          unsupportedMetrics: true,
          runs: {
            orderBy: { startedAt: "desc" },
            take: 5,
            select: {
              id: true,
              trigger: true,
              status: true,
              startedAt: true,
              finishedAt: true,
              errorCode: true,
              calls: true,
              rowsStored: true,
            },
          },
        },
      },
    },
  });
  const sourceIds = channels.flatMap((channel) =>
    channel.insightsSource === null ? [] : [channel.insightsSource.id],
  );
  const observations =
    sourceIds.length === 0
      ? []
      : await deps.db.metricObservation.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            insightsSourceId: { in: sourceIds },
            campaignId: null,
            import: { status: { not: "VOIDED" } },
            periodStart: { gte: addDays(utcDay(now), -(MAX_BACKFILL_DAYS + 1)) },
          },
          orderBy: [{ observedAt: "asc" }, { createdAt: "asc" }],
          take: 10_000,
          select: {
            insightsSourceId: true,
            sourceRef: true,
            metric: true,
            periodStart: true,
            value: true,
          },
        });
  // Latest value of each day (later rows overwrite earlier ones of the same identity).
  const latest = new Map<string, (typeof observations)[number]>();
  for (const row of observations) latest.set(row.sourceRef, row);
  const cards = channels.map((channel): SourceCard => {
    const source = channel.insightsSource;
    if (source === null) {
      return {
        channelId: channel.id,
        platform: channel.platform,
        name: channel.name,
        channelEnabled: channel.enabled,
        source: null,
      };
    }
    const end = source.coveredTo;
    const start = end === null ? null : addDays(end, -(OVERVIEW_DAYS - 1));
    const totals = new Map<string, { value: bigint; days: Set<number> }>();
    if (start !== null && end !== null) {
      for (const row of latest.values()) {
        if (row.insightsSourceId !== source.id) continue;
        if (row.periodStart < start || row.periodStart > end) continue;
        const entry = totals.get(row.metric) ?? { value: 0n, days: new Set<number>() };
        entry.value += row.value;
        entry.days.add(row.periodStart.getTime());
        totals.set(row.metric, entry);
      }
    }
    return {
      channelId: channel.id,
      platform: channel.platform,
      name: channel.name,
      channelEnabled: channel.enabled,
      source: {
        id: source.id,
        kind: source.kind,
        enabled: source.enabled,
        disabledReason: source.disabledReason,
        status: sourceStatus(source, connection.state, now),
        lastAttemptAt: source.lastAttemptAt,
        lastSuccessAt: source.lastSuccessAt,
        lastErrorCode: source.lastErrorCode,
        coveredFrom: source.coveredFrom,
        coveredTo: source.coveredTo,
        nextSyncAt: source.nextSyncAt,
        unsupportedMetrics: source.unsupportedMetrics,
        missingPermissions: connection.missing[source.kind],
        window: start === null || end === null ? null : { from: start, to: end },
        totals: [...totals.entries()]
          .map(([metric, entry]) => ({
            metric: metric as ProviderObservation["metric"],
            value: entry.value,
            days: entry.days.size,
          }))
          .sort((a, b) => a.metric.localeCompare(b.metric)),
        runs: source.runs,
      },
    };
  });
  return { connection, channels: cards };
}

export interface SourceCard {
  readonly channelId: string;
  readonly platform: "FACEBOOK" | "INSTAGRAM";
  readonly name: string;
  /** False: the Page is no longer in the workspace's Meta grant. */
  readonly channelEnabled: boolean;
  readonly source: {
    readonly id: string;
    readonly kind: InsightsSourceKind;
    readonly enabled: boolean;
    readonly disabledReason: string | null;
    readonly status: SourceStatus;
    readonly lastAttemptAt: Date | null;
    readonly lastSuccessAt: Date | null;
    readonly lastErrorCode: string | null;
    readonly coveredFrom: Date | null;
    readonly coveredTo: Date | null;
    readonly nextSyncAt: Date | null;
    readonly unsupportedMetrics: readonly string[];
    readonly missingPermissions: readonly string[];
    /** The days the totals cover (null before the first successful read). */
    readonly window: { readonly from: Date; readonly to: Date } | null;
    readonly totals: readonly {
      readonly metric: ProviderObservation["metric"];
      readonly value: bigint;
      /** Days that had a value (a day Meta did not report is not counted). */
      readonly days: number;
    }[];
    readonly runs: readonly {
      readonly id: string;
      readonly trigger: InsightsRunTrigger;
      readonly status: string;
      readonly startedAt: Date;
      readonly finishedAt: Date | null;
      readonly errorCode: string | null;
      readonly calls: number;
      readonly rowsStored: number;
    }[];
  } | null;
}
