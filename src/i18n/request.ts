import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { locale as rootLocale } from "next/root-params";

import type messages from "../../messages/ar.json";
import { routing } from "./routing";

type Messages = typeof messages;

export default getRequestConfig(async ({ locale: explicitLocale }) => {
  // `[locale]` is the root segment, so Next exposes it as a root param. An explicit
  // locale (e.g. getTranslations({ locale })) takes precedence.
  const requested = explicitLocale ?? (await rootLocale());
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  const loaded = (await import(`../../messages/${locale}.json`)) as { default: Messages };
  return { locale, messages: loaded.default, timeZone: "Asia/Riyadh" };
});
