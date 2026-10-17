import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, getDirection, isLocale, LOCALES } from "@/i18n/config";
import { ERROR_CODE_LIST } from "@/server/errors/codes";
import { VALIDATION_CODES } from "@/server/validation/field-errors";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const MESSAGES = { ar, en } as const;

function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

const SAMPLE_PARAMS = {
  language: "English",
  last: "Oct 16, 2026, 9:00 AM",
  decision: "Approved",
  digest: "abc123",
  code: "0123456789abcdef0123",
  // Credits.
  held: 2,
  subscription: 150,
  purchased: 20,
  today: 4,
  version: "2026-10-provisional",
  required: 3,
  available: 1,
  balance: 170,
  feature: "AI ideas",
  credits: 12,
  value: 3,
  minimum: 3,
  maximum: 10,
  origin: "string",
  format: "email",
  divisor: 5,
  keys: "extra",
  role: "Owner",
  count: 2,
  // Campaign plans (included posts) and progress (published of total).
  included: 1,
  published: 1,
  // Integrations (accounts per connection).
  total: 3,
  selected: 1,
  date: "1 January 2027",
  email: "reem@example.com",
  inviter: "Reem",
  name: "Reem",
  workspace: "Acme",
  minutes: 60,
  // Marketing Core (Phase 3).
  from: "DRAFT",
  to: "IN_REVIEW",
  zone: "Asia/Riyadh",
  page: 1,
  pages: 3,
  target: "1,000",
  start: "1 January 2027",
  end: "31 January 2027",
  // Workspace dashboard.
  percent: "40%",
  // AI Marketing Engine (Phase 4).
  words: "cheap",
  number: 2,
  reason: "timeout",
  days: 30,
  cap: 300,
  amount: "1500.00",
  currency: "SAR",
  title: "Launch post",
  width: 1200,
  height: 800,
  size: "1.2 MB",
  // Generated video retention.
  hours: 48,
  seconds: 8,
  // Platform admin → Storage.
  provider: "Wasabi",
  fields: "region, bucket",
  media: 3,
  videos: 1,
  // Video generation.
  max: 2,
  aspect: "Landscape 16:9",
  resolution: "720p",
  tier: "Draft",
  // Advertising.
  campaigns: 3,
  adSets: 4,
  ads: 6,
  ctr: "1.2",
  id: "120200000000",
  // Execution and optimization.
  median: "2.4%",
  names: "Campaign A",
  // Marketing intelligence (Pass 5).
  metric: "Impressions",
  goal: "Reach 10k people",
  actual: "4,000",
  expected: "5,000",
  spend: "SAR 1,200.00",
  budget: "SAR 1,000.00",
  rate: "2.1%",
  periods: 3,
  compared: 5,
  items: 2,
  others: 4,
  type: "Reel",
  status: "Dismissed",
  accepted: 10,
  duplicates: 2,
  rejected: 1,
  row: 4,
  problem: "Unknown metric",
};

describe("locale configuration", () => {
  it("is Arabic-first with correct directions", () => {
    expect(DEFAULT_LOCALE).toBe("ar");
    expect(getDirection("ar")).toBe("rtl");
    expect(getDirection("en")).toBe("ltr");
    expect(isLocale("fr")).toBe(false);
  });

  it("has a message file for every locale", () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...LOCALES].sort());
  });
});

describe("translation messages", () => {
  const arKeys = leafKeys(ar).sort();

  it("ar.json and en.json have identical keys", () => {
    expect(leafKeys(en).sort()).toEqual(arKeys);
  });

  it("have no empty strings", () => {
    for (const locale of LOCALES) {
      for (const key of leafKeys(MESSAGES[locale])) {
        const value = key
          .split(".")
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)[part],
            MESSAGES[locale],
          );
        expect(typeof value === "string" && value.trim().length > 0, `${locale}:${key}`).toBe(true);
      }
    }
  });

  it("are valid ICU messages that format in every locale", () => {
    for (const locale of LOCALES) {
      const t = createTranslator({
        locale,
        messages: MESSAGES[locale],
        onError: (error) => {
          throw error;
        },
      });
      for (const key of arKeys) {
        expect(() => t(key as never, SAMPLE_PARAMS as never), `${locale}:${key}`).not.toThrow();
      }
    }
  });

  it("translate every error code and validation code", () => {
    for (const code of ERROR_CODE_LIST) expect(arKeys).toContain(`errors.${code}`);
    for (const code of VALIDATION_CODES) expect(arKeys).toContain(`validation.${code}`);
  });

  it("select the right plural/format branches", () => {
    const tAr = createTranslator({ locale: "ar", messages: ar });
    const tEn = createTranslator({ locale: "en", messages: en });
    expect(tEn("validation.too_small", { origin: "string", minimum: 3 })).toBe(
      "Must be at least 3 characters.",
    );
    expect(tEn("validation.invalid_format", { format: "email" })).toBe(
      "Enter a valid email address.",
    );
    expect(tAr("validation.invalid_format", { format: "url" })).toBe("يُرجى إدخال رابط صحيح.");
  });
});
