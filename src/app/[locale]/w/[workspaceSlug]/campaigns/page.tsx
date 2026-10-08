import { getFormatter, getTranslations } from "next-intl/server";

import {
  Badge,
  CAMPAIGN_STATUS_TONES,
  EmptyState,
  ForbiddenNotice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { fromMinorUnits } from "@/server/marketing/campaign-service";
import { getCampaignsPage } from "@/server/marketing/marketing-queries";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";
import { CampaignTabs } from "../section-tabs";

export default async function CampaignsRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const includeArchived = (await searchParams).archived === "1";
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getCampaignsPage(workspace.slug, includeArchived));
  if (data === null) {
    return <ForbiddenNotice title={t("campaigns.title")} message={t("common.forbidden")} />;
  }
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium", timeZone: "UTC" });
  const base = `/w/${workspace.slug}/campaigns`;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("campaigns.title")}
        description={t("campaigns.description")}
        actions={
          data.can.campaignManage ? (
            <Button asChild data-testid="campaign-new">
              <Link href={`${base}/new`}>{t("campaigns.new")}</Link>
            </Button>
          ) : undefined
        }
      />
      <CampaignTabs locale={locale} slug={workspace.slug} active="campaigns" />
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={includeArchived ? base : `${base}?archived=1`}>
            {includeArchived ? t("campaigns.hideArchived") : t("campaigns.showArchived")}
          </Link>
        </Button>
      </div>

      {data.campaigns.length === 0 ? (
        <EmptyState message={t("campaigns.empty")} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" data-testid="campaign-list">
          {data.campaigns.map((campaign) => (
            <li
              key={campaign.id}
              className="space-y-2 rounded-lg border p-4"
              data-testid="campaign-row"
            >
              <div className="flex items-start justify-between gap-2">
                <Link href={`${base}/${campaign.id}`} className="font-semibold hover:underline">
                  {campaign.name}
                </Link>
                <Badge tone={CAMPAIGN_STATUS_TONES[campaign.status]}>
                  {t(`enums.campaignStatus.${campaign.status}`)}
                </Badge>
              </div>
              {campaign.objective === null ? null : (
                <p className="line-clamp-2 text-sm text-muted-foreground">{campaign.objective}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {campaign.startDate === null && campaign.endDate === null
                  ? t("campaigns.noDates")
                  : t("goals.period", {
                      start: campaign.startDate === null ? "…" : date(campaign.startDate),
                      end: campaign.endDate === null ? "…" : date(campaign.endDate),
                    })}
                {" · "}
                {t("dashboard.contentCount", { count: campaign._count.contentItems })}
              </p>
              {campaign.budgetAmountMinor === null || campaign.budgetCurrency === null ? null : (
                <p className="text-xs text-muted-foreground">
                  {t("campaigns.budget", {
                    amount: fromMinorUnits(campaign.budgetAmountMinor),
                    currency: campaign.budgetCurrency,
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
