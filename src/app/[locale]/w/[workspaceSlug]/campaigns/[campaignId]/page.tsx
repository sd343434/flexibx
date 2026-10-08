import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import {
  Badge,
  CAMPAIGN_STATUS_TONES,
  CONTENT_STATUS_TONES,
  Card,
  Detail,
  EmptyState,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { fromMinorUnits } from "@/server/marketing/campaign-service";
import { getCampaignPage } from "@/server/marketing/marketing-queries";

import { campaignFields } from "../../form-fields";
import { submitCampaign, submitCampaignStatus } from "../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";
import { CampaignTabs } from "../../section-tabs";

export default async function CampaignRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly campaignId: string }>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { campaignId } = await params;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getCampaignPage(workspace.slug, campaignId));
  if (data === null) {
    return <ForbiddenNotice title={t("campaigns.title")} message={t("common.forbidden")} />;
  }
  const { campaign } = data;
  const date = (value: Date | null) =>
    value === null
      ? t("common.notSet")
      : format.dateTime(value, { dateStyle: "medium", timeZone: "UTC" });

  return (
    <div className="space-y-8">
      <PageHeader
        title={campaign.name}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${workspace.slug}/campaigns`}>{t("common.back")}</Link>
          </Button>
        }
      />
      <CampaignTabs locale={locale} slug={workspace.slug} active="campaigns" />

      <Card
        title={t("campaigns.statusTitle")}
        actions={
          <Badge tone={CAMPAIGN_STATUS_TONES[campaign.status]} testId="campaign-status">
            {t(`enums.campaignStatus.${campaign.status}`)}
          </Badge>
        }
      >
        {data.nextStatuses.length === 0 ? null : (
          <>
            <p className="text-sm text-muted-foreground">{t("campaigns.statusHint")}</p>
            <div className="flex flex-wrap gap-2" data-testid="campaign-status-actions">
              {data.nextStatuses.map((status) => (
                <ActionButton
                  key={status}
                  action={submitCampaignStatus.bind(
                    null,
                    workspace.slug,
                    locale,
                    campaign.id,
                    status,
                  )}
                  label={t(`enums.campaignAction.${status}`)}
                  confirm={status === "ARCHIVED" ? t("campaigns.archiveConfirm") : undefined}
                  danger={status === "ARCHIVED"}
                  testId={`campaign-status-${status}`}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      {data.editable && data.options !== null ? (
        <Card title={t("campaigns.editTitle")}>
          <EntityForm
            action={submitCampaign.bind(null, workspace.slug, locale, campaign.id)}
            fields={campaignFields(t, campaign, data.options)}
            submitLabel={t("campaigns.submitUpdate")}
            testId="campaign-form"
          />
        </Card>
      ) : (
        <Card title={t("campaigns.editTitle")}>
          {data.can.campaignManage ? null : (
            <Notice testId="view-only">{t("common.viewOnly")}</Notice>
          )}
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label={t("campaigns.fields.objective")}>
              {campaign.objective ?? t("common.notSet")}
            </Detail>
            <Detail label={t("campaigns.audience")}>
              {campaign.audience?.name ?? t("common.none")}
            </Detail>
            <Detail label={t("campaigns.fields.startDate")}>{date(campaign.startDate)}</Detail>
            <Detail label={t("campaigns.fields.endDate")}>{date(campaign.endDate)}</Detail>
            <Detail label={t("campaigns.goalsLinked")}>
              {campaign.goals.length === 0
                ? t("common.none")
                : campaign.goals.map((link) => link.goal.title).join("، ")}
            </Detail>
            <Detail label={t("campaigns.pillarsLinked")}>
              {campaign.pillars.length === 0
                ? t("common.none")
                : campaign.pillars.map((link) => link.pillar.name).join("، ")}
            </Detail>
            {campaign.budgetAmountMinor === null || campaign.budgetCurrency === null ? null : (
              <Detail label={t("campaigns.fields.budgetAmount")}>
                {`${fromMinorUnits(campaign.budgetAmountMinor)} ${campaign.budgetCurrency}`}
              </Detail>
            )}
            {campaign.description === null ? null : (
              <Detail label={t("campaigns.fields.description")}>{campaign.description}</Detail>
            )}
          </dl>
        </Card>
      )}

      {data.content === null ? null : (
        <Card title={t("campaigns.contentTitle")}>
          {data.content.items.length === 0 ? (
            <EmptyState message={t("campaigns.contentEmpty")} />
          ) : (
            <ul className="divide-y" data-testid="campaign-content">
              {data.content.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                  <Link
                    href={`/w/${workspace.slug}/content/${item.id}`}
                    className="truncate hover:underline"
                  >
                    {item.title}
                  </Link>
                  <Badge tone={CONTENT_STATUS_TONES[item.status]}>
                    {t(`enums.contentStatus.${item.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
