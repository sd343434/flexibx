import { getFormatter, getTranslations } from "next-intl/server";

import {
  Badge,
  CONTENT_STATUS_TONES,
  EmptyState,
  ForbiddenNotice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { inputClass } from "@/components/marketing/entity-form";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { contentListQuerySchema, ENUM_VALUES } from "@/server/marketing/inputs";
import { getContentListPage } from "@/server/marketing/marketing-queries";
import { CONTENT_STATUSES } from "@/server/marketing/overview-service";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

const FILTER_KEYS = ["status", "type", "campaignId", "pillarId", "q", "page"] as const;

export default async function ContentListRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const raw = await searchParams;
  const picked = Object.fromEntries(
    FILTER_KEYS.flatMap((key) => {
      const value = raw[key];
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
  const filters = contentListQuerySchema.parse(picked);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getContentListPage(workspace.slug, filters));
  if (data === null) {
    return <ForbiddenNotice title={t("content.title")} message={t("common.forbidden")} />;
  }
  const base = `/w/${workspace.slug}/content`;
  const filtered = FILTER_KEYS.some((key) => key !== "page" && filters[key] !== undefined);
  const pageHref = (page: number) => {
    const query = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = key === "page" ? (page > 1 ? String(page) : undefined) : filters[key];
      if (value !== undefined && value !== "") query.set(key, value);
    }
    const text = query.toString();
    return text === "" ? base : `${base}?${text}`;
  };
  const selectClass = cn(inputClass, "h-10");

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("content.title")}
        description={t("content.description")}
        actions={
          data.can.contentCreate ? (
            <Button asChild data-testid="content-new">
              <Link href={`${base}/new`}>{t("content.new")}</Link>
            </Button>
          ) : undefined
        }
      />

      <form
        method="get"
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
        aria-label={t("content.filters")}
        data-testid="content-filters"
      >
        <label className="space-y-1 text-sm font-medium lg:col-span-1">
          <span>{t("content.search")}</span>
          <input
            name="q"
            type="search"
            dir="auto"
            maxLength={100}
            defaultValue={filters.q ?? ""}
            className={selectClass}
          />
        </label>
        <label className="space-y-1 text-sm font-medium">
          <span>{t("content.filterStatus")}</span>
          <select name="status" defaultValue={filters.status ?? ""} className={selectClass}>
            <option value="">{t("content.all")}</option>
            {CONTENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`enums.contentStatus.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium">
          <span>{t("content.filterType")}</span>
          <select name="type" defaultValue={filters.type ?? ""} className={selectClass}>
            <option value="">{t("content.all")}</option>
            {ENUM_VALUES.contentType.map((type) => (
              <option key={type} value={type}>
                {t(`enums.contentType.${type}`)}
              </option>
            ))}
          </select>
        </label>
        {data.options.campaigns.length === 0 ? null : (
          <label className="space-y-1 text-sm font-medium">
            <span>{t("content.filterCampaign")}</span>
            <select
              name="campaignId"
              defaultValue={filters.campaignId ?? ""}
              className={selectClass}
            >
              <option value="">{t("content.all")}</option>
              {data.options.campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {data.options.pillars.length === 0 ? null : (
          <label className="space-y-1 text-sm font-medium">
            <span>{t("content.filterPillar")}</span>
            <select name="pillarId" defaultValue={filters.pillarId ?? ""} className={selectClass}>
              <option value="">{t("content.all")}</option>
              {data.options.pillars.map((pillar) => (
                <option key={pillar.id} value={pillar.id}>
                  {pillar.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit" variant="outline" size="sm">
            {t("content.apply")}
          </Button>
          {filtered ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={base}>{t("content.clear")}</Link>
            </Button>
          ) : null}
        </div>
      </form>

      <p className="text-sm text-muted-foreground" data-testid="content-count">
        {t("content.count", { count: data.total })}
      </p>

      {data.items.length === 0 ? (
        <EmptyState
          message={filtered ? t("content.emptyFiltered") : t("content.empty")}
          action={
            data.can.contentCreate && !filtered ? (
              <Button asChild size="sm">
                <Link href={`${base}/new`}>{t("content.new")}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="content-list">
          {data.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid="content-row"
            >
              <div className="min-w-0 space-y-1">
                <Link
                  href={`${base}/${item.id}`}
                  className="block truncate font-medium hover:underline"
                >
                  {item.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {t(`enums.contentType.${item.type}`)}
                  {item.campaign === null ? null : ` · ${item.campaign.name}`}
                  {item.pillar === null ? null : ` · ${item.pillar.name}`}
                  {" · "}
                  {t("common.updated", {
                    date: format.dateTime(item.updatedAt, { dateStyle: "medium" }),
                  })}
                </p>
              </div>
              <Badge tone={CONTENT_STATUS_TONES[item.status]} testId="content-status">
                {t(`enums.contentStatus.${item.status}`)}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {data.pages > 1 ? (
        <nav
          className="flex items-center justify-between gap-2"
          aria-label={t("common.page", { page: filters.page, pages: data.pages })}
        >
          {filters.page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(filters.page - 1)}>{t("common.previous")}</Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            {t("common.page", { page: filters.page, pages: data.pages })}
          </span>
          {filters.page < data.pages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(filters.page + 1)}>{t("common.next")}</Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
