import { randomUUID } from "node:crypto";

import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, inputClass } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  EmptyState,
  ForbiddenNotice,
  Notice,
  PageHeader,
  type BadgeTone,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { Finding, Total } from "@/server/intelligence/analysis";
import { getInsightsPage, parseInsightFilters } from "@/server/intelligence/intelligence-actions";
import { MAX_SNOOZE_DAYS } from "@/server/intelligence/intelligence-service";
import { CSV_COLUMNS, isMoneyMetric, PERFORMANCE_METRICS } from "@/server/intelligence/metrics";
import { MARKETING_CHANNELS } from "@/server/marketing/campaign-plan";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import {
  submitMetricsImport,
  submitRecommendationDecision,
  submitRecommendationDraft,
  submitVoidImport,
} from "./actions";
import { ImportForm } from "./import-form";

// Marketing intelligence dashboard (Pass 5). Every number shows where it came from;
// simulated test data is shown apart and never added to recorded results; nothing is
// estimated. Recommendations are rule-based, with their evidence and limits.

const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  OPEN: "outline",
  REVIEWED: "muted",
  DISMISSED: "muted",
  SNOOZED: "accent",
  ACTED: "solid",
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const dayText = (at: Date | null) => (at === null ? "" : at.toISOString().slice(0, 10));

