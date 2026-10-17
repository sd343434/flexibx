// Pass 4 — the deterministic parts of campaign plans and progress: dates and channels for
// AI-proposed items, the brief and the AI request text, the input schemas, each content
// item's stage from recorded facts, and the evidence-based next steps.
import { describe, expect, it } from "vitest";

import {
  addPlanItemInputSchema,
  assignChannels,
  briefFromIdea,
  generatePlanInputSchema,
  PLAN_TOPIC_MAX,
  planTopic,
  savePlanBriefInputSchema,
  spreadPlannedDates,
} from "@/server/marketing/campaign-plan";
import {
  campaignProgress,
  contentStage,
  type ProgressContent,
  type ProgressInput,
} from "@/server/marketing/campaign-progress";

const day = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (dates: (Date | null)[]) => dates.map((d) => d?.toISOString().slice(0, 10) ?? null);
const TODAY = new Date("2030-03-01T15:30:00Z");

describe("planned dates", () => {
  it("spreads items evenly over the campaign window, from its start", () => {
    const window = { startDate: day("2030-03-05"), endDate: day("2030-03-19") };
    expect(iso(spreadPlannedDates(4, window, TODAY))).toEqual([
      "2030-03-05",
      "2030-03-10",
      "2030-03-14",
      "2030-03-19",
    ]);
    expect(iso(spreadPlannedDates(1, window, TODAY))).toEqual(["2030-03-05"]);
    expect(spreadPlannedDates(0, window, TODAY)).toEqual([]);
  });

  it("starts today when the campaign already started, and uses 14 days without an end", () => {
    expect(
      iso(
        spreadPlannedDates(3, { startDate: day("2030-02-01"), endDate: day("2030-03-05") }, TODAY),
      ),
    ).toEqual(["2030-03-01", "2030-03-03", "2030-03-05"]);
    expect(iso(spreadPlannedDates(2, { startDate: null, endDate: null }, TODAY))).toEqual([
      "2030-03-01",
      "2030-03-14",
    ]);
  });

  it("gives no dates when the campaign has ended (a person sets them)", () => {
    expect(
      spreadPlannedDates(3, { startDate: day("2030-01-01"), endDate: day("2030-02-01") }, TODAY),
    ).toEqual([null, null, null]);
  });
});

describe("channels, brief and the AI request", () => {
  it("rotates the person's channels in their order", () => {
    expect(assignChannels(5, ["FACEBOOK_PAGE", "EMAIL"])).toEqual([
      "FACEBOOK_PAGE",
      "EMAIL",
      "FACEBOOK_PAGE",
      "EMAIL",
      "FACEBOOK_PAGE",
    ]);
    expect(() => assignChannels(2, [])).toThrow(RangeError);
  });

  it("labels the idea's own words in the generation language", () => {
    const idea = { angle: "A", objective: "O", audience: "U", ctaDirection: "C" };
    expect(briefFromIdea(idea, "en")).toBe(
      "Angle: A\nObjective: O\nAudience: U\nCall to action: C",
    );
    expect(briefFromIdea(idea, "ar")).toContain("الزاوية: A");
    expect(briefFromIdea({ ...idea, angle: "x".repeat(3000) }, "en")).toHaveLength(2000);
  });

  it("states the offer, budget assumptions, channels and window — bounded in length", () => {
    const topic = planTopic({
      offer: "Two for one",
      budgetNotes: "Organic only",
      channels: ["FACEBOOK_PAGE", "WHATSAPP"],
      dates: { first: day("2030-03-05"), last: day("2030-03-19") },
    });
    expect(topic).toContain("Channels: Facebook Page, WhatsApp.");
    expect(topic).toContain("Offer: Two for one");
    expect(topic).toContain("Budget assumptions: Organic only");
    expect(topic).toContain("2030-03-05 to 2030-03-19");
    const long = planTopic({
      offer: "o".repeat(1000),
      budgetNotes: "b".repeat(1000),
      channels: ["OTHER"],
      dates: { first: null, last: null },
    });
    expect(long).toHaveLength(PLAN_TOPIC_MAX);
    expect(long).not.toContain("Publishing window");
  });
});

