import { getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  EmptyState,
  ForbiddenNotice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getAudiencesPage } from "@/server/marketing/marketing-queries";

import { audienceFields } from "../../form-fields";
import { submitAudience } from "../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";
import { BrandTabs } from "../../section-tabs";

export default async function AudiencesRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getAudiencesPage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("audiences.title")} message={t("common.forbidden")} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t("audiences.title")} description={t("audiences.description")} />
      <BrandTabs locale={locale} slug={workspace.slug} active="audiences" />

      {data.audiences.length === 0 ? (
        <EmptyState message={t("audiences.empty")} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="audience-list">
          {data.audiences.map((audience) => (
            <li key={audience.id} className="rounded-lg border p-4" data-testid="audience-row">
              <div className="flex items-start justify-between gap-2">
                <Link
                  href={`/w/${workspace.slug}/brand/audiences/${audience.id}`}
                  className="font-semibold hover:underline"
                >
                  {audience.name}
                </Link>
                {audience.buyingIntent === null ? null : (
                  <Badge tone="soft">
                    {t("audiences.fields.buyingIntent")}:{" "}
                    {t(`enums.buyingIntent.${audience.buyingIntent}`)}
                  </Badge>
                )}
              </div>
              {audience.description === null ? null : (
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                  {audience.description}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {data.can.brandEdit ? (
        <Card title={t("audiences.newTitle")} testId="audience-create">
          <EntityForm
            action={submitAudience.bind(null, workspace.slug, locale, null)}
            fields={audienceFields(t, null)}
            submitLabel={t("audiences.submitCreate")}
            testId="audience-form"
          />
        </Card>
      ) : null}
    </div>
  );
}
