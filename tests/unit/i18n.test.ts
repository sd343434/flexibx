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
  digest: "abc123",
  minimum: 3,
  maximum: 10,
  origin: "string",
  format: "email",
  divisor: 5,
  keys: "extra",
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
