import { CheckCircle2, Circle } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import {
  Badge,
  CAMPAIGN_STATUS_TONES,
  CONTENT_STATUS_TONES,
  Card,
  EmptyState,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getDashboardPage } from "@/server/marketing/marketing-queries";
import { CONTENT_STATUSES } from "@/server/marketing/overview-service";

import { ActivityList } from "./activity-list";
import { openWorkspacePage, type WorkspaceRouteParams } from "./page-data";

/** Workspace home: the marketing dashboard. Sections appear only for roles that may see them. */
export default async function WorkspacePage({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const tWorkspaces = await getTranslations({ locale, namespace: "workspaces" });
  const format = await getFormatter({ locale });
  const data = await getDashboardPage(workspace.slug);
  const base = `/w/${workspace.slug}`;
  const when = (value: Date) =>
    format.dateTime(value, { dateStyle: "medium", timeStyle: "short", timeZone: data.timeZone });

  const steps = [
    { key: "brand", done: data.setup.brand, href: `${base}/brand`, visible: data.can.editBrand },
    {
      key: "audiences",
      done: data.setup.audiences > 0,
      href: `${base}/brand/audiences`,
      visible: data.can.editBrand,
    },
    {
      key: "pillars",
      done: data.setup.pillars > 0,
      href: `${base}/brand/pillars`,
      visible: data.can.editBrand,
    },
    {
      key: "goals",
      done: data.setup.goals > 0,
      href: `${base}/campaigns/goals`,
      visible: data.can.manageCampaigns,
    },
    {
      key: "campaigns",
      done: data.setup.campaigns > 0,
      href: `${base}/campaigns`,
      visible: data.can.manageCampaigns,
    },
    {
      key: "content",
      done: data.setup.content > 0,
      href: `${base}/content/new`,
      visible: data.can.createContent,
    },
  ] as const;
  const visibleSteps = steps.filter((step) => step.visible);
  const setupComplete = visibleSteps.every((step) => step.done);

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold" data-testid="workspace-name">
            {workspace.name}
          </h1>
          <p className="text-muted-foreground" data-testid="workspace-role">
            {tWorkspaces("home.role", { role: tWorkspaces(`roles.${workspace.role}`) })}
          </p>
          <p className="text-muted-foreground">
            {data.brand === null
              ? t("dashboard.intro")
              : t("dashboard.brandName", { name: data.brand.name })}
          </p>
        </div>
        {data.can.createContent ? (
          <Button asChild>
            <Link href={`${base}/content/new`}>{t("dashboard.newContent")}</Link>
          </Button>
        ) : null}
      </header>

      {visibleSteps.length === 0 || setupComplete ? null : (
        <Card title={t("dashboard.setupTitle")} testId="dashboard-setup">
          <p className="text-sm text-muted-foreground">{t("dashboard.setupDescription")}</p>
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleSteps.map((step) => (
              <li key={step.key}>
                <Link
                  href={step.href}
                  className="flex items-center gap-2 rounded-md border p-3 text-sm hover:bg-accent"
                  data-testid={`setup-${step.key}`}
                  data-done={step.done}
                >
                  {step.done ? (
                    <CheckCircle2 aria-hidden="true" className="size-4 text-primary" />
                  ) : (
                    <Circle aria-hidden="true" className="size-4 text-muted-foreground" />
                  )}
                  <span className="flex-1">{t(`dashboard.setup.${step.key}`)}</span>
                  <span className="sr-only">
                    {step.done ? t("dashboard.done") : t("dashboard.todo")}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {data.content === null ? null : (
        <Card
          title={t("dashboard.contentTitle")}
          testId="dashboard-content"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}/content`}>{t("dashboard.viewAll")}</Link>
            </Button>
          }
        >
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {CONTENT_STATUSES.map((status) => (
              <li key={status}>
                <Link
                  href={`${base}/content?status=${status}`}
                  className="block rounded-md border p-3 hover:bg-accent"
                  data-testid={`status-count-${status}`}
                >
                  <span className="block text-2xl font-bold">
                    {format.number(data.content?.byStatus[status] ?? 0)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(`enums.contentStatus.${status}`)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {data.content === null ? null : (
          <Card title={t("dashboard.upcomingTitle")} testId="dashboard-upcoming">
            {data.content.upcoming.length === 0 ? (
              <EmptyState message={t("dashboard.upcomingEmpty")} />
            ) : (
              <ul className="divide-y">
                {data.content.upcoming.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <Link href={`${base}/content/${item.id}`} className="truncate hover:underline">
                      {item.title}
                    </Link>
                    <time
                      dateTime={item.scheduledAt.toISOString()}
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {when(item.scheduledAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {data.content === null ? null : (
          <Card title={t("dashboard.recentTitle")} testId="dashboard-recent">
            {data.content.recent.length === 0 ? (
              <EmptyState message={t("dashboard.recentEmpty")} />
            ) : (
              <ul className="divide-y">
                {data.content.recent.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <Link href={`${base}/content/${item.id}`} className="truncate hover:underline">
                      {item.title}
                    </Link>
                    <Badge tone={CONTENT_STATUS_TONES[item.status]}>
                      {t(`enums.contentStatus.${item.status}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {data.campaigns === null ? null : (
          <Card
            title={t("dashboard.campaignsTitle")}
            testId="dashboard-campaigns"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href={`${base}/campaigns`}>{t("dashboard.viewAll")}</Link>
              </Button>
            }
          >
            <p className="text-sm text-muted-foreground">
              {t("dashboard.activeCampaigns", { count: data.campaigns.active })}
              {" · "}
              {t("dashboard.activeGoals", { count: data.campaigns.activeGoals })}
            </p>
            {data.campaigns.list.length === 0 ? (
              <EmptyState message={t("dashboard.campaignsEmpty")} />
            ) : (
              <ul className="divide-y">
                {data.campaigns.list.map((campaign) => (
                  <li
                    key={campaign.id}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <Link
                      href={`${base}/campaigns/${campaign.id}`}
                      className="truncate hover:underline"
                    >
                      {campaign.name}
                    </Link>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      {t("dashboard.contentCount", { count: campaign.content })}
                      <Badge tone={CAMPAIGN_STATUS_TONES[campaign.status]}>
                        {t(`enums.campaignStatus.${campaign.status}`)}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {data.activity === null ? null : (
          <Card
            title={t("dashboard.activityTitle")}
            testId="dashboard-activity"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href={`${base}/activity`}>{t("dashboard.viewAll")}</Link>
              </Button>
            }
          >
            {data.activity.length === 0 ? (
              <EmptyState message={t("dashboard.activityEmpty")} />
            ) : (
              <ActivityList locale={locale} slug={workspace.slug} entries={data.activity} />
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
