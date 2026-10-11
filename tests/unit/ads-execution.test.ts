import { describe, expect, it } from "vitest";

import { AdPlatformError, type StepContext } from "@/server/ads/adapter";
import { createSnapchatWriter, createTikTokWriter } from "@/server/ads/adapters/blocked-writers";
import { createMetaAdapter } from "@/server/ads/adapters/meta";
import {
  createMetaWriter,
  metaStepParams,
  metaSupportsCurrency,
  metaSupportsObjective,
  metaSupportsPlacements,
  metaTargeting,
} from "@/server/ads/adapters/meta-writer";
import { createWhatsAppAdapter, whatsAppMessageBody } from "@/server/ads/adapters/whatsapp";
import { fromPlatformError } from "@/server/ads/errors";
import { executionTag } from "@/server/ads/execution";
import { recommendOptimizations } from "@/server/ads/optimization";
import { parseBudget } from "@/server/ads/planner-math";
import {
  advanceStatus,
  consentKeyword,
  normalizePhone,
  phoneHash,
  windowOpen,
  type MessageStatus,
} from "@/server/whatsapp/messaging";

// Pure rules of the execution slice. No network: every "platform" is a function returning
// canned responses, so these prove Flexibx's classification and request building only —
// not that a platform accepts them.

const KEY = Buffer.alloc(32, 7).toString("base64");

function context(overrides: Partial<StepContext["request"]> = {}): StepContext {
  return {
    tag: executionTag("12345678-90ab-4cde-8f01-23456789abcd"),
    identityId: "555000",
    ids: {},
    media: null,
    request: {
      planId: "p",
      accountExternalId: "111",
      currency: "SAR",
      budgetTotalMinor: 150_000,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      timeZone: "Asia/Riyadh",
      media: null,
      spec: {
        objective: "TRAFFIC",
        campaignName: "Autumn",
        audience: {
          description: "x",
          countries: ["SA"],
          ageMin: 25,
          ageMax: 44,
          genders: "ALL",
          interests: [],
        },
        placements: ["FACEBOOK_FEED"],
        creative: {
          headline: "Fresh",
          primaryText: "Coffee",
          callToAction: "LEARN_MORE",
          mediaAssetId: null,
          destinationUrl: "https://shop.example.com/x",
        },
        rationale: "r",
      },
      ...overrides,
    },
  };
}

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("execution tags and budget units", () => {
  it("tags every plan's objects with a stable, short tag", () => {
    expect(executionTag("12345678-90ab-4cde-8f01-23456789abcd")).toBe("fx-1234567890ab");
  });

  it("keeps budgets in the currency's minor units and refuses unverified offsets on Meta", () => {
    expect(parseBudget("1500.50", "SAR")).toBe(150_050);
    expect(parseBudget("1,000", "USD")).toBe(100_000);
    expect(parseBudget("١٠٠٠", "AED")).toBe(100_000);
    expect(parseBudget("1000", "JPY")).toBe(1000);
    expect(parseBudget("1.5", "KWD")).toBe(1500);
    expect(metaStepParams("adset", context())).toMatchObject({ lifetime_budget: 150_000 });
    for (const currency of ["SAR", "USD", "AED", "EUR"])
      expect(metaSupportsCurrency(currency)).toBe(true);
    // Three decimals, no decimals, or Meta's own offset despite two ISO decimals.
    for (const currency of ["JPY", "KWD", "BHD", "COP", "HUF", "TWD", "KRW"]) {
      expect(metaSupportsCurrency(currency)).toBe(false);
      expect(() => metaStepParams("adset", context({ currency }))).toThrow(AdPlatformError);
    }
  });
});

