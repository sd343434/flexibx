import type {
  CampaignPlanStatus,
  CampaignStatus,
  ContentReviewDecision,
  ContentStatus,
  MarketingChannel,
} from "@/generated/prisma/enums";

import { isPublishedByFlexibx, utcDay } from "./campaign-plan";

// Where a campaign stands and what to do next (Pass 4). Pure (no `server-only`): built
// only from what Flexibx itself records — the plan, each content item's workflow status,
// its latest review decision and its Facebook Page publications (with their confirmed
// outcome) and the publishing readiness. Nothing is estimated. Engagement, reach, clicks,
// conversions and revenue are not collected by Flexibx (no analytics provider is
// connected), so they are never shown or inferred here.

/** One step of a content item's way from idea to publication. */
export const CONTENT_STAGES = [
  /** A plan item that is not content yet. */
  "planned",
  "draft",
  /** Back in draft after a reviewer asked for changes (latest decision). */
  "changes_requested",
  "in_review",
  "approved",
  /** SCHEDULED in the content workflow, with no Facebook Page post waiting. */
  "scheduled",
  /** A Facebook Page post is waiting for the scheduler or being sent — not published yet. */
  "queued",
  /** Not known whether the Page post went out: someone must check the Page. */
  "uncertain",
  /** The last Page post failed for certain (with an error code to act on). */
  "failed",
  /** Published, confirmed by a Facebook post id. */
  "published",
  /** Marked as published by a person (a channel Flexibx does not publish to). */
  "published_manually",
] as const;
export type ContentStage = (typeof CONTENT_STAGES)[number];

export interface ProgressPost {
  readonly status: string;
  readonly errorCode: string | null;
  readonly externalPostId: string | null;
}

export interface ProgressContent {
  readonly id: string;
  readonly title: string;
  readonly status: ContentStatus;
  readonly scheduledAt: Date | null;
  readonly latestReview: ContentReviewDecision | null;
  readonly posts: readonly ProgressPost[];
}

export interface ProgressPlanItem {
  readonly id: string;
  readonly title: string;
  readonly channel: MarketingChannel;
  readonly plannedDate: Date | null;
  readonly included: boolean;
  readonly contentItemId: string | null;
}

export interface ProgressInput {
  readonly campaign: {
    readonly status: CampaignStatus;
    readonly endDate: Date | null;
  };
  readonly plan: {
    readonly status: CampaignPlanStatus;
    readonly items: readonly ProgressPlanItem[];
  } | null;
  /** Every content item of the campaign (planned or added directly). */
  readonly content: readonly ProgressContent[];
  /** Why queued posts are held right now (publishing-readiness.ts); empty = none. */
  readonly publishingBlockers: readonly string[];
  readonly now: Date;
}

/** One row of the campaign's pipeline. */
export interface ProgressRow {
  readonly key: string;
  readonly title: string;
  readonly stage: ContentStage;
  readonly channel: MarketingChannel | null;
  readonly contentId: string | null;
  /** The date it should go out (content time, else the plan's date). */
  readonly dueDate: Date | null;
  readonly overdue: boolean;
  readonly errorCode: string | null;
  readonly externalPostId: string | null;
}

