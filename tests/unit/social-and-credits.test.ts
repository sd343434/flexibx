import { describe, expect, it } from "vitest";

import {
  addMonth,
  featureForOperation,
  FEATURE_PRICES,
  marginMicros,
  providerCostMicros,
} from "@/server/billing/pricing";
import { customerLanguage, renderKnowledge } from "@/server/social/social-service";
import { parseSocialWebhook } from "@/server/social/webhook";

const now = new Date("2026-10-12T10:00:00Z");
const seconds = Math.floor(now.getTime() / 1000);

describe("Instagram and Page webhooks", () => {
  it("reads Instagram comments and direct messages, skipping the account's own and echoes", () => {
    const events = parseSocialWebhook(
      {
        object: "instagram",
        entry: [
          {
            id: "17841400000",
            time: seconds,
            changes: [
              {
                field: "comments",
                value: {
                  id: "1790001",
                  text: "Price?",
                  from: { id: "555", username: "lina" },
                  media: { id: "1780001" },
                },
              },
              {
                field: "comments",
                value: {
                  id: "1790002",
                  text: "Thanks!",
                  from: { id: "17841400000" },
                  media: { id: "1780001" },
                },
              },
            ],
            messaging: [
              {
                sender: { id: "999" },
                recipient: { id: "17841400000" },
                timestamp: now.getTime(),
                message: { mid: "aWdfZA", text: "Hello" },
              },
              {
                sender: { id: "17841400000" },
                recipient: { id: "999" },
                timestamp: now.getTime(),
                message: { mid: "aWdfZB", text: "Hi", is_echo: true },
              },
            ],
          },
        ],
      },
      now,
    );
    expect(events).toEqual([
      expect.objectContaining({
        platform: "INSTAGRAM",
        kind: "COMMENT",
        externalId: "1790001",
        threadExternalId: "1780001",
        authorName: "lina",
      }),
      expect.objectContaining({
        platform: "INSTAGRAM",
        kind: "MESSAGE",
        externalId: "aWdfZA",
        threadExternalId: "999",
      }),
    ]);
  });

  it("ignores other objects, malformed entries and events from the future", () => {
    expect(parseSocialWebhook({ object: "whatsapp_business_account", entry: [] }, now)).toBeNull();
    expect(parseSocialWebhook("nope", now)).toBeNull();
    const future = parseSocialWebhook(
      {
        object: "page",
        entry: [
          {
            id: "1",
            messaging: [
              {
                sender: { id: "2" },
                timestamp: now.getTime() + 3_600_000,
                message: { mid: "m.x", text: "later" },
              },
            ],
          },
        ],
      },
      now,
    );
    expect(future).toEqual([]);
  });
});

describe("agent knowledge", () => {
  it("detects the customer's language", () => {
    expect(customerLanguage("هل التوصيل متاح؟")).toBe("ar");
    expect(customerLanguage("Do you deliver?")).toBe("en");
  });

  it("renders only the sections the agent has, with rules and examples", () => {
    const text = renderKnowledge(
      {
        role: "sales",
        tone: "",
        businessInfo: "Bakery",
        faq: [{ q: "Gluten free?", a: "Yes, on Fridays." }, "bad"],
        policies: "",
        escalation: "",
        forbidden: "",
        guidance: "",
      },
      [{ customerText: "Open?", content: "Until 9pm." }],
      [{ content: "No discounts." }],
      { platform: "INSTAGRAM", kind: "MESSAGE" },
    );
    expect(text).toContain("Instagram private message");
    expect(text).toContain("Bakery");
    expect(text).toContain("Q: Gluten free?");
    expect(text).toContain("- No discounts.");
    expect(text).toContain("Reply: Until 9pm.");
    expect(text).not.toContain("## Policies");
  });
});

describe("credit pricing", () => {
  it("prices every AI operation", () => {
    expect(featureForOperation("IDEAS")).toBe("ai_text");
    expect(featureForOperation("AD_PLAN")).toBe("ad_plan");
    expect(featureForOperation("SOCIAL_REPLY")).toBe("social_reply");
    expect(FEATURE_PRICES[featureForOperation("SOCIAL_LEARNING")]).toBeGreaterThan(0);
  });

  it("computes provider cost only from known prices and token counts", () => {
    expect(
      providerCostMicros(
        { inputTokens: 1000, outputTokens: 500 },
        { inputPerMTok: 2, outputPerMTok: 8 },
      ),
    ).toBe(6000n);
    expect(
      providerCostMicros(
        { inputTokens: null, outputTokens: 500 },
        { inputPerMTok: 2, outputPerMTok: 8 },
      ),
    ).toBeNull();
    expect(
      providerCostMicros(
        { inputTokens: 1, outputTokens: 1 },
        { inputPerMTok: null, outputPerMTok: 8 },
      ),
    ).toBeNull();
    expect(marginMicros(10, 20_000, 6000n)).toBe(194_000n);
    expect(marginMicros(10, null, 6000n)).toBeNull();
  });

  it("adds calendar months, clamping to the month's end", () => {
    expect(addMonth(new Date("2026-01-31T12:00:00Z")).toISOString()).toBe(
      "2026-02-28T12:00:00.000Z",
    );
    expect(addMonth(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe(
      "2027-01-15T00:00:00.000Z",
    );
  });
});
