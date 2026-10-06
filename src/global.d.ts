import type messages from "../messages/ar.json";
import type { Locale } from "./i18n/config";

// Typed translations: `t("home.title")` is checked against messages/ar.json (the source
// of truth). A unit test enforces that en.json has exactly the same keys.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
