import { getTranslations } from "next-intl/server";

import { EmptyState, ForbiddenNotice, PageHeader } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { isUuid } from "@/server/tenancy/context";
import { getActivityPage } from "@/server/marketing/marketing-queries";

import { ActivityList } from "../activity-list";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

/** The workspace audit trail (audit.view). */
export default async function ActivityRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const rawBefore = (await searchParams).before;
  const before = typeof rawBefore === "string" && isUuid(rawBefore) ? rawBefore : undefined;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getActivityPage(workspace.slug, before));
  if (data === null) {
    return <ForbiddenNotice title={t("activity.title")} message={t("common.forbidden")} />;
  }
  const base = `/w/${workspace.slug}/activity`;

  return (
    <div className="space-y-8">
      <PageHeader title={t("activity.title")} description={t("activity.description")} />
      {data.entries.length === 0 ? (
        <EmptyState message={t("activity.empty")} />
      ) : (
        <ActivityList locale={locale} slug={workspace.slug} entries={data.entries} />
      )}
      <div className="flex justify-between gap-2">
        {before === undefined ? (
          <span />
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link href={base}>{t("activity.newest")}</Link>
          </Button>
        )}
        {data.next === null ? null : (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}?before=${data.next}`} data-testid="activity-older">
              {t("activity.older")}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
