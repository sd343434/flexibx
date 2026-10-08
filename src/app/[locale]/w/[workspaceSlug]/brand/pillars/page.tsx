import { ArrowDown, ArrowUp } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  EmptyState,
  ForbiddenNotice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getPillarsPage } from "@/server/marketing/marketing-queries";

import { pillarFields } from "../../form-fields";
import { submitMovePillar, submitPillar } from "../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";
import { BrandTabs } from "../../section-tabs";

export default async function PillarsRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getPillarsPage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("pillars.title")} message={t("common.forbidden")} />;
  }
  const last = data.pillars.length - 1;

  return (
    <div className="space-y-8">
      <PageHeader title={t("pillars.title")} description={t("pillars.description")} />
      <BrandTabs locale={locale} slug={workspace.slug} active="pillars" />

      {data.pillars.length === 0 ? (
        <EmptyState message={t("pillars.empty")} />
      ) : (
        <ol className="divide-y rounded-lg border" data-testid="pillar-list">
          {data.pillars.map((pillar, index) => (
            <li
              key={pillar.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid="pillar-row"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/w/${workspace.slug}/brand/pillars/${pillar.id}`}
                    className="font-semibold hover:underline"
                  >
                    {pillar.name}
                  </Link>
                  {pillar.status === "ARCHIVED" ? (
                    <Badge>{t("enums.pillarStatus.ARCHIVED")}</Badge>
                  ) : null}
                </div>
                {pillar.objective === null ? null : (
                  <p className="line-clamp-2 text-sm text-muted-foreground">{pillar.objective}</p>
                )}
                {pillar.audience === null ? null : (
                  <p className="text-xs text-muted-foreground">
                    {t("pillars.audience", { name: pillar.audience.name })}
                  </p>
                )}
              </div>
              {data.can.brandEdit ? (
                <div className="flex gap-1">
                  {index > 0 ? (
                    <ActionButton
                      action={submitMovePillar.bind(null, workspace.slug, locale, pillar.id, "up")}
                      label={t("pillars.moveUp")}
                      variant="ghost"
                    >
                      <ArrowUp aria-hidden="true" className="size-4 self-center" />
                    </ActionButton>
                  ) : null}
                  {index < last ? (
                    <ActionButton
                      action={submitMovePillar.bind(
                        null,
                        workspace.slug,
                        locale,
                        pillar.id,
                        "down",
                      )}
                      label={t("pillars.moveDown")}
                      variant="ghost"
                    >
                      <ArrowDown aria-hidden="true" className="size-4 self-center" />
                    </ActionButton>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {data.can.brandEdit ? (
        <Card title={t("pillars.newTitle")} testId="pillar-create">
          <EntityForm
            action={submitPillar.bind(null, workspace.slug, locale, null)}
            fields={pillarFields(t, null, data.audiences)}
            submitLabel={t("pillars.submitCreate")}
            testId="pillar-form"
          />
        </Card>
      ) : null}
    </div>
  );
}
