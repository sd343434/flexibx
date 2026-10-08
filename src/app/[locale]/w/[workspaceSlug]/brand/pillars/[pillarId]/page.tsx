import { getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import { ForbiddenNotice, Notice, PageHeader } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getPillarPage } from "@/server/marketing/marketing-queries";

import { pillarFields } from "../../../form-fields";
import { submitPillar } from "../../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../../page-data";
import { BrandTabs } from "../../../section-tabs";

export default async function PillarRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly pillarId: string }>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { pillarId } = await params;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getPillarPage(workspace.slug, pillarId));
  if (data === null) {
    return <ForbiddenNotice title={t("pillars.title")} message={t("common.forbidden")} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={data.pillar.name}
        description={t("pillars.editTitle")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${workspace.slug}/brand/pillars`}>{t("common.back")}</Link>
          </Button>
        }
      />
      <BrandTabs locale={locale} slug={workspace.slug} active="pillars" />
      {data.can.brandEdit ? null : <Notice testId="view-only">{t("common.viewOnly")}</Notice>}
      <EntityForm
        action={submitPillar.bind(null, workspace.slug, locale, data.pillar.id)}
        fields={pillarFields(t, data.pillar, data.audiences)}
        submitLabel={t("pillars.submitUpdate")}
        testId="pillar-form"
        readOnly={!data.can.brandEdit}
      />
    </div>
  );
}
