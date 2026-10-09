import {
  CheckCircle2,
  Circle,
  CircleDashed,
  Clapperboard,
  FileText,
  GalleryHorizontal,
  Image as ImageIcon,
  Mail,
  Megaphone,
  Newspaper,
  Plus,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { DateTimeFormatOptions } from "next-intl";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { ActionButton } from "@/components/marketing/entity-form";
import { Badge, CAMPAIGN_STATUS_TONES, EmptyState } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { getDashboardPage } from "@/server/marketing/marketing-queries";
import { CONTENT_STATUSES } from "@/server/marketing/overview-service";

import { ActivityList } from "./activity-list";
import { loadWorkspace } from "./load-workspace";
import { submitContentTransition } from "./marketing-actions";
import { openWorkspacePage, type WorkspaceRouteParams } from "./page-data";

const TYPE_ICONS: Readonly<Record<string, LucideIcon>> = {
  POST: ImageIcon,
  REEL: Clapperboard,
  STORY: CircleDashed,
  VIDEO: Video,
  CAROUSEL: GalleryHorizontal,
  ARTICLE: Newspaper,
  EMAIL: Mail,
  OTHER: FileText,
};

/** A dashboard section: heading, optional link at the end, content. */
function Section({
  title,
  action,
  testId,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-3" data-testid={testId}>
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-lg font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const sectionLink = "text-sm font-medium text-primary hover:underline";

/** Workspace home: the marketing dashboard. Sections appear only for roles that may see them. */
export default async function WorkspacePage({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { user } = await loadWorkspace(locale, workspace.slug);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const tWorkspaces = await getTranslations({ locale, namespace: "workspaces" });
  const format = await getFormatter({ locale });
  const data = await getDashboardPage(workspace.slug);
  const base = `/w/${workspace.slug}`;
  const zone = data.timeZone;
  const when = (value: Date) =>
    format.dateTime(value, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
    });
  const day = (value: Date) =>
    format.dateTime(value, { day: "numeric", month: "short", timeZone: zone });
  const time = (value: Date) =>
    format.dateTime(value, { hour: "numeric", minute: "2-digit", timeZone: zone });
  // Calendar dates (YYYY-MM-DD) are formatted at UTC noon so no zone shifts the day.
  const dateKey = (key: string, options: DateTimeFormatOptions) =>
    format.dateTime(new Date(`${key}T12:00:00Z`), { ...options, timeZone: "UTC" });

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
  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;

  return (
    <div className="flex flex-col gap-6 xl:flex-row">
      <div className="min-w-0 flex-1 space-y-8 rounded-3xl bg-muted p-4 sm:p-6">
        <header className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="text-2xl font-bold sm:text-3xl" data-testid="dashboard-greeting">
              {t("dashboard.greeting", { name: firstName })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {data.content === null
                ? data.brand === null
                  ? t("dashboard.intro")
                  : t("dashboard.brandName", { name: data.brand.name })
                : t("dashboard.reviewSummary", { count: data.content.byStatus.IN_REVIEW })}
            </p>
          </div>
          {data.can.createContent ? (
            <Button asChild className="h-11 rounded-xl px-5">
              <Link href={`${base}/content/new`}>
                <Plus aria-hidden="true" />
                {t("dashboard.newContent")}
              </Link>
            </Button>
          ) : null}
        </header>

        {visibleSteps.length === 0 || setupComplete ? null : (
          <section
            className="space-y-4 rounded-2xl bg-card p-5 text-card-foreground"
            data-testid="dashboard-setup"
          >
            <div className="space-y-1">
              <h2 className="text-lg font-bold">{t("dashboard.setupTitle")}</h2>
              <p className="text-sm text-muted-foreground">{t("dashboard.setupDescription")}</p>
            </div>
            <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {visibleSteps.map((step) => (
                <li key={step.key}>
                  <Link
                    href={step.href}
                    className="flex min-h-11 items-center gap-2 rounded-xl border p-3 text-sm hover:bg-accent"
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
          </section>
        )}

        {data.content === null ? null : (
          <Section
            title={t("dashboard.contentTitle")}
            testId="dashboard-content"
            action={
              <Link href={`${base}/content`} className={sectionLink}>
                {t("dashboard.viewAll")}
              </Link>
            }
          >
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {CONTENT_STATUSES.map((status) => (
                <li key={status}>
                  <Link
                    href={`${base}/content?status=${status}`}
                    className={cn(
                      "block rounded-2xl p-4 transition-colors",
                      status === "IN_REVIEW"
                        ? "bg-lime text-lime-foreground hover:bg-lime/85"
                        : "bg-card text-card-foreground hover:bg-accent",
                    )}
                    data-testid={`status-count-${status}`}
                  >
                    <span className="block text-2xl font-bold">
                      {format.number(data.content?.byStatus[status] ?? 0)}
                    </span>
                    <span
                      className={cn(
                        "text-xs",
                        status === "IN_REVIEW" ? "text-lime-foreground" : "text-muted-foreground",
                      )}
                    >
                      {t(`enums.contentStatus.${status}`)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {data.campaigns === null ? null : (
          <Section
            title={t("dashboard.campaignsTitle")}
            testId="dashboard-campaigns"
            action={
              <Link href={`${base}/campaigns`} className={sectionLink}>
                {t("dashboard.viewAll")}
              </Link>
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
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.campaigns.list.map((campaign, index) => {
                  const featured = index === 0;
                  const share = campaign.content === 0 ? 0 : campaign.published / campaign.content;
                  return (
                    <li
                      key={campaign.id}
                      className={cn(
                        "flex flex-col gap-4 rounded-3xl p-5",
                        featured
                          ? "bg-feature text-feature-foreground"
                          : "bg-card text-card-foreground",
                      )}
                      data-testid="campaign-card"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "flex size-11 shrink-0 items-center justify-center rounded-2xl",
                            featured ? "bg-lime text-lime-foreground" : "bg-accent text-primary",
                          )}
                        >
                          <Megaphone aria-hidden="true" className="size-5" />
                        </span>
                        <Link
                          href={`${base}/campaigns/${campaign.id}`}
                          className="min-w-0 flex-1 truncate font-bold hover:underline"
                        >
                          {campaign.name}
                        </Link>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {featured ? (
                          <span className="rounded-full bg-lime px-2.5 py-1 font-semibold text-lime-foreground">
                            {t(`enums.campaignStatus.${campaign.status}`)}
                          </span>
                        ) : (
                          <Badge tone={CAMPAIGN_STATUS_TONES[campaign.status]}>
                            {t(`enums.campaignStatus.${campaign.status}`)}
                          </Badge>
                        )}
                        <span
                          className={cn(
                            "rounded-lg px-2.5 py-1",
                            featured ? "bg-white/10" : "bg-muted",
                          )}
                        >
                          {t("dashboard.contentCount", { count: campaign.content })}
                        </span>
                      </div>
                      <div className="mt-auto space-y-2">
                        <div
                          aria-hidden="true"
                          className={cn(
                            "h-1.5 overflow-hidden rounded-full",
                            featured ? "bg-white/15" : "bg-border",
                          )}
                        >
                          <div
                            className={cn(
                              "h-full rounded-full",
                              featured ? "bg-lime" : "bg-primary",
                            )}
                            style={{ width: `${String(Math.round(share * 100))}%` }}
                          />
                        </div>
                        <p
                          className={cn(
                            "text-sm",
                            featured ? "text-feature-muted" : "text-muted-foreground",
                          )}
                        >
                          {t("dashboard.progress", {
                            percent: format.number(share, { style: "percent" }),
                          })}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        )}

        {data.content === null ? null : (
          <Section
            title={t("dashboard.reviewTitle")}
            testId="dashboard-review"
            action={
              <Link href={`${base}/content?status=IN_REVIEW`} className={sectionLink}>
                {t("dashboard.allContent")}
              </Link>
            }
          >
            {data.content.review.length === 0 ? (
              <EmptyState message={t("dashboard.reviewEmpty")} />
            ) : (
              <ul className="divide-y rounded-2xl bg-card px-5 text-card-foreground">
                {data.content.review.map((item) => {
                  const Icon = TYPE_ICONS[item.type] ?? FileText;
                  return (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center gap-4 py-4"
                      data-testid="review-row"
                    >
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-lime-soft text-lime-soft-foreground">
                        <Icon aria-hidden="true" className="size-5" />
                      </span>
                      <div className="min-w-0 flex-[1_1_12rem]">
                        <p className="truncate font-semibold">{item.title}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          {t(`enums.contentType.${item.type}`)}
                          {item.campaign === null ? null : ` · ${item.campaign}`}
                        </p>
                      </div>
                      <div className="flex-[0_1_11rem] text-sm">
                        <p className="text-xs text-muted-foreground">{t("dashboard.plannedFor")}</p>
                        <p className="font-semibold">
                          {item.scheduledAt === null ? (
                            t("dashboard.notPlanned")
                          ) : (
                            <time dateTime={item.scheduledAt.toISOString()}>
                              {when(item.scheduledAt)}
                            </time>
                          )}
                        </p>
                      </div>
                      <div className="flex items-end gap-2">
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="rounded-xl bg-transparent"
                        >
                          <Link href={`${base}/content/${item.id}`}>{t("dashboard.open")}</Link>
                        </Button>
                        {data.can.approveContent ? (
                          <ActionButton
                            action={submitContentTransition.bind(
                              null,
                              workspace.slug,
                              locale,
                              item.id,
                              "approve",
                            )}
                            label={t("enums.transition.approve")}
                            variant="default"
                            testId="review-approve"
                          />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        )}

        {data.content === null ? null : (
          <Section
            title={t("dashboard.draftsTitle")}
            testId="dashboard-drafts"
            action={
              data.can.createContent ? (
                <Link
                  href={`${base}/content/new`}
                  className={cn(sectionLink, "flex items-center gap-1")}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  {t("dashboard.newContent")}
                </Link>
              ) : null
            }
          >
            {data.content.drafts.length === 0 ? (
              <EmptyState message={t("dashboard.draftsEmpty")} />
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {data.content.drafts.map((draft, index) => {
                  const dark = index === 0;
                  return (
                    <li
                      key={draft.id}
                      className={cn(
                        "flex flex-col gap-3 rounded-3xl p-5",
                        dark
                          ? "bg-feature text-feature-foreground"
                          : "bg-lime text-lime-foreground",
                      )}
                      data-testid="draft-card"
                    >
                      <Link
                        href={`${base}/content/${draft.id}`}
                        className="font-bold hover:underline"
                      >
                        {draft.title}
                      </Link>
                      {draft.excerpt === "" ? null : (
                        <p
                          className={cn(
                            "text-sm leading-relaxed",
                            dark ? "text-feature-muted" : "text-lime-foreground/80",
                          )}
                        >
                          {draft.excerpt}
                        </p>
                      )}
                      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        {draft.pillar === null ? null : (
                          <span className={cn("font-semibold", dark ? "text-lime" : "underline")}>
                            {draft.pillar}
                          </span>
                        )}
                        <span className={dark ? "text-feature-muted" : "text-lime-foreground/80"}>
                          {draft.scheduledAt === null ? (
                            t("dashboard.notPlanned")
                          ) : (
                            <time dateTime={draft.scheduledAt.toISOString()}>
                              {when(draft.scheduledAt)}
                            </time>
                          )}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        )}
      </div>

      <aside className="space-y-8 xl:w-80 xl:shrink-0" data-testid="dashboard-aside">
        <section className="flex flex-col items-center gap-2 text-center">
          <h2 className="self-start text-lg font-bold">{t("dashboard.profileTitle")}</h2>
          <span
            aria-hidden="true"
            className="mt-2 flex size-20 items-center justify-center rounded-full bg-primary text-3xl font-bold text-primary-foreground ring-4 ring-lime ring-offset-4 ring-offset-panel"
          >
            {firstName.slice(0, 1).toUpperCase()}
          </span>
          <p className="mt-3 text-lg font-bold">{user.name}</p>
          <p className="text-sm text-muted-foreground" data-testid="workspace-role">
            {tWorkspaces("home.role", { role: tWorkspaces(`roles.${workspace.role}`) })}
          </p>
          <p className="text-sm font-semibold" data-testid="workspace-name">
            {workspace.name}
          </p>
        </section>

        {data.content === null ? null : (
          <section className="space-y-3 rounded-3xl bg-muted p-4" data-testid="dashboard-week">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold">{t("dashboard.weekTitle")}</h2>
              <span className="text-sm text-muted-foreground">
                {dateKey(data.content.week.today, { month: "long", year: "numeric" })}
              </span>
            </div>
            <ol className="grid grid-cols-7 gap-1 text-center">
              {data.content.week.days.map((entry) => {
                const isToday = entry.date === data.content?.week.today;
                return (
                  <li key={entry.date}>
                    <Link
                      href={`${base}/calendar?view=day&date=${entry.date}`}
                      aria-current={isToday ? "date" : undefined}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-2xl py-2 text-xs hover:bg-accent",
                        isToday && "bg-feature text-feature-foreground hover:bg-feature",
                        !isToday && entry.count > 0 && "bg-accent text-accent-foreground",
                      )}
                      data-testid={`week-day-${entry.date}`}
                      data-count={entry.count}
                    >
                      <span className={isToday ? "text-feature-muted" : "text-muted-foreground"}>
                        {dateKey(entry.date, { weekday: "narrow" })}
                      </span>
                      <span className={cn("text-sm font-bold", isToday && "text-lime")}>
                        {dateKey(entry.date, { day: "numeric" })}
                      </span>
                      <span className="sr-only">
                        {isToday ? `${t("dashboard.today")}, ` : ""}
                        {t("dashboard.contentCount", { count: entry.count })}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {data.content === null ? null : (
          <Section
            title={t("dashboard.upcomingTitle")}
            testId="dashboard-upcoming"
            action={
              <Link href={`${base}/calendar`} className={sectionLink}>
                {t("dashboard.calendarLink")}
              </Link>
            }
          >
            {data.content.upcoming.length === 0 ? (
              <EmptyState message={t("dashboard.upcomingEmpty")} />
            ) : (
              <ul className="space-y-3">
                {data.content.upcoming.map((item, index) => (
                  <li key={item.id}>
                    <Link
                      href={`${base}/content/${item.id}`}
                      className={cn(
                        "flex items-center gap-4 rounded-2xl border-s-4 p-4 hover:opacity-90",
                        index % 2 === 0
                          ? "border-primary bg-accent text-accent-foreground"
                          : "border-foreground bg-lime-soft text-lime-soft-foreground",
                      )}
                    >
                      <span className="w-16 shrink-0 text-center">
                        <span className="block text-xs">{day(item.scheduledAt)}</span>
                        <time
                          dateTime={item.scheduledAt.toISOString()}
                          className="block font-bold text-foreground"
                        >
                          {time(item.scheduledAt)}
                        </time>
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">
                          {item.title}
                        </span>
                        {item.campaign === null ? null : (
                          <span className="block truncate text-xs">{item.campaign}</span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {data.activity === null ? null : (
          <Section
            title={t("dashboard.activityTitle")}
            testId="dashboard-activity"
            action={
              <Link href={`${base}/activity`} className={sectionLink}>
                {t("dashboard.viewAll")}
              </Link>
            }
          >
            {data.activity.length === 0 ? (
              <EmptyState message={t("dashboard.activityEmpty")} />
            ) : (
              <ActivityList
                locale={locale}
                slug={workspace.slug}
                entries={data.activity.slice(0, 4)}
              />
            )}
          </Section>
        )}
      </aside>
    </div>
  );
}
