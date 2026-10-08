import { getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import { ForbiddenNotice, PageHeader } from "@/components/marketing/page-parts";
import { getCampaignFormPage } from "@/server/marketing/marketing-queries";

import { campaignFields } from "../../form-fields";
import { submitCampaign } from "../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";

export default async function NewCampaignRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getCampaignFormPage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("campaigns.newTitle")} message={t("common.forbidden")} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t("campaigns.newTitle")} description={t("campaigns.description")} />
      <EntityForm
        action={submitCampaign.bind(null, workspace.slug, locale, null)}
        fields={campaignFields(t, null, data.options)}
        submitLabel={t("campaigns.submitCreate")}
        testId="campaign-form"
      />
    </div>
  );
}