describe("the Meta writer", () => {
  it("creates everything PAUSED, tagged, and supports only objectives it can complete", () => {
    const ctx = context();
    for (const step of ["campaign", "adset", "ad"] as const) {
      expect(metaStepParams(step, ctx)).toMatchObject({ status: "PAUSED" });
    }
    expect(String(metaStepParams("campaign", ctx).name)).toContain(`[${ctx.tag}]`);
    expect(metaSupportsObjective("TRAFFIC")).toBe(true);
    for (const objective of [
      "SALES",
      "LEADS",
      "APP_PROMOTION",
      "MESSAGES",
      "ENGAGEMENT",
    ] as const) {
      expect(metaSupportsObjective(objective)).toBe(false);
    }
  });

  it("marks a write uncertain only when it may have taken effect", async () => {
    const run = async (fetchImpl: () => Promise<Response>) => {
      const writer = createMetaWriter({
        appSecret: "s".repeat(32),
        version: "v26.0",
        fetch: fetchImpl,
      });
      return writer.runStep("t", "campaign", context()).catch((error: unknown) => error);
    };
    const network = await run(() => Promise.reject(new TypeError("fetch failed")));
    expect(network).toMatchObject({ uncertain: true });
    expect(await run(respond(500, { error: { code: 2 } }))).toMatchObject({ uncertain: true });
    expect(await run(respond(200, { nothing: true }))).toMatchObject({ uncertain: true });
    expect(await run(respond(400, { error: { code: 100 } }))).toMatchObject({
      kind: "invalid_request",
      uncertain: false,
    });
    expect(await run(respond(200, { id: "123" }))).toBe("123");
    // Reads are never uncertain: nothing was written.
    const writer = createMetaWriter({
      appSecret: "s".repeat(32),
      version: "v26.0",
      fetch: () => Promise.reject(new TypeError("x")),
    });
    await expect(writer.findStep("t", "campaign", context())).rejects.toMatchObject({
      uncertain: false,
    });
    await expect(writer.findStep("t", "media", context())).resolves.toBeNull();
  });

  it("treats Meta's unknown and temporary errors to a write as unknown outcomes", async () => {
    const writer = (status: number, code: number) =>
      createMetaWriter({
        appSecret: "s".repeat(32),
        version: "v26.0",
        fetch: respond(status, { error: { code } }),
      });
    for (const code of [1, 2]) {
      await expect(writer(400, code).runStep("t", "campaign", context())).rejects.toMatchObject({
        uncertain: true,
      });
    }
    await expect(writer(400, 17).runStep("t", "campaign", context())).rejects.toMatchObject({
      kind: "rate_limited",
      uncertain: false,
    });
  });

  it("accepts only explicit Facebook placements and lists only Pages it may advertise on", async () => {
    expect(metaSupportsPlacements(["FACEBOOK_FEED", "FACEBOOK_STORIES"])).toBe(true);
    // Meta's default placements include Instagram: AUTOMATIC is refused, like Instagram.
    expect(metaSupportsPlacements(["AUTOMATIC"])).toBe(false);
    expect(metaSupportsPlacements(["FACEBOOK_FEED", "INSTAGRAM_FEED"])).toBe(false);
    expect(metaSupportsPlacements([])).toBe(false);
    expect(metaTargeting(context().request)).toMatchObject({
      publisher_platforms: ["facebook"],
      facebook_positions: ["feed"],
    });
    expect(metaTargeting(context().request)).not.toHaveProperty("instagram_positions");
    const pages: unknown[][] = [];
    const lister = (responses: unknown[]) =>
      createMetaWriter({
        appSecret: "s".repeat(32),
        version: "v26.0",
        fetch: () => {
          const body = responses.shift();
          pages.push([body]);
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        },
      }).listIdentities("t", "111");
    expect(
      await lister([
        {
          data: [
            { id: "1", name: "A", tasks: ["ADVERTISE"] },
            { id: "2", name: "B", tasks: ["ANALYZE"] },
            { id: "3", name: "C" },
          ],
        },
      ]),
    ).toEqual({ identities: [{ id: "1", name: "A" }], complete: true });
    // Follows cursors to the end.
    expect(
      await lister([
        {
          data: [{ id: "1", name: "A", tasks: ["ADVERTISE"] }],
          paging: { next: "https://graph.facebook.com/n", cursors: { after: "c1" } },
        },
        { data: [{ id: "2", name: "B", tasks: ["ADVERTISE", "MANAGE"] }] },
      ]),
    ).toEqual({
      identities: [
        { id: "1", name: "A" },
        { id: "2", name: "B" },
      ],
      complete: true,
    });
  });

  it("proves an object absent only after reading its parent's whole list", async () => {
    const calls: string[] = [];
    const finder = (responses: unknown[]) =>
      createMetaWriter({
        appSecret: "s".repeat(32),
        version: "v26.0",
        fetch: (input) => {
          calls.push(new URL(input instanceof URL ? input.href : (input as string)).pathname);
          return Promise.resolve(new Response(JSON.stringify(responses.shift()), { status: 200 }));
        },
      });
    const ctx = { ...context(), ids: { campaign: "c9" } };
    const tag = ctx.tag;
    // Found on the second page of the campaign's ad sets.
    await expect(
      finder([
        {
          data: [{ id: "s1", name: "other [fx-000000000000]" }],
          paging: { next: "n", cursors: { after: "x" } },
        },
        { data: [{ id: "s2", name: `Autumn [${tag}]` }] },
      ]).findStep("t", "adset", ctx),
    ).resolves.toBe("s2");
    expect(calls.every((path) => path.endsWith("/c9/adsets"))).toBe(true);
    // Not in a complete list: absent.
    await expect(finder([{ data: [] }]).findStep("t", "adset", ctx)).resolves.toBeNull();
    // A list that never ends within the read limit proves nothing: the lookup fails.
    const endless = Array.from({ length: 30 }, () => ({
      data: [],
      paging: { next: "n", cursors: { after: "x" } },
    }));
    await expect(finder(endless).findStep("t", "adset", ctx)).rejects.toMatchObject({
      kind: "provider_error",
      uncertain: false,
    });
  });

  it("reports an uncertain platform error as an unknown outcome, never a plain failure", () => {
    expect(fromPlatformError(new AdPlatformError("provider_error", 2, true))).toMatchObject({
      fields: [{ code: "ads_outcome_unknown" }],
    });
    expect(fromPlatformError(new AdPlatformError("provider_error", 2))).toMatchObject({
      fields: [{ code: "ads_provider_error" }],
    });
  });
});

