import { getTranslations } from "next-intl/server";

import { SectionTabs } from "@/components/marketing/page-parts";
import type { Locale } from "@/i18n/config";

/** Brand → Profile / Audiences / Pillars. */
export async function BrandTabs({
  locale,
  slug,
  active,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly active: "profile" | "audiences" | "pillars";
}) {
  const t = await getTranslations({ locale, namespace: "marketing.sections" });
  const base = `/w/${slug}/brand`;
  return (
    <SectionTabs
      label={t("brandLabel")}
      tabs={[
        { href: base, label: t("profile"), active: active === "profile" },
        { href: `${base}/audiences`, label: t("audiences"), active: active === "audiences" },
        { href: `${base}/pillars`, label: t("pillars"), active: active === "pillars" },
      ]}
    />
  );
}

/** Campaigns → Campaigns / Goals. */
export async function CampaignTabs({
  locale,
  slug,
  active,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly active: "campaigns" | "goals";
}) {
  const t = await getTranslations({ locale, namespace: "marketing.sections" });
  const base = `/w/${slug}/campaigns`;
  return (
    <SectionTabs
      label={t("campaignsLabel")}
      tabs={[
        { href: base, label: t("campaigns"), active: active === "campaigns" },
        { href: `${base}/goals`, label: t("goals"), active: active === "goals" },
      ]}
    />
  );
}
