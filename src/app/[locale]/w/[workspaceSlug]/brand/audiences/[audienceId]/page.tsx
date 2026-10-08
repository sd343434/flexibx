import { getTranslations } from "next-intl/server";

import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import { Card, ForbiddenNotice, Notice, PageHeader } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getAudiencePage } from "@/server/marketing/marketing-queries";

import { audienceFields } from "../../../form-fields";
import { submitAudience, submitDeleteAudience } from "../../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../../page-data";
import { BrandTabs } from "../../../section-tabs";

export default async function AudienceRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly audienceId: string }>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { audienceId } = await params;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getAudiencePage(workspace.slug, audienceId));
  if (data === null) {
    return <ForbiddenNotice title={t("audiences.title")} message={t("common.forbidden")} />;
  }
  const { audience } = data;

  return (
    <div className="space-y-8">
      <PageHeader
        title={audience.name}
        description={t("audiences.description")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${workspace.slug}/brand/audiences`}>{t("common.back")}</Link>
          </Button>
        }
      />
      <BrandTabs locale={locale} slug={workspace.slug} active="audiences" />
      {data.can.brandEdit ? null : <Notice testId="view-only">{t("common.viewOnly")}</Notice>}
      <EntityForm
        action={submitAudience.bind(null, workspace.slug, locale, audience.id)}
        fields={audienceFields(t, audience)}
        submitLabel={t("audiences.submitUpdate")}
        testId="audience-form"
        readOnly={!data.can.brandEdit}
      />
      {data.can.brandEdit ? (
        <Card title={t("audiences.delete")} className="border-destructive/40">
          <ActionButton
            action={submitDeleteAudience.bind(null, workspace.slug, locale, audience.id)}
            label={t("audiences.delete")}
            confirm={t("audiences.deleteConfirm")}
            danger
            testId="audience-delete"
          />
        </Card>
      ) : null}
    </div>
  );
}