export default async function InsightsRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const raw = await searchParams;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const filters = parseInsightFilters({
    campaign: first(raw.campaign),
    channel: first(raw.channel),
    metric: first(raw.metric),
    from: first(raw.from),
    to: first(raw.to),
  });
  const data = await guardPage(getInsightsPage(workspace.slug, filters));
  if (data === null) {
    return <ForbiddenNotice title={t("insights.title")} message={t("common.forbidden")} />;
  }
  const base = `/w/${workspace.slug}`;
  const date = (at: Date) => format.dateTime(at, { dateStyle: "medium", timeZone: "UTC" });
  const dateTime = (at: Date) => format.dateTime(at, { dateStyle: "medium", timeStyle: "short" });
  const count = (value: bigint | number) => format.number(Number(value));
  const money = (minor: bigint | number | string, currency: string) =>
    format.number(Number(minor) / 100, { style: "currency", currency });
  const totalText = (total: Total) =>
    total.currency === null ? count(total.value) : money(total.value, total.currency);
  const metricName = (metric: string) => t(`enums.metric.${metric}` as never);
  const latest = data.freshness.latestPeriodEnd;
  const stale =
    latest !== null &&
    (data.now.getTime() - latest.getTime()) / 86_400_000 > data.rules.staleAfterDays;
  const campaignNames = new Map(data.campaignOptions.map((c) => [c.id, c.name]));
  const contentTitles = new Map(
    data.campaigns.flatMap((c) => c.campaign.content.map((item) => [item.id, item.title])),
  );
  const hasRecorded = data.campaigns.some((c) => c.recorded.length > 0);
  const maxSeries = Math.max(1, ...data.series.recorded.map((point) => Number(point.value)));
  const options = (values: readonly string[], label: (value: string) => string) =>
    values.map((value) => ({ value, label: label(value) }));

  const explain = (finding: Finding) => {
    const v = finding.evidence.values;
    const rate = (value: unknown) =>
      format.number(Number(value ?? 0), { style: "percent", maximumFractionDigits: 1 });
    switch (finding.kind) {
      case "BELOW_TARGET":
        return t("insights.kind.BELOW_TARGET.explain", {
          metric: metricName(String(v.metric)),
          actual: count(Number(v.actual ?? 0)),
          expected: count(Number(v.expectedSoFar ?? 0)),
          target: count(Number(v.target ?? 0)),
        });
      case "SPEND_OVER_BUDGET":
        return t("insights.kind.SPEND_OVER_BUDGET.explain", {
          spend: money(String(v.spendMinor ?? 0), String(v.currency)),
          budget: money(String(v.budgetMinor ?? 0), String(v.currency)),
        });
      case "STALE_DATA":
        return t("insights.kind.STALE_DATA.explain", { days: Number(v.daysSinceLatest ?? 0) });
      case "MISSING_DATA":
        return t("insights.kind.MISSING_DATA.explain", { count: Number(v.publishedContent ?? 0) });
      case "WEAK_CONTENT":
        return t("insights.kind.WEAK_CONTENT.explain", {
          rate: rate(v.engagementRate),
          median: rate(v.campaignMedianRate),
          periods: Number(v.periods ?? 0),
          compared: Number(v.comparedItems ?? 0),
        });
      case "STRONG_FORMAT":
        return t("insights.kind.STRONG_FORMAT.explain", {
          type: t(`enums.contentType.${String(v.contentType)}` as never),
          rate: rate(v.formatMedianRate),
          median: rate(v.campaignMedianRate),
          items: Number(v.itemsOfFormat ?? 0),
          others: Number(v.otherItems ?? 0),
        });
      case "MORE_DATA_NEEDED":
        return t("insights.kind.MORE_DATA_NEEDED.explain");
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader title={t("insights.title")} description={t("insights.description")} />

      <Notice testId="insights-provenance">
        <span className="block font-medium">{t("insights.provenanceTitle")}</span>
        {t("insights.provenance")}
      </Notice>
      {data.can.manage ? null : <Notice testId="view-only">{t("insights.viewOnly")}</Notice>}

      <Card title={t("insights.filtersTitle")} testId="insights-filters">
        <form method="get" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              [
                "campaign",
                t("insights.filter.campaign"),
                t("insights.filter.allCampaigns"),
                data.campaignOptions.map((c) => ({ value: c.id, label: c.name })),
                filters.campaignId ?? "",
              ],
              [
                "channel",
                t("insights.filter.channel"),
                t("insights.filter.allChannels"),
                options(MARKETING_CHANNELS, (c) => t(`enums.channel.${c}` as never)),
                filters.channel ?? "",
              ],
              [
                "metric",
                t("insights.filter.metric"),
                null,
                options(
                  PERFORMANCE_METRICS.filter((m) => !isMoneyMetric(m)),
                  metricName,
                ),
                filters.metric,
              ],
            ] as const
          ).map(([name, label, empty, choices, value]) => (
            <div key={name} className="space-y-2">
              <label htmlFor={`filter-${name}`} className="block text-sm font-medium">
                {label}
              </label>
              <select
                id={`filter-${name}`}
                name={name}
                defaultValue={value}
                className={cn(inputClass, "h-10")}
              >
                {empty === null ? null : <option value="">{empty}</option>}
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {(
            [
              ["from", t("insights.filter.from"), filters.from],
              ["to", t("insights.filter.to"), filters.to],
            ] as const
          ).map(([name, label, value]) => (
            <div key={name} className="space-y-2">
              <label htmlFor={`filter-${name}`} className="block text-sm font-medium">
                {label}
              </label>
              <input
                id={`filter-${name}`}
                type="date"
                name={name}
                dir="ltr"
                defaultValue={dayText(value)}
                className={cn(inputClass, "h-10")}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-5">
            <Button type="submit" size="sm" data-testid="insights-filter-apply">
              {t("insights.filter.apply")}
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}/insights`}>{t("insights.filter.reset")}</Link>
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t("insights.freshnessTitle")} testId="insights-freshness">
        <ul className="space-y-1 text-sm">
          <li>
            {data.freshness.lastSuccessAt === null
              ? t("insights.lastImportNever")
              : t("insights.lastImport", { date: dateTime(data.freshness.lastSuccessAt) })}
          </li>
          {data.freshness.lastFailureAt === null ? null : (
            <li className="text-destructive">
              {t("insights.lastFailure", { date: dateTime(data.freshness.lastFailureAt) })}
            </li>
          )}
          {latest === null ? null : <li>{t("insights.latestPeriod", { date: date(latest) })}</li>}
        </ul>
        {stale ? (
          <p role="alert" className="text-sm text-destructive" data-testid="insights-stale">
            {t("insights.staleWarning", { days: data.rules.staleAfterDays })}
          </p>
        ) : null}
        {data.truncated ? <Notice>{t("insights.truncated")}</Notice> : null}
      </Card>

      <Card title={t("insights.recsTitle")} testId="insights-recommendations">
        <p className="text-sm text-muted-foreground">{t("insights.recsNote")}</p>
        {data.recommendations.length === 0 ? (
          <EmptyState message={t("insights.recsEmpty")} testId="insights-recs-empty" />
        ) : (
          <ul className="space-y-4">
            {data.recommendations.map((rec) => {
              const state = rec.state;
              const draftId = state?.draftContentItemId ?? null;
              const decided =
                state !== null && state.decidedAt !== null
                  ? { ...state, decidedAt: state.decidedAt }
                  : null;
              const version = state?.version ?? 0;
              const bind = (action: "review" | "reopen" | "dismiss" | "snooze") =>
                submitRecommendationDecision.bind(
                  null,
                  workspace.slug,
                  locale,
                  rec.fingerprint,
                  version,
                  action,
                );
              const kind = `insights.kind.${rec.kind}` as const;
              return (
                <li
                  key={rec.fingerprint}
                  className="space-y-3 rounded-lg border p-4"
                  data-testid="insights-recommendation"
                  data-kind={rec.kind}
                  data-status={rec.status}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{t(`${kind}.title` as never)}</h3>
                    <Badge tone={STATUS_TONES[rec.status]} testId="insights-rec-status">
                      {t(`insights.status.${rec.status}` as never)}
                    </Badge>
                    <Badge tone={rec.evidence.sufficiency === "sufficient" ? "soft" : "accent"}>
                      {t(`insights.sufficiency.${rec.evidence.sufficiency}` as never)}
                    </Badge>
                    <Badge>{t("enums.metricSource.MANUAL")}</Badge>
                  </div>
                  <p className="text-sm">{explain(rec)}</p>
                  <p className="text-xs text-muted-foreground">
                    {rec.evidence.from === null || rec.evidence.to === null
                      ? t("insights.evidenceNoPeriod", { count: rec.evidence.sampleSize })
                      : t("insights.evidence", {
                          from: rec.evidence.from,
                          to: rec.evidence.to,
                          count: rec.evidence.sampleSize,
                        })}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">→ </span>
                    {t(`${kind}.action` as never)}
                  </p>
                  <p className="text-xs text-muted-foreground">{t(`${kind}.limits` as never)}</p>
                  <p className="flex flex-wrap gap-3 text-sm">
                    <Link href={`${base}/campaigns/${rec.campaignId}`} className="underline">
                      {t("insights.openCampaign")}: {campaignNames.get(rec.campaignId) ?? ""}
                    </Link>
                    {rec.contentItemId === null ? null : (
                      <Link href={`${base}/content/${rec.contentItemId}`} className="underline">
                        {t("insights.openContent")}: {contentTitles.get(rec.contentItemId) ?? ""}
                      </Link>
                    )}
                    {draftId === null ? null : (
                      <Link
                        href={`${base}/content/${draftId}`}
                        className="underline"
                        data-testid="insights-rec-draft"
                      >
                        {t("insights.openDraft")}
                      </Link>
                    )}
                  </p>
                  {decided === null ? null : (
                    <p className="text-xs text-muted-foreground">
                      {t("insights.decidedBy", {
                        status: t(`insights.status.${decided.status}` as never),
                        name: decided.decidedBy?.name ?? "—",
                        date: dateTime(decided.decidedAt),
                      })}
                      {decided.dismissReason === null
                        ? ""
                        : ` · ${t("insights.dismissedBecause", { reason: decided.dismissReason })}`}
                      {rec.status === "SNOOZED" && decided.snoozedUntil !== null
                        ? ` · ${t("insights.snoozedUntil", { date: dateTime(decided.snoozedUntil) })}`
                        : ""}
                    </p>
                  )}
                  {!data.can.manage || rec.status === "ACTED" ? null : (
                    <div className="flex flex-wrap items-end gap-3 border-t pt-3">
                      {rec.status === "OPEN" ? (
                        <ActionButton
                          action={bind("review")}
                          label={t("insights.markReviewed")}
                          testId="insights-rec-review"
                        />
                      ) : (
                        <ActionButton
                          action={bind("reopen")}
                          label={t("insights.reopen")}
                          testId="insights-rec-reopen"
                        />
                      )}
                      <ActionButton
                        action={bind("snooze")}
                        label={t("insights.snooze")}
                        testId="insights-rec-snooze"
                      >
                        <label className="space-y-1 text-xs">
                          <span className="block">{t("insights.snoozeDays")}</span>
                          <select
                            name="days"
                            defaultValue="7"
                            className={cn(inputClass, "h-9 w-20")}
                          >
                            {[1, 3, 7, 14, 30, MAX_SNOOZE_DAYS].map((days) => (
                              <option key={days} value={days}>
                                {days}
                              </option>
                            ))}
                          </select>
                        </label>
                      </ActionButton>
                      <ActionButton
                        action={bind("dismiss")}
                        label={t("insights.dismiss")}
                        testId="insights-rec-dismiss"
                      >
                        <label className="space-y-1 text-xs">
                          <span className="block">{t("insights.dismissReason")}</span>
                          <input name="reason" maxLength={500} className={cn(inputClass, "h-9")} />
                        </label>
                      </ActionButton>
                      {["BELOW_TARGET", "WEAK_CONTENT", "STRONG_FORMAT"].includes(rec.kind) &&
                      data.can.createContent ? (
                        <div className="space-y-1">
                          <ActionButton
                            action={submitRecommendationDraft.bind(
                              null,
                              workspace.slug,
                              locale,
                              rec.fingerprint,
                              version,
                            )}
                            label={t("insights.createDraft")}
                            variant="default"
                            testId="insights-rec-draft-create"
                          />
                          <p className="max-w-sm text-xs text-muted-foreground">
                            {t("insights.createDraftHint")}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {data.history.length === 0 ? null : (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{t("insights.historyTitle")}</summary>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {data.history.map((row) => (
                <li key={row.id}>
                  {t(`insights.kind.${row.kind}.title` as never)} —{" "}
                  {t(`insights.status.${row.status}` as never)}
                  {row.decidedAt === null ? "" : ` · ${dateTime(row.decidedAt)}`}
                  {row.dismissReason === null ? "" : ` · ${row.dismissReason}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card title={t("insights.campaignsTitle")} testId="insights-campaigns">
        {!hasRecorded && !data.hasSimulated ? (
          <EmptyState message={t("insights.empty")} testId="insights-empty" />
        ) : null}
        <ul className="space-y-6">
          {data.campaigns
            .filter(
              (c) => c.recorded.length > 0 || c.simulated.length > 0 || filters.campaignId !== null,
            )
            .map(({ campaign, recorded, simulated }) => {
              const spend = recorded.find(
                (total) => total.metric === "SPEND" && total.currency === campaign.budgetCurrency,
              );
              const otherSpend = recorded.some(
                (total) => total.metric === "SPEND" && total.currency !== campaign.budgetCurrency,
              );
              return (
                <li
                  key={campaign.id}
                  className="space-y-4 rounded-lg border p-4"
                  data-testid="insights-campaign"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`${base}/campaigns/${campaign.id}`}
                      className="font-semibold underline"
                    >
                      {campaign.name}
                    </Link>
                  </div>
                  <section className="space-y-2">
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {t("insights.recordedTitle")}
                      <Badge tone="soft">{t("enums.metricSource.MANUAL")}</Badge>
                    </h3>
                    {recorded.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("insights.noRecorded")}</p>
                    ) : (
                      <dl className="grid gap-3 sm:grid-cols-3" data-testid="insights-recorded">
                        {recorded.map((total) => (
                          <div
                            key={`${total.metric}-${total.currency ?? ""}`}
                            className="space-y-1 rounded-md bg-muted/40 p-3"
                          >
                            <dt className="text-xs font-medium text-muted-foreground">
                              {metricName(total.metric)}
                            </dt>
                            <dd
                              className="text-xl font-semibold tabular-nums"
                              data-testid={`insights-total-${total.metric}`}
                            >
                              {totalText(total)}
                            </dd>
                            <dd className="text-xs text-muted-foreground">
                              {t("insights.observations", { count: total.observations })} ·{" "}
                              {t("insights.periodRange", {
                                from: date(total.from),
                                to: date(total.to),
                              })}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </section>
                  <section className="space-y-1 text-sm" data-testid="insights-budget">
                    <h3 className="font-medium">{t("insights.budgetTitle")}</h3>
                    <p>
                      {campaign.budgetMinor === null || campaign.budgetCurrency === null
                        ? t("insights.budgetNone")
                        : t("insights.budgetPlanned", {
                            amount: money(campaign.budgetMinor, campaign.budgetCurrency),
                          })}
                    </p>
                    <p>
                      {spend === undefined
                        ? t("insights.spendNone")
                        : t("insights.spendRecorded", { amount: totalText(spend) })}
                    </p>
                    {otherSpend ? (
                      <p className="text-xs text-muted-foreground">
                        {t("insights.spendOtherCurrency")}
                      </p>
                    ) : null}
                  </section>
                  {campaign.goals.length === 0 ? null : (
                    <ul className="space-y-1 text-sm">
                      {campaign.goals.map((goal) => {
                        const actual = recorded.find(
                          (total) => total.metric === goal.targetMetric && total.currency === null,
                        );
                        return (
                          <li key={goal.id}>
                            {goal.targetMetric === null || goal.target === null
                              ? t("insights.goalNoMetric", { goal: goal.title })
                              : t("insights.goalTitle", {
                                  goal: goal.title,
                                  actual: count(actual?.value ?? 0),
                                  target: count(goal.target),
                                  metric: metricName(goal.targetMetric),
                                })}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {simulated.length === 0 ? null : (
                    <section
                      className="space-y-2 rounded-md border border-dashed p-3"
                      data-testid="insights-simulated"
                    >
                      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {t("insights.simulatedTitle")}
                        <Badge tone="danger">{t("enums.metricSource.SIMULATED")}</Badge>
                      </h3>
                      <ul className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                        {simulated.map((total) => (
                          <li key={`${total.metric}-${total.currency ?? ""}`}>
                            {metricName(total.metric)}: {totalText(total)}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </li>
              );
            })}
        </ul>
      </Card>

      <Card
        title={t("insights.trendTitle", { metric: metricName(filters.metric) })}
        testId="insights-trend"
      >
        {data.series.recorded.length === 0 ? (
          <EmptyState message={t("insights.trendEmpty")} testId="insights-trend-empty" />
        ) : (
          <>
            <svg
              role="img"
              aria-label={t("insights.trendTitle", { metric: metricName(filters.metric) })}
              viewBox={`0 0 ${String(data.series.recorded.length * 24)} 100`}
              className="h-32 w-full"
              preserveAspectRatio="none"
            >
              {data.series.recorded.map((point, index) => {
                const height = Math.max(1, (Number(point.value) / maxSeries) * 96);
                return (
                  <rect
                    key={point.day.toISOString()}
                    x={index * 24 + 4}
                    y={100 - height}
                    width={16}
                    height={height}
                    className="fill-primary"
                  >
                    <title>{`${date(point.day)}: ${count(point.value)}`}</title>
                  </rect>
                );
              })}
            </svg>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {t("insights.trendValue")}
              </summary>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-start text-xs text-muted-foreground">
                    <th className="text-start font-medium">{t("insights.trendDay")}</th>
                    <th className="text-start font-medium">{t("insights.trendValue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.series.recorded.map((point) => (
                    <tr key={point.day.toISOString()}>
                      <td>{date(point.day)}</td>
                      <td className="tabular-nums">{count(point.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </Card>

      <Card title={t("insights.contentTitle")} testId="insights-content">
        {data.content.length === 0 ? (
          <EmptyState message={t("insights.contentEmpty")} testId="insights-content-empty" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  {(
                    ["content", "type", "impressions", "engagements", "rate", "periods"] as const
                  ).map((col) => (
                    <th key={col} scope="col" className="py-2 text-start font-medium">
                      {t(`insights.col.${col}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.content.map((row) => (
                  <tr
                    key={row.contentItemId}
                    className="border-b last:border-0"
                    data-testid="insights-content-row"
                  >
                    <td className="py-2">
                      <Link
                        href={`${base}/content/${row.contentItemId}`}
                        className="hover:underline"
                      >
                        {row.content?.title}
                      </Link>
                    </td>
                    <td>
                      {row.content === null
                        ? ""
                        : t(`enums.contentType.${row.content.type}` as never)}
                    </td>
                    <td className="tabular-nums">{count(row.impressions)}</td>
                    <td className="tabular-nums">{count(row.engagements)}</td>
                    <td className="tabular-nums">
                      {row.engagementRate === null
                        ? "—"
                        : format.number(row.engagementRate, {
                            style: "percent",
                            maximumFractionDigits: 1,
                          })}
                    </td>
                    <td className="tabular-nums">{row.periods}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data.can.manage && data.campaignOptions.length > 0 ? (
        <Card title={t("insights.importTitle")} testId="insights-import">
          <ImportForm
            action={submitMetricsImport.bind(null, workspace.slug, locale)}
            campaigns={data.campaignOptions.map((c) => ({ value: c.id, label: c.name }))}
            channels={options(MARKETING_CHANNELS, (c) => t(`enums.channel.${c}` as never))}
            batchKey={randomUUID()}
            example={[
              CSV_COLUMNS.join(","),
              "2026-10-01,2026-10-07,IMPRESSIONS,12500,,",
              "2026-10-01,2026-10-07,SPEND,350.00,SAR,",
            ].join("\n")}
          />
        </Card>
      ) : null}

      <Card title={t("insights.importsTitle")} testId="insights-imports">
        {data.imports.length === 0 ? (
          <EmptyState message={t("insights.importsEmpty")} testId="insights-imports-empty" />
        ) : (
          <ul className="divide-y text-sm">
            {data.imports.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid="insights-import-row"
              >
                <div className="space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        row.status === "FAILED"
                          ? "danger"
                          : row.status === "VOIDED"
                            ? "muted"
                            : "soft"
                      }
                    >
                      {t(`insights.importStatus.${row.status}` as never)}
                    </Badge>
                    <Badge>{t(`enums.metricSource.${row.source}` as never)}</Badge>
                    <span dir="ltr" className="text-xs text-muted-foreground">
                      {row.provider}
                    </span>
                    <span className="text-xs text-muted-foreground">{dateTime(row.createdAt)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("insights.importCounts", {
                      accepted: row.rowsAccepted,
                      duplicates: row.rowsDuplicate,
                      rejected: row.rowsRejected,
                    })}
                    {row.errorCode === null
                      ? ""
                      : ` · ${t.has(`insights.issue.${row.errorCode}` as never) ? t(`insights.issue.${row.errorCode}` as never) : row.errorCode}`}
                    {row.campaignId === null ? "" : ` · ${campaignNames.get(row.campaignId) ?? ""}`}
                  </p>
                </div>
                {data.can.manage && row.status === "SUCCEEDED" ? (
                  <ActionButton
                    action={submitVoidImport.bind(null, workspace.slug, locale, row.id)}
                    label={t("insights.voidImport")}
                    confirm={t("insights.voidConfirm")}
                    danger
                    testId="insights-import-void"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("insights.rulesTitle")} testId="insights-rules">
        <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
          {Object.entries(data.rules).map(([key, value]) => (
            <li key={key}>
              {t(`insights.rules.${key as keyof typeof data.rules}`, {
                value:
                  key === "minElapsedShare"
                    ? format.number(value, { style: "percent" })
                    : format.number(value),
              })}
            </li>
          ))}
        </ul>
        <h3 className="pt-2 text-sm font-medium">{t("insights.definitionsTitle")}</h3>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {PERFORMANCE_METRICS.map((metric) => (
            <div key={metric}>
              <dt className="font-medium">{metricName(metric)}</dt>
              <dd className="text-muted-foreground">
                {t(`insights.definitions.${metric}` as never)}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