describe("plan input schemas", () => {
  const ref = { slug: "ws", campaignId: "11111111-1111-4111-8111-111111111111", version: "3" };

  it("accepts form values and refuses anything the client does not own", () => {
    expect(
      savePlanBriefInputSchema.parse({ ...ref, offer: " ", channels: "EMAIL", budgetNotes: "" }),
    ).toEqual({ ...ref, version: 3, offer: null, channels: ["EMAIL"], budgetNotes: null });
    expect(
      savePlanBriefInputSchema.safeParse({ ...ref, channels: [], status: "APPROVED" }).success,
    ).toBe(false);
    expect(savePlanBriefInputSchema.safeParse({ ...ref, channels: ["TIKTOK"] }).success).toBe(
      false,
    );
    expect(savePlanBriefInputSchema.safeParse({ ...ref, version: "-1" }).success).toBe(false);
  });

  it("validates items: title required, known type and channel, real dates, checkbox", () => {
    const valid = {
      ...ref,
      title: "Teaser",
      brief: "",
      contentType: "POST",
      channel: "FACEBOOK_PAGE",
      plannedDate: "2030-03-10",
      included: "",
    };
    expect(addPlanItemInputSchema.parse(valid)).toMatchObject({
      included: false,
      plannedDate: day("2030-03-10"),
    });
    expect(addPlanItemInputSchema.parse({ ...valid, included: "on" }).included).toBe(true);
    for (const bad of [
      { title: "  " },
      { contentType: "TWEET" },
      { channel: "TIKTOK" },
      { plannedDate: "2030-02-30" },
      { brief: "x".repeat(2001) },
      { contentItemId: ref.campaignId },
    ]) {
      expect(
        addPlanItemInputSchema.safeParse({ ...valid, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("bounds how many posts AI proposes (3–10, 6 by default)", () => {
    expect(generatePlanInputSchema.parse({ ...ref, uiLocale: "en", count: "" }).count).toBe(6);
    expect(generatePlanInputSchema.safeParse({ ...ref, uiLocale: "en", count: "2" }).success).toBe(
      false,
    );
    expect(generatePlanInputSchema.safeParse({ ...ref, uiLocale: "en", count: "11" }).success).toBe(
      false,
    );
  });
});

// ── progress ─────────────────────────────────────────────────────────────────

const content = (overrides: Partial<ProgressContent> & { id: string }): ProgressContent => ({
  title: overrides.id,
  status: "DRAFT",
  scheduledAt: null,
  latestReview: null,
  posts: [],
  ...overrides,
});
const post = (status: string, extra: { errorCode?: string; externalPostId?: string } = {}) => ({
  status,
  errorCode: extra.errorCode ?? null,
  externalPostId: extra.externalPostId ?? null,
});

describe("content stage", () => {
  it("never shows a queued or unconfirmed post as published", () => {
    expect(contentStage(content({ id: "a", status: "APPROVED", posts: [post("SCHEDULED")] }))).toBe(
      "queued",
    );
    expect(
      contentStage(content({ id: "a", status: "APPROVED", posts: [post("PUBLISHING")] })),
    ).toBe("queued");
    expect(contentStage(content({ id: "a", status: "APPROVED", posts: [post("UNCERTAIN")] }))).toBe(
      "uncertain",
    );
    // Unconfirmed wins even next to a manual "published" mark.
    expect(
      contentStage(content({ id: "a", status: "PUBLISHED", posts: [post("UNCERTAIN")] })),
    ).toBe("uncertain");
  });

  it("tells confirmed, manual, failed and workflow stages apart", () => {
    expect(
      contentStage(content({ id: "a", status: "PUBLISHED", posts: [post("PUBLISHED")] })),
    ).toBe("published");
    expect(contentStage(content({ id: "a", status: "PUBLISHED" }))).toBe("published_manually");
    expect(contentStage(content({ id: "a", status: "APPROVED", posts: [post("FAILED")] }))).toBe(
      "failed",
    );
    expect(contentStage(content({ id: "a", status: "SCHEDULED" }))).toBe("scheduled");
    expect(contentStage(content({ id: "a", status: "IN_REVIEW" }))).toBe("in_review");
    expect(contentStage(content({ id: "a", latestReview: "CHANGES_REQUESTED" }))).toBe(
      "changes_requested",
    );
    expect(contentStage(content({ id: "a", latestReview: "APPROVED" }))).toBe("draft");
  });
});

const base = (overrides: Partial<ProgressInput> = {}): ProgressInput => ({
  campaign: { status: "ACTIVE", endDate: null },
  plan: null,
  content: [],
  publishingBlockers: [],
  now: TODAY,
  ...overrides,
});
const actions = (input: ProgressInput) => campaignProgress(input).steps.map((s) => s.action);

describe("campaign progress and next steps", () => {
  it("asks for a plan first, then its approval, then its drafts", () => {
    expect(actions(base())).toEqual(["write_plan"]);
    const item = {
      id: "i1",
      title: "One",
      channel: "FACEBOOK_PAGE" as const,
      plannedDate: day("2030-03-10"),
      included: true,
      contentItemId: null,
    };
    expect(actions(base({ plan: { status: "DRAFT", items: [] } }))).toEqual(["write_plan"]);
    expect(actions(base({ plan: { status: "DRAFT", items: [item] } }))).toEqual(["approve_plan"]);
    expect(campaignProgress(base({ plan: { status: "APPROVED", items: [item] } })).steps).toEqual([
      { action: "create_drafts", count: 1 },
    ]);
    // An excluded item is neither counted nor drafted.
    const excluded = { ...item, included: false };
    expect(
      campaignProgress(base({ plan: { status: "APPROVED", items: [excluded] } })),
    ).toMatchObject({
      total: 0,
      steps: [],
    });
  });

  it("orders the urgent first and counts each case from recorded facts", () => {
    const input = base({
      publishingBlockers: ["not_connected"],
      content: [
        content({ id: "u", status: "APPROVED", posts: [post("UNCERTAIN")] }),
        content({
          id: "f",
          status: "APPROVED",
          posts: [post("FAILED", { errorCode: "token_expired" })],
        }),
        content({ id: "q", status: "APPROVED", posts: [post("SCHEDULED")] }),
        content({ id: "a", status: "APPROVED" }),
        content({ id: "c", latestReview: "CHANGES_REQUESTED" }),
        content({ id: "r", status: "IN_REVIEW" }),
        content({ id: "o", scheduledAt: day("2030-02-20") }),
        content({
          id: "p",
          status: "PUBLISHED",
          posts: [post("PUBLISHED", { externalPostId: "1_2" })],
        }),
      ],
    });
    const progress = campaignProgress(input);
    expect(progress.steps).toEqual([
      { action: "check_uncertain", count: 1 },
      { action: "fix_failed", count: 1 },
      { action: "unblock_publishing", count: 2 },
      { action: "revise_changes", count: 1 },
      { action: "review_pending", count: 1 },
      { action: "catch_up_overdue", count: 1 },
      { action: "queue_approved", count: 1 },
      { action: "write_plan", count: 0 },
    ]);
    expect(progress.published).toBe(1);
    expect(progress.rows.find((r) => r.contentId === "f")?.errorCode).toBe("token_expired");
    expect(progress.rows.find((r) => r.contentId === "p")?.externalPostId).toBe("1_2");
    expect(progress.rows.find((r) => r.contentId === "o")?.overdue).toBe(true);
  });

  it("reports held publishing only when something is waiting to go out", () => {
    expect(
      actions(base({ publishingBlockers: ["sending_disabled"], content: [content({ id: "d" })] })),
    ).toEqual(["write_plan"]);
  });

  it("sends items for channels Flexibx does not publish to elsewhere, never to the queue", () => {
    const progress = campaignProgress(
      base({
        plan: {
          status: "APPROVED",
          items: [
            {
              id: "i1",
              title: "Mail",
              channel: "EMAIL",
              plannedDate: null,
              included: true,
              contentItemId: "m",
            },
            {
              id: "i2",
              title: "Page",
              channel: "FACEBOOK_PAGE",
              plannedDate: null,
              included: true,
              contentItemId: "f",
            },
          ],
        },
        content: [
          content({ id: "m", status: "APPROVED" }),
          content({ id: "f", status: "APPROVED" }),
        ],
        publishingBlockers: ["not_connected"],
      }),
    );
    expect(progress.steps).toEqual([
      { action: "unblock_publishing", count: 1 },
      { action: "queue_approved", count: 1 },
      { action: "publish_elsewhere", count: 1 },
    ]);
    expect(progress.rows.map((r) => [r.title, r.channel])).toEqual([
      ["m", "EMAIL"],
      ["f", "FACEBOOK_PAGE"],
    ]);
  });

  it("does not flag settled items as overdue, and suggests closing an ended campaign", () => {
    const past = day("2030-02-01");
    const progress = campaignProgress(
      base({
        campaign: { status: "ACTIVE", endDate: day("2030-02-28") },
        plan: { status: "APPROVED", items: [] },
        content: [
          content({ id: "p", status: "PUBLISHED", scheduledAt: past }),
          content({ id: "q", status: "APPROVED", scheduledAt: past, posts: [post("SCHEDULED")] }),
        ],
      }),
    );
    expect(progress.rows.every((r) => !r.overdue)).toBe(true);
    expect(progress.steps.map((s) => s.action)).toEqual(["close_campaign"]);
    // A completed campaign is not asked to close again.
    expect(
      actions(base({ campaign: { status: "COMPLETED", endDate: day("2030-02-28") } })),
    ).not.toContain("close_campaign");
  });
});
