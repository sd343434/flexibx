import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { inclusiveDays } from "@/server/ads/adapter";
import { majorToMinor, readCampaignSpec } from "@/server/ads/model";
import {
  accountHistory,
  expectedResults,
  formatMajor,
  parseBudget,
  renderAdData,
} from "@/server/ads/planner-math";
import { decryptToken, encryptToken, TokenVaultError } from "@/server/ads/token-vault";
import { parseAdsEnv } from "@/server/env-schema";
import { INVITATION_URL_PATTERN, redactSecrets } from "@/server/redact";

// Pure parts of the advertising slice: token encryption, money, estimates, env.

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const BINDING = { workspaceId: "11111111-1111-4111-8111-111111111111", platform: "META" };

describe("token vault", () => {
  it("round-trips and never contains the token in clear", () => {
    const token = "EAAB-secret-token-value";
    const envelope = encryptToken(KEY, token, BINDING);
    expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain(token);
    expect(envelope).not.toContain(Buffer.from(token).toString("base64url"));
    expect(decryptToken(KEY, envelope, BINDING)).toBe(token);
    // A fresh IV every time.
    expect(encryptToken(KEY, token, BINDING)).not.toBe(envelope);
  });

  it("refuses another workspace, platform, key or any tampering", () => {
    const envelope = encryptToken(KEY, "token", BINDING);
    const fails = (fn: () => unknown) => {
      expect(fn).toThrow(TokenVaultError);
    };
    fails(() =>
      decryptToken(KEY, envelope, {
        ...BINDING,
        workspaceId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    fails(() => decryptToken(KEY, envelope, { ...BINDING, platform: "TIKTOK" }));
    fails(() => decryptToken(OTHER_KEY, envelope, BINDING));
    const [version, iv, tag, body] = envelope.split(".") as [string, string, string, string];
    const flipped = body.startsWith("A") ? `B${body.slice(1)}` : `A${body.slice(1)}`;
    fails(() => decryptToken(KEY, [version, iv, tag, flipped].join("."), BINDING));
    fails(() => decryptToken(KEY, ["v2", iv, tag, body].join("."), BINDING));
    fails(() => decryptToken(KEY, "garbage", BINDING));
    fails(() => encryptToken("c2hvcnQ=", "token", BINDING));
  });
});

describe("money", () => {
  it("converts platform major-unit strings exactly per currency", () => {
    expect(majorToMinor("12.34", "SAR")).toBe(1234);
    expect(majorToMinor("12", "SAR")).toBe(1200);
    expect(majorToMinor("12.345", "SAR")).toBe(1235);
    expect(majorToMinor("1500", "JPY")).toBe(1500);
    expect(majorToMinor("1.234", "KWD")).toBe(1234);
    expect(majorToMinor("-1", "SAR")).toBeNull();
    expect(majorToMinor("1e5", "SAR")).toBeNull();
  });

  it("parses a person's budget in Arabic or Western digits", () => {
    expect(parseBudget("1,500.50", "SAR")).toBe(150_050);
    expect(parseBudget("١٥٠٠", "SAR")).toBe(150_000);
    expect(parseBudget("١٬٥٠٠٫٥", "SAR")).toBe(150_050);
    expect(parseBudget("0", "SAR")).toBeNull();
    expect(parseBudget("abc", "SAR")).toBeNull();
    expect(formatMajor({ minor: 150_050, currency: "SAR" })).toBe("1500.50");
    expect(formatMajor({ minor: 5, currency: "SAR" })).toBe("0.05");
    expect(formatMajor({ minor: 1500, currency: "JPY" })).toBe("1500");
    expect(inclusiveDays("2026-11-01", "2026-11-30")).toBe(30);
    expect(inclusiveDays("2026-11-01", "2026-11-01")).toBe(1);
  });
});

describe("expected results", () => {
  const snapshot = (impressions: number, clicks: number, spendMinor: number) => ({
    version: 1 as const,
    fetchedAt: "2026-10-10T00:00:00Z",
    range: { days: 30 },
    campaigns: [],
    adSets: [],
    ads: [],
    metrics: [
      {
        campaignExternalId: "c1",
        impressions,
        reach: null,
        clicks,
        spend: { minor: spendMinor, currency: "SAR" },
      },
    ],
    truncated: false,
  });

  it("estimates only from enough of the account's own history, as a range", () => {
    expect(expectedResults(null, 100_000)).toEqual({ available: false, reason: "no_history" });
    expect(expectedResults(accountHistory(snapshot(1000, 10, 2000), "SAR"), 100_000)).toEqual({
      available: false,
      reason: "insufficient_history",
    });
    // 100,000 impressions for 2,000.00 SAR → CPM 20.00 SAR; CTR 1 %.
    const result = expectedResults(
      accountHistory(snapshot(100_000, 1000, 200_000), "SAR"),
      100_000,
    );
    expect(result).toEqual({
      available: true,
      impressions: { low: 35_000, high: 65_000 },
      clicks: { low: 350, high: 650 },
      basis: { cpm: { minor: 2000, currency: "SAR" }, ctrPercent: 1, days: 30 },
    });
    // History in another currency is not mixed in.
    expect(accountHistory(snapshot(100_000, 1000, 200_000), "USD")).toBeNull();
  });

  it("renders the advertising data block without ids", () => {
    const text = renderAdData({
      language: "en",
      accountName: "Main",
      platform: "META",
      budget: { minor: 150_000, currency: "SAR" },
      days: 30,
      history: null,
      topCampaigns: [{ name: "Old", objective: "TRAFFIC" }],
      assets: [{ handle: "M1", label: "Storefront photo" }],
    });
    expect(text).toContain("1500.00 SAR");
    expect(text).toContain("[M1] Storefront photo");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe("campaign spec", () => {
  it("rejects an impossible audience and unknown values", () => {
    const spec = {
      objective: "TRAFFIC",
      campaignName: "X",
      audience: {
        description: "d",
        countries: ["SA"],
        ageMin: 30,
        ageMax: 25,
        genders: "ALL",
        interests: [],
      },
      placements: ["AUTOMATIC"],
      creative: { headline: "h", primaryText: "p", callToAction: "LEARN_MORE", mediaAssetId: null },
      rationale: "r",
    };
    expect(readCampaignSpec(spec)).toBeNull();
    expect(
      readCampaignSpec({ ...spec, audience: { ...spec.audience, ageMin: 20 } }),
    ).not.toBeNull();
    expect(readCampaignSpec({ ...spec, objective: "SPEND_IT_ALL" })).toBeNull();
    expect(readCampaignSpec({ ...spec, placements: ["TIKTOK_FEED"] })).toBeNull();
  });
});

describe("advertising env", () => {
  it("is off by default, needs id and secret together, and pins a version", () => {
    expect(parseAdsEnv({})).toEqual({ META_GRAPH_VERSION: "v26.0" });
    expect(() => parseAdsEnv({ META_APP_ID: "1234567890" })).toThrow(/META_APP_SECRET/);
    expect(() => parseAdsEnv({ META_GRAPH_VERSION: "latest" })).toThrow();
    expect(
      parseAdsEnv({
        META_APP_ID: "1234567890",
        META_APP_SECRET: "s".repeat(32),
        META_GRAPH_VERSION: "v25.0",
      }),
    ).toMatchObject({ META_APP_ID: "1234567890", META_GRAPH_VERSION: "v25.0" });
  });
});

describe("secret hygiene", () => {
  it("keeps OAuth callback URLs (code, state) out of the `next dev` request log", async () => {
    const { default: config } = await import("../../next.config");
    const { ignoreLoggingIncomingRequests } =
      (await import("next/dist/server/dev/log-requests.js")) as unknown as {
        ignoreLoggingIncomingRequests: (request: { url: string }, logging: unknown) => boolean;
      };
    const ignored = (url: string) => ignoreLoggingIncomingRequests({ url }, config.logging);
    for (const url of [
      "/api/integrations/meta/callback?code=AQD-secret-code&state=abcdefghijklmnopqrstuvwxyz",
      "/api/integrations/meta/callback?error=access_denied&state=abc",
      "/api/integrations/meta/callback",
    ]) {
      expect(INVITATION_URL_PATTERN.test(url), url).toBe(true);
      expect(ignored(url), url).toBe(true);
    }
    for (const url of ["/en/w/acme/ads", "/ar/w/acme/ads?connect=connected", "/api/health"]) {
      expect(ignored(url), url).toBe(false);
    }
  });

  it("redacts token envelopes and app secrets from logged objects", () => {
    const redacted = JSON.stringify(
      redactSecrets({
        tokenCiphertext: "v1.a.b.c",
        accessToken: "EAAB",
        appsecret_proof: "abc",
        META_APP_SECRET: "s",
        platformCode: 190,
      }),
    );
    for (const secret of ["v1.a.b.c", "EAAB", '"abc"', '"s"'])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain("190");
  });
});