export const NEXT_ACTIONS = [
  "check_uncertain",
  "fix_failed",
  "unblock_publishing",
  "revise_changes",
  "review_pending",
  "catch_up_overdue",
  "create_drafts",
  "approve_plan",
  "queue_approved",
  "publish_elsewhere",
  "write_plan",
  "close_campaign",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface NextStep {
  readonly action: NextAction;
  /** How many items it concerns (0 when it is about the campaign or plan as a whole). */
  readonly count: number;
}

export interface CampaignProgress {
  readonly rows: readonly ProgressRow[];
  readonly counts: Readonly<Record<ContentStage, number>>;
  /** Items in scope (excluded plan items do not count). */
  readonly total: number;
  /** Published, by Flexibx (confirmed) or by hand. */
  readonly published: number;
  readonly steps: readonly NextStep[];
}

const WAITING_POSTS = new Set(["SCHEDULED", "PUBLISHING"]);

/** The stage of one content item, from its status, latest review and Page posts. */
export function contentStage(content: ProgressContent): ContentStage {
  const posts = content.posts;
  if (posts.some((post) => post.status === "UNCERTAIN")) return "uncertain";
  if (content.status === "PUBLISHED") {
    return posts.some((post) => post.status === "PUBLISHED") ? "published" : "published_manually";
  }
  if (posts.some((post) => WAITING_POSTS.has(post.status))) return "queued";
  if (posts.some((post) => post.status === "FAILED")) return "failed";
  switch (content.status) {
    case "SCHEDULED":
      return "scheduled";
    case "APPROVED":
      return "approved";
    case "IN_REVIEW":
      return "in_review";
    case "DRAFT":
      return content.latestReview === "CHANGES_REQUESTED" ? "changes_requested" : "draft";
  }
}

const SETTLED: ReadonlySet<ContentStage> = new Set([
  "published",
  "published_manually",
  "queued",
  "uncertain",
]);

const emptyCounts = (): Record<ContentStage, number> =>
  Object.fromEntries(CONTENT_STAGES.map((stage) => [stage, 0])) as Record<ContentStage, number>;

/** The campaign's pipeline, counts and evidence-based next steps (most urgent first). */
export function campaignProgress(input: ProgressInput): CampaignProgress {
  const today = utcDay(input.now);
  const byContent = new Map(input.content.map((item) => [item.id, item]));
  const planItems = input.plan?.items ?? [];
  const planned = new Map(
    planItems.flatMap((item) => (item.contentItemId === null ? [] : [[item.contentItemId, item]])),
  );

  const rows: ProgressRow[] = [];
  const row = (
    key: string,
    title: string,
    stage: ContentStage,
    channel: MarketingChannel | null,
    content: ProgressContent | null,
    dueDate: Date | null,
  ) => {
    const lastFailure = content?.posts.find((post) => post.status === "FAILED") ?? null;
    const published = content?.posts.find((post) => post.status === "PUBLISHED") ?? null;
    rows.push({
      key,
      title,
      stage,
      channel,
      contentId: content?.id ?? null,
      dueDate,
      overdue: dueDate !== null && utcDay(dueDate) < today && !SETTLED.has(stage),
      errorCode: stage === "failed" ? (lastFailure?.errorCode ?? null) : null,
      externalPostId: published?.externalPostId ?? null,
    });
  };

  // Plan items first, in plan order (their content when it exists), then campaign
  // content that did not come from the plan.
  for (const item of planItems) {
    if (!item.included) continue;
    const content =
      item.contentItemId === null ? null : (byContent.get(item.contentItemId) ?? null);
    if (content === null) {
      row(`plan:${item.id}`, item.title, "planned", item.channel, null, item.plannedDate);
    } else {
      row(
        `content:${content.id}`,
        content.title,
        contentStage(content),
        item.channel,
        content,
        content.scheduledAt ?? item.plannedDate,
      );
    }
  }
  for (const content of input.content) {
    if (planned.has(content.id)) continue;
    row(
      `content:${content.id}`,
      content.title,
      contentStage(content),
      null,
      content,
      content.scheduledAt,
    );
  }

  const counts = emptyCounts();
  for (const entry of rows) counts[entry.stage] += 1;
  const count = (predicate: (entry: ProgressRow) => boolean) => rows.filter(predicate).length;

  const steps: NextStep[] = [];
  const add = (action: NextAction, howMany: number, when = howMany > 0) => {
    if (when) steps.push({ action, count: howMany });
  };
  const manual = (entry: ProgressRow) =>
    entry.channel !== null && !isPublishedByFlexibx(entry.channel);
  const plan = input.plan;
  const undrafted = planItems.filter((item) => item.included && item.contentItemId === null).length;

  add("check_uncertain", counts.uncertain);
  add("fix_failed", counts.failed);
  const held = counts.queued + count((entry) => entry.stage === "approved" && !manual(entry));
  add("unblock_publishing", held, input.publishingBlockers.length > 0 && held > 0);
  add("revise_changes", counts.changes_requested);
  add("review_pending", counts.in_review);
  add(
    "catch_up_overdue",
    count((entry) => entry.overdue),
  );
  add("create_drafts", undrafted, plan?.status === "APPROVED" && undrafted > 0);
  add("approve_plan", 0, plan?.status === "DRAFT" && planItems.some((item) => item.included));
  add(
    "queue_approved",
    count((entry) => entry.stage === "approved" && !manual(entry)),
  );
  add(
    "publish_elsewhere",
    count((entry) => (entry.stage === "approved" || entry.stage === "scheduled") && manual(entry)),
  );
  add("write_plan", 0, plan === null || (plan.status === "DRAFT" && planItems.length === 0));
  add(
    "close_campaign",
    0,
    input.campaign.status === "ACTIVE" &&
      input.campaign.endDate !== null &&
      utcDay(input.campaign.endDate) < today,
  );

  return {
    rows,
    counts,
    total: rows.length,
    published: counts.published + counts.published_manually,
    steps,
  };
}
