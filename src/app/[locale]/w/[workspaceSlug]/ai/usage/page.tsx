import { getFormatter, getTranslations } from "next-intl/server";

import { Card, ForbiddenNotice, Notice, PageHeader } from "@/components/marketing/page-parts";
import { getAiUsagePage } from "@/server/ai/ai-queries";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";

/** Workspace AI usage over the last 30 days (audit.view). No prompts or outputs. */
export default async function AiUsageRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "ai" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getAiUsagePage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("usage.title")} message={t("usage.forbidden")} />;
  }
  const { usage } = data;
  const number = (value: number) => format.number(value);
  const stats = [
    ["attempts", usage.attempts],
    ["succeeded", usage.succeeded],
    ["failed", usage.failed],
    ["applied", usage.applied],
  ] as const;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("usage.title")}
        description={t("usage.description", { days: usage.windowDays })}
      />
      {data.configured ? null : <Notice testId="ai-not-configured">{t("notConfigured")}</Notice>}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="ai-usage">
        {stats.map(([key, value]) => (
          <li key={key} className="rounded-2xl bg-muted p-4" data-testid={`usage-${key}`}>
            <span className="block text-2xl font-bold">{number(value)}</span>
            <span className="text-xs text-muted-foreground">{t(`usage.${key}`)}</span>
          </li>
        ))}
      </ul>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t("usage.today")}>
          <p className="text-sm" data-testid="usage-today">
            {t("usage.todayValue", { count: usage.today, cap: usage.dailyCap })}
          </p>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("usage.inputTokens")}</dt>
              <dd>{number(usage.inputTokens)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("usage.outputTokens")}</dt>
              <dd>{number(usage.outputTokens)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("usage.cost")}</dt>
              <dd>
                {usage.costMicros === null
                  ? t("usage.costUnknown")
                  : format.number(Number(usage.costMicros) / 1_000_000, {
                      style: "currency",
                      currency: "USD",
                    })}
              </dd>
            </div>
          </dl>
          {usage.unreported > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("usage.unreported", { count: usage.unreported })}
            </p>
          ) : null}
        </Card>
        <Card title={t("usage.byOperation")}>
          {usage.byOperation.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
          ) : (
            <ul className="divide-y text-sm">
              {usage.byOperation.map((row) => (
                <li key={row.operation} className="flex justify-between gap-4 py-2">
                  <span>{t(`operations.${row.operation}`)}</span>
                  <span>{number(row.count)}</span>
                </li>
              ))}
            </ul>
          )}
          {usage.byProvider.length === 0 ? null : (
            <ul className="divide-y border-t text-sm" data-testid="usage-providers">
              {usage.byProvider.map((row) => (
                <li
                  key={`${row.provider}:${row.model ?? ""}`}
                  className="flex justify-between gap-4 py-2"
                >
                  <span dir="ltr">
                    {row.provider}
                    {row.model === null ? "" : ` · ${row.model}`}
                  </span>
                  <span>{number(row.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