describe("Snapchat and TikTok write boundaries", () => {
  it("are not ready and refuse every operation without calling anything", async () => {
    for (const writer of [createSnapchatWriter(), createTikTokWriter()]) {
      expect(writer.ready).toBe(false);
      expect(writer.blocker).toMatch(/unverified/);
      expect(writer.supportsObjective("TRAFFIC")).toBe(false);
      expect(writer.supportsCurrency("SAR")).toBe(false);
      for (const call of [
        () => writer.listIdentities("t", "1"),
        () => writer.runStep("t", "campaign", context()),
        () => writer.findStep("t", "campaign", context()),
        () => writer.activate("t", context().request, {}),
        () => writer.readState("t", {}),
      ] as (() => Promise<unknown>)[]) {
        await expect(Promise.resolve().then(call)).rejects.toMatchObject({ kind: "unavailable" });
      }
    }
  });
});

describe("WhatsApp messaging rules", () => {
  it("accepts only international numbers", () => {
    expect(normalizePhone("+999 55 000 0001")).toBe("999550000001");
    expect(normalizePhone("00999550000001")).toBe("999550000001");
    expect(normalizePhone("+٩٩٩٥٥٠٠٠٠٠٠١")).toBe("999550000001");
    for (const bad of ["0550000001", "999550000001", "+0123456789", "+12", "+999 abc", ""]) {
      expect(normalizePhone(bad)).toBeNull();
    }
  });

  it("hashes numbers per workspace and account with the server key", () => {
    const a = phoneHash(KEY, { workspaceId: "w1", accountId: "a1" }, "999550000001");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneHash(KEY, { workspaceId: "w2", accountId: "a1" }, "999550000001")).not.toBe(a);
    expect(
      phoneHash(
        Buffer.alloc(32, 8).toString("base64"),
        { workspaceId: "w1", accountId: "a1" },
        "999550000001",
      ),
    ).not.toBe(a);
  });

  it("treats only an exact keyword as an opt-out or opt-in", () => {
    for (const text of ["STOP", " stop. ", "إيقاف", "الغاء الاشتراك", "Unsubscribe"]) {
      expect(consentKeyword(text)).toBe("out");
    }
    for (const text of ["START", "اشتراك"]) expect(consentKeyword(text)).toBe("in");
    for (const text of ["please don't stop", "stop sending at 5", "hello", null]) {
      expect(consentKeyword(text)).toBeNull();
    }
  });

  it("opens the free-text window for 24 hours after the customer's message", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(windowOpen(null, now)).toBe(false);
    expect(windowOpen(new Date("2026-10-09T12:00:01Z"), now)).toBe(true);
    expect(windowOpen(new Date("2026-10-09T12:00:00Z"), now)).toBe(false);
    expect(windowOpen(new Date("2026-10-10T13:00:00Z"), now)).toBe(false); // from the future
  });

  it("moves message statuses forward only", () => {
    const cases: [MessageStatus, "sent" | "delivered" | "read" | "failed", MessageStatus | null][] =
      [
        ["ACCEPTED", "sent", "SENT"],
        ["ACCEPTED", "read", "READ"],
        ["READ", "delivered", null],
        ["DELIVERED", "sent", null],
        ["SENT", "failed", "FAILED"],
        ["DELIVERED", "failed", null],
        ["FAILED", "read", null],
        ["CANCELLED", "sent", null],
        ["READ", "read", null],
      ];
    for (const [current, report, next] of cases) expect(advanceStatus(current, report)).toBe(next);
  });

  it("builds the Cloud API body and classifies send failures", async () => {
    expect(whatsAppMessageBody({ kind: "TEXT", to: "999550000001", text: "Hi" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "999550000001",
      type: "text",
      text: { preview_url: false, body: "Hi" },
    });
    const send = async (fetchImpl: () => Promise<Response>, to = "999550000001") => {
      const adapter = createWhatsAppAdapter({
        appId: "1",
        appSecret: "s".repeat(32),
        configId: "2",
        version: "v26.0",
        fetch: fetchImpl,
      });
      return adapter
        .sendMessage("t", "2000000001", { kind: "TEXT", to, text: "Hi" })
        .catch((error: unknown) => error);
    };
    expect(await send(respond(200, { messages: [{ id: "wamid.X" }] }))).toEqual({
      messageId: "wamid.X",
    });
    expect(await send(() => Promise.reject(new TypeError("x")))).toMatchObject({ uncertain: true });
    expect(await send(respond(503, { error: { code: 1 } }))).toMatchObject({ uncertain: true });
    expect(await send(respond(200, { messages: [] }))).toMatchObject({ uncertain: true });
    expect(await send(respond(400, { error: { code: 131_047 } }))).toMatchObject({
      kind: "invalid_request",
      platformCode: 131_047,
      uncertain: false,
    });
    expect(await send(respond(400, { error: { code: 130_429 } }))).toMatchObject({
      kind: "rate_limited",
      uncertain: false,
    });
    let called = false;
    const refused = await send(() => {
      called = true;
      return Promise.resolve(new Response("{}"));
    }, "+999");
    expect(refused).toMatchObject({ kind: "invalid_request" });
    expect(called).toBe(false);
  });
});

