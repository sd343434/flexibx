import { getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import { ForbiddenNotice, Notice, PageHeader } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getGoalPage } from "@/server/marketing/marketing-queries";

import { goalFields } from "../../../form-fields";
import { submitGoal } from "../../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../../page-data";
import { CampaignTabs } from "../../../section-tabs";

export default async function GoalRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly goalId: string }>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { goalId } = await params;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getGoalPage(workspace.slug, goalId));
  if (data === null) {
    return <ForbiddenNotice title={t("goals.title")} message={t("common.forbidden")} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={data.goal.title}
        description={t("goals.editTitle")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${workspace.slug}/campaigns/goals`}>{t("common.back")}</Link>
          </Button>
        }
      />
      <CampaignTabs locale={locale} slug={workspace.slug} active="goals" />
      {data.can.campaignManage ? null : <Notice testId="view-only">{t("common.viewOnly")}</Notice>}
      <EntityForm
        action={submitGoal.bind(null, workspace.slug, locale, data.goal.id)}
        fields={goalFields(t, data.goal)}
        submitLabel={t("goals.submitUpdate")}
        testId="goal-form"
        readOnly={!data.can.campaignManage}
      />
    </div>
  );
}
