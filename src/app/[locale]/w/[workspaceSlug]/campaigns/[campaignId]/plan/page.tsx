import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  Detail,
  EmptyState,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { FAKE_PROVIDER_NAME } from "@/server/ai/fake-provider";
import {
  isPublishedByFlexibx,
  MARKETING_CHANNELS,
  PLAN_IDEAS_MAX,
  PLAN_IDEAS_MIN,
} from "@/server/marketing/campaign-plan";
import { ENUM_VALUES } from "@/server/marketing/inputs";
import type { CampaignPlanItemView } from "@/server/marketing/plan-service";
import { getCampaignPlanPage } from "@/server/marketing/plan-queries";

import type { MarketingT } from "../../../form-fields";
import {
  dateInput,
  guardPage,
  openWorkspacePage,
  type WorkspaceRouteParams,
} from "../../../page-data";
import { CampaignDetailTabs } from "../detail-tabs";

import {
  submitAddPlanItem,
  submitApprovePlan,
  submitCreatePlanDrafts,
  submitGeneratePlan,
  submitPlanBrief,
  submitReopenPlan,
  submitRemovePlanItem,
  submitUpdatePlanItem,
  type PlanTarget,
} from "./actions";

const channelOptions = (t: MarketingT) =>
  MARKETING_CHANNELS.map((value) => ({ value, label: t(`enums.channel.${value}`) }));

function itemFields(t: MarketingT, item: CampaignPlanItemView | null): FieldSpec[] {
  return [
    {
      kind: "text",
      name: "title",
      label: t("plan.fields.title"),
      required: true,
      maxLength: 200,
      defaultValue: item?.title ?? "",
      wide: true,
    },
    {
      kind: "select",
      name: "contentType",
      label: t("plan.fields.contentType"),
      options: ENUM_VALUES.contentType.map((value) => ({
        value,
        label: t(`enums.contentType.${value}`),
      })),
      defaultValue: item?.contentType ?? "POST",
    },
    {
      kind: "select",
      name: "channel",
      label: t("plan.fields.channel"),
      options: channelOptions(t),
      defaultValue: item?.channel ?? "FACEBOOK_PAGE",
    },
    {
      kind: "date",
      name: "plannedDate",
      label: t("plan.fields.plannedDate"),
      defaultValue: dateInput(item?.plannedDate ?? null),
    },
    {
      kind: "checkbox",
      name: "included",
      label: t("plan.fields.included"),
      defaultChecked: item?.included ?? true,
    },
    {
      kind: "textarea",
      name: "brief",
      label: t("plan.fields.brief"),
      maxLength: 2000,
      rows: 4,
      defaultValue: item?.brief ?? "",
      wide: true,
    },
  ];
}

