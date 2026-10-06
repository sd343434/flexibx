import { defineRouting } from "next-intl/routing";

import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, LOCALES } from "./config";

/**
 * Every page lives under a locale prefix: /ar/... (RTL) and /en/... (LTR).
 * A request to `/` is redirected using, in order: the NEXT_LOCALE cookie (explicit
 * choice), the Accept-Language header, then the Arabic default.
 */
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "always",
  localeDetection: true,
  localeCookie: {
    name: LOCALE_COOKIE_NAME,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  },
});
