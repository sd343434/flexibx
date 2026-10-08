import { getFormatter, getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  EmptyState,
  ForbiddenNotice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getGoalsPage } from "@/server/marketing/marketing-queries";

import { goalFields } from "../../form-fields";
import { submitGoal } from "../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";
import { CampaignTabs } from "../../section-tabs";

export default async function GoalsRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getGoalsPage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("goals.title")} message={t("common.forbidden")} />;
  }
  const date = (value: Date | null) =>
    value === null ? "…" : format.dateTime(value, { dateStyle: "medium", timeZone: "UTC" });

  return (
    <div className="space-y-8">
      <PageHeader title={t("goals.title")} description={t("goals.description")} />
      <CampaignTabs locale={locale} slug={workspace.slug} active="goals" />

      {data.goals.length === 0 ? (
        <EmptyState message={t("goals.empty")} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" data-testid="goal-list">
          {data.goals.map((goal) => (
            <li key={goal.id} className="space-y-2 rounded-lg border p-4" data-testid="goal-row">
              <div className="flex items-start justify-between gap-2">
                <Link
                  href={`/w/${workspace.slug}/campaigns/goals/${goal.id}`}
                  className="font-semibold hover:underline"
                >
                  {goal.title}
                </Link>
                <Badge tone={goal.status === "ACTIVE" ? "soft" : "muted"}>
                  {t(`enums.goalStatus.${goal.status}`)}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(`enums.goalType.${goal.type}`)}
                {goal.kpi === null ? null : ` · ${goal.kpi}`}
                {goal.target === null
                  ? null
                  : ` · ${t("goals.target", { target: format.number(Number(goal.target)) })}`}
              </p>
              {goal.startDate === null && goal.endDate === null ? null : (
                <p className="text-xs text-muted-foreground">
                  {t("goals.period", { start: date(goal.startDate), end: date(goal.endDate) })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {data.can.campaignManage ? (
        <Card title={t("goals.newTitle")} testId="goal-create">
          <EntityForm
            action={submitGoal.bind(null, workspace.slug, locale, null)}
            fields={goalFields(t, null)}
            submitLabel={t("goals.submitCreate")}
            testId="goal-form"
          />
        </Card>
      ) : null}
    </div>
  );
}
