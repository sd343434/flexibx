import { getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import { ForbiddenNotice, PageHeader } from "@/components/marketing/page-parts";
import { getNewContentPage } from "@/server/marketing/marketing-queries";

import { contentFields } from "../../form-fields";
import { submitContent } from "../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";

export default async function NewContentRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getNewContentPage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("content.newTitle")} message={t("common.forbidden")} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t("content.newTitle")} description={t("content.description")} />
      <EntityForm
        action={submitContent.bind(null, workspace.slug, locale, null)}
        fields={contentFields(t, null, data.options, data.timeZone)}
        submitLabel={t("content.submitCreate")}
        testId="content-form"
      />
    </div>
  );
}
