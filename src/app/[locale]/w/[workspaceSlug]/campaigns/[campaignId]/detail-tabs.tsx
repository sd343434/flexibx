import { getTranslations } from "next-intl/server";

import { SectionTabs } from "@/components/marketing/page-parts";
import type { Locale } from "@/i18n/config";

/** One campaign → Overview (progress) / Content plan. */
export async function CampaignDetailTabs({
  locale,
  slug,
  campaignId,
  active,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly campaignId: string;
  readonly active: "overview" | "plan";
}) {
  const t = await getTranslations({ locale, namespace: "marketing.campaignTabs" });
  const base = `/w/${slug}/campaigns/${campaignId}`;
  return (
    <SectionTabs
      label={t("label")}
      tabs={[
        { href: base, label: t("overview"), active: active === "overview" },
        { href: `${base}/plan`, label: t("plan"), active: active === "plan" },
      ]}
    />
  );
}