describe("optimization recommendations", () => {
  const campaign = (id: string, status: "ACTIVE" | "PAUSED", daily: number | null) => ({
    externalId: id,
    name: `Campaign ${id}`,
    objective: "TRAFFIC" as const,
    status,
    dailyBudget: daily === null ? null : { minor: daily, currency: "SAR" },
    lifetimeBudget: null,
    startAt: null,
    stopAt: null,
  });
  const metric = (id: string, impressions: number, clicks: number, spend: number) => ({
    campaignExternalId: id,
    impressions,
    reach: null,
    clicks,
    spend: { minor: spend, currency: "SAR" },
  });
  const snapshot = (
    campaigns: ReturnType<typeof campaign>[],
    metrics: ReturnType<typeof metric>[],
  ) => ({
    version: 1 as const,
    fetchedAt: "2026-10-10T00:00:00.000Z",
    range: { days: 30 },
    campaigns,
    adSets: [],
    ads: [],
    metrics,
    truncated: false,
  });

  it("labels everything historical and judges nothing without enough data", () => {
    const report = recommendOptimizations(
      snapshot(
        [campaign("a", "ACTIVE", 10_000), campaign("b", "ACTIVE", 10_000)],
        [metric("a", 50_000, 1_000, 100_000), metric("b", 500, 0, 5_000)],
      ),
    );
    expect(report.basis).toEqual({
      kind: "historical",
      days: 30,
      fetchedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(report.insufficient).toEqual(["Campaign b"]);
    expect(report.recommendations).toEqual([]);
  });

  it("recommends pausing and refreshing underperformers and moving budget without raising the total", () => {
    const report = recommendOptimizations(
      snapshot(
        [
          campaign("a", "ACTIVE", 10_000),
          campaign("b", "ACTIVE", 20_000),
          campaign("c", "ACTIVE", 10_000),
          campaign("d", "PAUSED", 10_000),
        ],
        [
          metric("a", 10_000, 300, 50_000),
          metric("b", 10_000, 0, 40_000),
          metric("c", 10_000, 250, 50_000),
          metric("d", 10_000, 10, 50_000),
        ],
      ),
      { maxDailyBudgetMinor: 12_000 },
    );
    const kinds = report.recommendations.map((item) =>
      item.kind === "redistribute"
        ? `move:${item.from.externalId}->${item.to.externalId}:${String(item.amount.minor)}`
        : `${item.kind}:${item.campaign.externalId}`,
    );
    expect(kinds).toEqual([
      // d is already paused: only a creative suggestion, no pause or move.
      "creative_refresh:d",
      "pause:b",
      "creative_refresh:b",
      // 20% of b's 200.00 is 40.00, capped so a's daily budget stays within the 120.00 cap.
      "move:b->a:2000",
    ]);
    // There is no kind of recommendation that raises spending, activates or messages.
    expect(new Set(report.recommendations.map((item) => item.kind))).toEqual(
      new Set(["pause", "creative_refresh", "redistribute"]),
    );
    expect(report.results.find((r) => r.externalId === "b")?.cpcMinor).toBeNull();
  });
});

describe("Meta sign-in permissions", () => {
  it("asks for write permissions only when campaign creation is enabled", () => {
    const scope = (requestWriteAccess: boolean) =>
      new URL(
        createMetaAdapter({
          appId: "1",
          appSecret: "s".repeat(32),
          version: "v26.0",
          requestWriteAccess,
        }).authorizeUrl({ state: "s", redirectUri: "https://app.test/cb" }),
      ).searchParams.get("scope");
    expect(scope(false)).toBe("ads_read");
    expect(scope(true)).toBe("ads_read,ads_management,pages_show_list,pages_manage_ads");
  });
});
