import { getFormatter, getTranslations } from "next-intl/server";

import { DirectionalIcon } from "@/components/common/directional-icon";
import { ActionButton, inputClass } from "@/components/marketing/entity-form";
import {
  Badge,
  CONTENT_STATUS_TONES,
  ForbiddenNotice,
  Notice,
  PageHeader,
  SectionTabs,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { calendarQuerySchema } from "@/server/marketing/inputs";
import { getCalendarPage } from "@/server/marketing/marketing-queries";
import { utcToZonedLocal } from "@/server/marketing/time";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { submitReschedule } from "../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

export default async function CalendarRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const raw = await searchParams;
  const query = calendarQuerySchema.parse({
    view: typeof raw.view === "string" ? raw.view : undefined,
    date: typeof raw.date === "string" ? raw.date : undefined,
  });
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getCalendarPage(workspace.slug, query));
  if (data === null) {
    return <ForbiddenNotice title={t("calendar.title")} message={t("common.forbidden")} />;
  }
  const { calendar } = data;
  const zone = calendar.timeZone;
  const base = `/w/${workspace.slug}/calendar`;
  const href = (view: string, date: string) => `${base}?view=${view}&date=${date}`;
  const dayLabel = (key: string) =>
    format.dateTime(new Date(`${key}T12:00:00Z`), {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  const time = (value: Date) => format.dateTime(value, { timeStyle: "short", timeZone: zone });
  const isWeek = calendar.view === "week";

  return (
    <div className="space-y-6">
      <PageHeader title={t("calendar.title")} description={t("calendar.description", { zone })} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTabs
          label={t("calendar.viewLabel")}
          tabs={[
            { href: href("week", calendar.date), label: t("calendar.week"), active: isWeek },
            { href: href("day", calendar.date), label: t("calendar.day"), active: !isWeek },
          ]}
        />
        <div className="flex items-center gap-1">
          <Button
            asChild
            variant="outline"
            size="icon"
            aria-label={isWeek ? t("calendar.previousWeek") : t("calendar.previousDay")}
          >
            <Link
              href={href(calendar.view, calendar.period.previous)}
              data-testid="calendar-previous"
            >
              <DirectionalIcon icon={ChevronLeft} />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={href(calendar.view, calendar.today)}>{t("calendar.today")}</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            size="icon"
            aria-label={isWeek ? t("calendar.nextWeek") : t("calendar.nextDay")}
          >
            <Link href={href(calendar.view, calendar.period.next)} data-testid="calendar-next">
              <DirectionalIcon icon={ChevronRight} />
            </Link>
          </Button>
        </div>
      </div>

      {calendar.truncated ? <Notice>{t("calendar.truncated")}</Notice> : null}
      {calendar.items.length === 0 ? (
        <Notice testId="calendar-empty">{t("calendar.empty")}</Notice>
      ) : null}

      <ol
        className={cn("grid gap-3", isWeek && "md:grid-cols-7")}
        data-testid="calendar-grid"
        data-view={calendar.view}
      >
        {calendar.period.days.map((day) => {
          const items = calendar.items.filter((item) => item.dateKey === day);
          const today = day === calendar.today;
          return (
            <li
              key={day}
              className={cn("min-h-28 space-y-2 rounded-lg border p-2", today && "border-primary")}
              data-testid="calendar-day"
              data-date={day}
            >
              <h2 className="text-xs font-semibold">
                <Link
                  href={href("day", day)}
                  className="hover:underline"
                  aria-current={today ? "date" : undefined}
                >
                  {dayLabel(day)}
                </Link>
              </h2>
              {items.length === 0 ? (
                isWeek ? null : (
                  <p className="text-sm text-muted-foreground">{t("calendar.dayEmpty")}</p>
                )
              ) : (
                <ul className="space-y-2">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="space-y-1 rounded-md bg-muted/50 p-2 text-xs"
                      data-testid="calendar-item"
                    >
                      <div className="flex flex-wrap items-center gap-1">
                        <time dateTime={item.at.toISOString()} className="font-medium">
                          {time(item.at)}
                        </time>
                        <Badge tone={CONTENT_STATUS_TONES[item.status]}>
                          {t(`enums.contentStatus.${item.status}`)}
                        </Badge>
                      </div>
                      <Link
                        href={`/w/${workspace.slug}/content/${item.id}`}
                        className="block font-medium break-words hover:underline"
                      >
                        {item.title}
                      </Link>
                      {item.campaign === null ? null : (
                        <p className="text-muted-foreground">{item.campaign}</p>
                      )}
                      {item.canReschedule ? (
                        <details>
                          <summary className="cursor-pointer text-muted-foreground">
                            {t("calendar.move")}
                          </summary>
                          <div className="pt-2">
                            <ActionButton
                              action={submitReschedule.bind(null, workspace.slug, locale, item.id)}
                              label={t("calendar.move")}
                              testId="calendar-move"
                            >
                              <input
                                type="datetime-local"
                                name="scheduledAt"
                                dir="ltr"
                                aria-label={t("calendar.moveTitle", { title: item.title })}
                                defaultValue={utcToZonedLocal(item.at, zone)}
                                className={cn(inputClass, "h-9")}
                              />
                            </ActionButton>
                          </div>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
