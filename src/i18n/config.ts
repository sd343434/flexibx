// Locale configuration — the single place to add a language:
//   1. add it to LOCALES and LOCALE_DIRECTIONS, 2. add messages/<locale>.json,
//   3. (if persisted per user/workspace) add it to the Prisma `Locale` enum.

export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Arabic-first: Arabic is the default for new visitors without a preference. */
export const DEFAULT_LOCALE: Locale = "ar";

export type Direction = "rtl" | "ltr";

export const LOCALE_DIRECTIONS: Readonly<Record<Locale, Direction>> = {
  ar: "rtl",
  en: "ltr",
};

/** Cookie remembering an explicit locale choice (read by the proxy before Accept-Language). */
export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): Direction {
  return LOCALE_DIRECTIONS[locale];
}
