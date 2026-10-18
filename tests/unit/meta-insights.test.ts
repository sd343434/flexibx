import { describe, expect, it } from "vitest";

import {
  distinctObservations,
  preferVerified,
  type Observation,
} from "@/server/intelligence/analysis";
import {
  INITIAL_DAYS,
  MAX_DAYS_PER_RUN,
  retryDelayMs,
  sourceStatus,
  STALE_AFTER_MS,
  syncWindow,
} from "@/server/intelligence/insights-sync";
import {
  ALL_META_INSIGHTS_SCOPES,
  backoffDelay,
  createCallBudget,
  createMetaInsightsClient,
  DEFAULT_RETRY,
  InsightsProviderError,
  META_METRIC_CATALOG,
} from "@/server/intelligence/meta-insights";

// Pure parts of the Meta Insights integration (Pass 6): the Graph client against a stub
// fetch (one metric per call, answers validated, zero vs missing vs unsupported, bounded
// retries), the sync window, statuses, and how revisions and duplicates are counted.

const SPEC = META_METRIC_CATALOG.page[0];
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function stub(answers: (Response | Error)[]) {
  const urls: URL[] = [];
  const fetchImpl = (input: URL | RequestInfo) => {
    urls.push(
      new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
    );
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected call");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const sleeps: number[] = [];
  const client = createMetaInsightsClient({
    appSecret: "s".repeat(32),
    version: "v26.0",
    fetch: fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  return { client, urls, sleeps };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (code: number, status = 400) =>
  new Response(JSON.stringify({ error: { code, message: "token EAAB-secret" } }), { status });
const budget = (max = 10) => createCallBudget(max, new AbortController().signal);

describe("Meta insights client", () => {
  it("asks for one metric per call, with the token's proof, and maps end_time to its day", async () => {
    const { client, urls } = stub([
      ok({
        data: [
          {
            name: SPEC.graph,
            values: [
              { value: 5, end_time: "2030-05-02T07:00:00+0000" },
              { value: 0, end_time: "2030-05-03T07:00:00+0000" },
              { value: null, end_time: "2030-05-04T07:00:00+0000" },
            ],
          },
        ],
      }),
    ]);
    const result = await client.pageDaily(
      "PAGE-TOKEN",
      "123",
      SPEC,
      day("2030-05-01"),
      day("2030-05-03"),
      budget(),
    );
    expect(result).toEqual({
      status: "ok",
      value: [
        { day: day("2030-05-01"), value: 5n },
        // A real zero is kept; a null (missing) is not turned into one.
        { day: day("2030-05-02"), value: 0n },
      ],
    });
    const url = urls[0];
    expect(url?.pathname).toBe("/v26.0/123/insights");
    expect(url?.searchParams.get("metric")).toBe(SPEC.graph);
    expect(url?.searchParams.get("until")).toBe("2030-05-04");
    expect(url?.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a metric Meta rejects as unsupported, never as zero", async () => {
    const { client } = stub([fail(100)]);
    expect(
      await client.pageDaily("T", "123", SPEC, day("2030-05-01"), day("2030-05-01"), budget()),
    ).toEqual({
      status: "unsupported",
    });
  });

  it("retries transient failures with capped, jittered backoff, then gives up", async () => {
    const { client, sleeps } = stub([fail(4), fail(2, 500), fail(17)]);
    await expect(
      client.instagramDay(
        "T",
        "456",
        META_METRIC_CATALOG.instagram[0],
        day("2030-05-01"),
        budget(),
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(sleeps).toEqual([250, 500]);
  });

  it("does not retry what a retry cannot fix, and never puts Meta's message in the error", async () => {
    for (const [code, expected] of [
      [190, "token_expired"],
      [200, "permission_missing"],
      [10, "permission_missing"],
    ] as const) {
      const { client, sleeps } = stub([fail(code)]);
      const error: unknown = await client
        .postLifetime("T", "1_2", META_METRIC_CATALOG.post[0], budget())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InsightsProviderError);
      expect(error).toMatchObject({ code: expected, platformCode: code });
      expect((error as Error).message).not.toContain("EAAB");
      expect(sleeps).toEqual([]);
    }
  });

  it("refuses malformed answers and ids, and stops at the call budget and the deadline", async () => {
    const malformed = stub([
      ok({ data: [{ name: SPEC.graph, values: [{ value: -3, end_time: "x" }] }] }),
    ]);
    await expect(
      malformed.client.pageDaily("T", "123", SPEC, day("2030-05-01"), day("2030-05-01"), budget()),
    ).rejects.toMatchObject({ code: "provider_malformed" });
    const ids = stub([]);
    await expect(ids.client.postInteractions("T", "../me", budget())).rejects.toMatchObject({
      code: "provider_malformed",
    });
    const limited = stub([ok({ data: [] })]);
    const one = budget(1);
    await limited.client.postLifetime("T", "1_2", META_METRIC_CATALOG.post[0], one);
    await expect(
      limited.client.postLifetime("T", "1_2", META_METRIC_CATALOG.post[0], one),
    ).rejects.toMatchObject({ code: "call_budget_reached" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      stub([]).client.postLifetime(
        "T",
        "1_2",
        META_METRIC_CATALOG.post[0],
        createCallBudget(5, controller.signal),
      ),
    ).rejects.toMatchObject({ code: "deadline_reached" });
  });

  it("sums a post's interactions only when Meta gives every part; a gone post is not found", async () => {
    const { client } = stub([
      ok({
        id: "1_2",
        reactions: { summary: { total_count: 7 } },
        comments: { summary: { total_count: 2 } },
      }),
      ok({ id: "1_3", comments: { summary: { total_count: 2 } } }),
      fail(100),
    ]);
    expect(await client.postInteractions("T", "1_2", budget())).toEqual({
      status: "ok",
      value: 9n,
    });
    expect(await client.postInteractions("T", "1_3", budget())).toEqual({ status: "unsupported" });
    expect(await client.postInteractions("T", "1_4", budget())).toEqual({ status: "not_found" });
  });

  it("asks for read-only permissions only", () => {
    expect(ALL_META_INSIGHTS_SCOPES).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "read_insights",
      "instagram_basic",
      "instagram_manage_insights",
    ]);
    expect(
      ALL_META_INSIGHTS_SCOPES.some((scope) => /manage_posts|ads_management|publish/.test(scope)),
    ).toBe(false);
  });
});

describe("timing", () => {
  it("backs off exponentially with equal jitter, capped", () => {
    expect(backoffDelay(1, DEFAULT_RETRY, () => 0)).toBe(250);
    expect(backoffDelay(1, DEFAULT_RETRY, () => 1)).toBe(500);
    expect(backoffDelay(3, DEFAULT_RETRY, () => 1)).toBe(2000);
    expect(backoffDelay(20, DEFAULT_RETRY, () => 1)).toBe(DEFAULT_RETRY.maxDelayMs);
    expect(retryDelayMs(1)).toBe(3_600_000);
    expect(retryDelayMs(3)).toBe(4 * 3_600_000);
    expect(retryDelayMs(30)).toBe(24 * 3_600_000);
  });

  it("reads complete days only, from the coverage minus revision days, bounded", () => {
    const now = new Date("2030-05-20T10:00:00Z");
    expect(syncWindow(null, now)).toEqual({
      from: new Date(day("2030-05-19").getTime() - (INITIAL_DAYS - 1) * 86_400_000),
      to: new Date(day("2030-05-19").getTime() - (INITIAL_DAYS - MAX_DAYS_PER_RUN) * 86_400_000),
    });
    expect(syncWindow(day("2030-05-19"), now)).toEqual({
      from: day("2030-05-17"),
      to: day("2030-05-19"),
    });
    // Long gap: never older than the backfill limit.
    expect(syncWindow(day("2029-01-01"), now)?.from).toEqual(day("2030-02-19"));
    // Today is not complete; nothing due when the coverage is ahead (clock moved back).
    expect(syncWindow(day("2030-05-30"), now)).toBeNull();
  });

  it("says what a source's state means", () => {
    const now = new Date("2030-05-20T10:00:00Z");
    const base = {
      enabled: true,
      leaseUntil: null,
      lastSuccessAt: new Date(now.getTime() - 3_600_000),
      lastAttemptAt: new Date(now.getTime() - 3_600_000),
      lastErrorCode: null,
    };
    expect(sourceStatus(base, "ready", now)).toBe("ready");
    expect(sourceStatus({ ...base, enabled: false }, "ready", now)).toBe("disabled");
    expect(sourceStatus(base, "needs_reauth", now)).toBe("needs_reauth");
    expect(sourceStatus({ ...base, lastErrorCode: "token_expired" }, "ready", now)).toBe(
      "needs_reauth",
    );
    expect(
      sourceStatus({ ...base, leaseUntil: new Date(now.getTime() + 1000) }, "ready", now),
    ).toBe("running");
    expect(sourceStatus({ ...base, lastSuccessAt: null }, "ready", now)).toBe("never_synced");
    expect(
      sourceStatus({ ...base, lastErrorCode: "rate_limited", lastAttemptAt: now }, "ready", now),
    ).toBe("failed");
    expect(
      sourceStatus(
        { ...base, lastSuccessAt: new Date(now.getTime() - STALE_AFTER_MS - 1) },
        "ready",
        now,
      ),
    ).toBe("stale");
  });
});

describe("revisions and sources of the same number", () => {
  const obs = (over: Partial<Observation>): Observation => ({
    campaignId: "c",
    contentItemId: "p1",
    channel: "FACEBOOK_PAGE",
    provider: "meta",
    source: "VERIFIED",
    metric: "VIEWS",
    periodStart: day("2030-05-01"),
    periodEnd: day("2030-05-10"),
    value: 100n,
    currency: null,
    sourceRef: "meta:post:1_2:post_media_view",
    observedAt: day("2030-05-10"),
    ...over,
  });

  it("counts the latest revision of an identity once", () => {
    // The latest is neither first nor last in the given order.
    const rows = distinctObservations([
      obs({}),
      obs({ value: 150n, observedAt: day("2030-05-12") }),
      obs({ value: 120n, observedAt: day("2030-05-11") }),
    ]);
    expect(rows.map((row) => row.value)).toEqual([150n]);
  });

  it("prefers Meta's numbers to a person's for the same content and metric, never adds both", () => {
    const manual = obs({ provider: "manual", source: "MANUAL", sourceRef: "manual:x", value: 90n });
    const clicks = obs({
      provider: "manual",
      source: "MANUAL",
      sourceRef: "manual:y",
      metric: "CLICKS",
    });
    const campaignLevel = obs({
      provider: "manual",
      source: "MANUAL",
      sourceRef: "manual:z",
      contentItemId: null,
    });
    expect(preferVerified([manual, obs({}), clicks, campaignLevel])).toEqual([
      obs({}),
      clicks,
      campaignLevel,
    ]);
    expect(preferVerified([manual])).toEqual([manual]);
  });
});