export default async function CampaignPlanRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly campaignId: string }>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { campaignId } = await params;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getCampaignPlanPage(workspace.slug, campaignId));
  if (data === null) {
    return <ForbiddenNotice title={t("plan.title")} message={t("common.forbidden")} />;
  }
  const { campaign, plan, can } = data;
  const target: PlanTarget = {
    slug: workspace.slug,
    locale,
    campaignId: campaign.id,
    version: plan?.version ?? 0,
  };
  const day = (value: Date) => format.dateTime(value, { dateStyle: "medium", timeZone: "UTC" });
  const items = plan?.items ?? [];
  const included = items.filter((item) => item.included).length;
  const undrafted = items.filter((item) => item.included && item.contentItemId === null).length;
  const status = plan?.status ?? "NONE";
  const approvedAt = plan?.approvedAt ?? null;
  const approver = plan?.approvedBy?.name ?? null;

  return (
    <div className="space-y-8">
      <PageHeader
        title={campaign.name}
        description={t("plan.description")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${workspace.slug}/campaigns`}>{t("common.back")}</Link>
          </Button>
        }
      />
      <CampaignDetailTabs
        locale={locale}
        slug={workspace.slug}
        campaignId={campaign.id}
        active="plan"
      />

      <Card
        title={t("plan.statusTitle")}
        testId="plan-status-card"
        actions={
          <Badge tone={status === "APPROVED" ? "solid" : "muted"} testId="plan-status">
            {t(`enums.planStatus.${status}`)}
          </Badge>
        }
      >
        {approvedAt === null ? null : (
          <p className="text-sm text-muted-foreground">
            {approver === null
              ? t("plan.approvedAt", { date: day(approvedAt) })
              : t("plan.approvedBy", { name: approver, date: day(approvedAt) })}
          </p>
        )}
        {plan === null ? null : (
          <p className="text-xs text-muted-foreground">
            {t("plan.versionNote", { version: plan.version })}
          </p>
        )}
        {campaign.status === "ARCHIVED" ? <Notice>{t("plan.archived")}</Notice> : null}
        {!can.manage && campaign.status !== "ARCHIVED" ? (
          <Notice testId="view-only">{t("plan.viewOnly")}</Notice>
        ) : null}
        {items.some((item) => item.aiGenerated) ? (
          <Notice testId="plan-ai-note">
            {t("plan.aiNote")}
            {plan?.generation?.provider === FAKE_PROVIDER_NAME ? (
              <span className="mt-1 block font-medium" data-testid="plan-ai-test-provider">
                {t("plan.aiTestProvider")}
              </span>
            ) : null}
          </Notice>
        ) : null}
      </Card>

      <Card title={t("plan.briefTitle")} testId="plan-brief-card">
        {can.edit ? (
          <>
            <p className="text-sm text-muted-foreground">{t("plan.briefHint")}</p>
            <EntityForm
              action={submitPlanBrief.bind(null, target)}
              submitLabel={plan === null ? t("plan.startBrief") : t("plan.submitBrief")}
              testId="plan-brief-form"
              fields={[
                {
                  kind: "textarea",
                  name: "offer",
                  label: t("plan.fields.offer"),
                  hint: t("plan.fields.offerHint"),
                  maxLength: 1000,
                  rows: 3,
                  defaultValue: plan?.offer ?? "",
                  wide: true,
                },
                {
                  kind: "multiselect",
                  name: "channels",
                  label: t("plan.fields.channels"),
                  hint: t("plan.fields.channelsHint"),
                  options: channelOptions(t),
                  defaultValue: plan?.channels ?? ["FACEBOOK_PAGE"],
                  emptyLabel: t("plan.fields.channelsEmpty"),
                  wide: true,
                },
                {
                  kind: "textarea",
                  name: "budgetNotes",
                  label: t("plan.fields.budgetNotes"),
                  hint: t("plan.fields.budgetNotesHint"),
                  maxLength: 1000,
                  rows: 2,
                  defaultValue: plan?.budgetNotes ?? "",
                  wide: true,
                },
              ]}
            />
          </>
        ) : plan === null ? (
          <EmptyState message={t("progress.empty")} />
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label={t("plan.fields.offer")}>{plan.offer ?? t("common.notSet")}</Detail>
            <Detail label={t("plan.fields.channels")}>
              {plan.channels.length === 0
                ? t("common.none")
                : plan.channels.map((channel) => t(`enums.channel.${channel}`)).join("، ")}
            </Detail>
            <Detail label={t("plan.fields.budgetNotes")}>
              {plan.budgetNotes ?? t("common.notSet")}
            </Detail>
          </dl>
        )}
      </Card>

      {plan !== null && can.edit ? (
        <Card title={t("plan.generateTitle")} testId="plan-generate-card">
          {!can.generate ? (
            <Notice testId="plan-ai-disabled">{t("plan.aiDisabled")}</Notice>
          ) : plan.channels.length === 0 ? (
            <Notice testId="plan-needs-channel">{t("plan.generateNeedsChannel")}</Notice>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t("plan.generateHint")}</p>
              <EntityForm
                action={submitGeneratePlan.bind(null, target)}
                submitLabel={t("plan.generateSubmit")}
                pendingLabel={t("plan.generating")}
                testId="plan-generate-form"
                fields={[
                  {
                    kind: "select",
                    name: "count",
                    label: t("plan.fields.count"),
                    options: Array.from(
                      { length: PLAN_IDEAS_MAX - PLAN_IDEAS_MIN + 1 },
                      (_, index) => {
                        const value = String(PLAN_IDEAS_MIN + index);
                        return { value, label: value };
                      },
                    ),
                    defaultValue: "6",
                  },
                ]}
              />
            </>
          )}
        </Card>
      ) : null}

      <Card
        title={t("plan.itemsTitle")}
        testId="plan-items-card"
        actions={
          items.length === 0 ? null : (
            <span className="text-sm text-muted-foreground" data-testid="plan-items-count">
              {t("plan.itemsCount", { count: items.length, included })}
            </span>
          )
        }
      >
        {items.length === 0 ? (
          <EmptyState message={t("plan.itemsEmpty")} testId="plan-items-empty" />
        ) : (
          <ol className="space-y-4" data-testid="plan-items">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="space-y-3 rounded-lg border p-4"
                data-testid="plan-item"
                data-included={item.included}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold tabular-nums">{index + 1}.</span>
                  <span className="min-w-0 font-medium break-words" data-testid="plan-item-title">
                    {item.title}
                  </span>
                  <Badge tone={item.aiGenerated ? "soft" : "muted"}>
                    {item.aiGenerated ? t("plan.aiTag") : t("plan.manualTag")}
                  </Badge>
                  <Badge tone="outline">{t(`enums.channel.${item.channel}`)}</Badge>
                  {isPublishedByFlexibx(item.channel) ? null : (
                    <Badge>{t("plan.outsideFlexibx")}</Badge>
                  )}
                  {item.included ? null : <Badge tone="danger">{t("plan.excludedTag")}</Badge>}
                  {item.contentItemId === null ? null : (
                    <Badge tone="solid" testId="plan-item-drafted">
                      {t("plan.draftedTag")}
                    </Badge>
                  )}
                </div>
                {can.edit && item.contentItemId === null ? (
                  <>
                    <EntityForm
                      action={submitUpdatePlanItem.bind(null, target, item.id)}
                      fields={itemFields(t, item)}
                      submitLabel={t("plan.saveItem")}
                      testId={`plan-item-form-${String(index + 1)}`}
                    />
                    <ActionButton
                      action={submitRemovePlanItem.bind(null, target, item.id)}
                      label={t("plan.removeItem")}
                      confirm={t("plan.removeConfirm")}
                      danger
                      testId={`plan-item-remove-${String(index + 1)}`}
                    />
                  </>
                ) : (
                  <dl className="grid gap-3 sm:grid-cols-3">
                    <Detail label={t("plan.fields.contentType")}>
                      {t(`enums.contentType.${item.contentType}`)}
                    </Detail>
                    <Detail label={t("plan.fields.plannedDate")}>
                      {item.plannedDate === null ? t("plan.noDate") : day(item.plannedDate)}
                    </Detail>
                    {item.contentItemId === null ? null : (
                      <Detail label={t("plan.draftedTag")}>
                        <Link
                          href={`/w/${workspace.slug}/content/${item.contentItemId}`}
                          className="underline"
                          data-testid="plan-item-content-link"
                        >
                          {t("plan.openContent")}
                        </Link>
                      </Detail>
                    )}
                    {item.brief === "" ? null : (
                      <div className="sm:col-span-3">
                        <Detail label={t("plan.fields.brief")}>{item.brief}</Detail>
                      </div>
                    )}
                  </dl>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {plan !== null && can.edit ? (
        <Card title={t("plan.addTitle")} testId="plan-add-card">
          <EntityForm
            action={submitAddPlanItem.bind(null, target)}
            fields={itemFields(t, null)}
            submitLabel={t("plan.addSubmit")}
            testId="plan-add-form"
          />
        </Card>
      ) : null}

      {plan === null ? null : (
        <Card title={t("plan.approveTitle")} testId="plan-approve-card">
          <p className="text-sm text-muted-foreground">{t("plan.approveHint")}</p>
          {!can.manage ? null : plan.status === "DRAFT" ? (
            included === 0 ? (
              <Notice testId="plan-approve-empty">{t("plan.approveEmpty")}</Notice>
            ) : (
              <ActionButton
                action={submitApprovePlan.bind(null, target)}
                label={t("plan.approve")}
                variant="default"
                testId="plan-approve"
              />
            )
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              {undrafted === 0 ? (
                <Notice testId="plan-all-drafted">{t("plan.allDrafted")}</Notice>
              ) : can.createDrafts ? (
                <div className="space-y-2">
                  <ActionButton
                    action={submitCreatePlanDrafts.bind(null, target)}
                    label={t("plan.createDrafts", { count: undrafted })}
                    variant="default"
                    testId="plan-create-drafts"
                  />
                  <p className="text-xs text-muted-foreground">{t("plan.createDraftsHint")}</p>
                </div>
              ) : null}
              <ActionButton
                action={submitReopenPlan.bind(null, target)}
                label={t("plan.reopen")}
                confirm={t("plan.reopenConfirm")}
                testId="plan-reopen"
              />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
