import { notFound } from "next/navigation";

import { isLocale, type Locale } from "./config";

/** Validates the `[locale]` route segment; unknown locales render a 404. */
export function requireLocale(value: string): Locale {
  if (!isLocale(value)) notFound();
  return value;
}
