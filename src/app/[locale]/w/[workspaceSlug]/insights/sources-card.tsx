import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton } from "@/components/marketing/entity-form";
import { Badge, Card, Notice, type BadgeTone } from "@/components/marketing/page-parts";
import type { Locale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import type {
  InsightsConnection,
  SourceCard,
  SourceStatus,
} from "@/server/intelligence/insights-sync";
import { META_INSIGHTS_SCOPES } from "@/server/intelligence/meta-insights";

import { submitDisableSource, submitEnableSource, submitSyncSource } from "./actions";

// The Meta sources of the insights page (Pass 6): what the workspace's Meta connection
// allows, which Pages / Instagram accounts are read, how each one's last syncs went, and
// its account-level numbers — shown apart from campaign results, with the days they cover.
// Nothing here pretends to be connected: every state comes from the server.

const STATUS_TONES: Readonly<Record<SourceStatus, BadgeTone>> = {
  disabled: "muted",
  needs_reauth: "danger",
  running: "accent",
  never_synced: "outline",
  failed: "danger",
  stale: "accent",
  ready: "soft",
};

export async function SourcesCard({
  locale,
  slug,
  sources,
  can,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly sources: {
    readonly connection: InsightsConnection;
    readonly channels: readonly SourceCard[];
  };
  readonly can: {
    readonly manageSources: boolean;
    readonly manage: boolean;
    readonly connectMeta: boolean;
  };
}) {
  const t = await getTranslations({ locale, namespace: "marketing.insights.sources" });
  const tm = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const dateTime = (at: Date) => format.dateTime(at, { dateStyle: "medium", timeStyle: "short" });
  const day = (at: Date) => format.dateTime(at, { dateStyle: "medium", timeZone: "UTC" });
  const { connection } = sources;
  const usable = connection.state === "ready";
  const errorText = (code: string) =>
    t.has(`error.${code}` as never) ? t(`error.${code}` as never) : code;
  const details = (source: NonNullable<SourceCard["source"]>) => {
    return (
      <div className="space-y-2 text-sm">
        {source.disabledReason === null ? null : (
          <p className="text-muted-foreground" data-testid="insights-source-disabled-reason">
            {t(`disabledReason.${source.disabledReason}` as never)}
          </p>
        )}
        <ul className="space-y-1 text-muted-foreground">
          <li>
            {source.lastSuccessAt === null
              ? t("lastSuccessNever")
              : t("lastSuccess", { date: dateTime(source.lastSuccessAt) })}
          </li>
          {source.lastAttemptAt === null ? null : (
            <li>{t("lastAttempt", { date: dateTime(source.lastAttemptAt) })}</li>
          )}
          {source.enabled ? (
            <li>
              {source.nextSyncAt === null
                ? t("nextSyncNone")
                : t("nextSync", { date: dateTime(source.nextSyncAt) })}
            </li>
          ) : null}
          {source.coveredFrom === null || source.coveredTo === null ? null : (
            <li>{t("coverage", { from: day(source.coveredFrom), to: day(source.coveredTo) })}</li>
          )}
        </ul>
        {source.lastErrorCode === null ? null : (
          <p role="status" className="text-destructive" data-testid="insights-source-error">
            {t("lastError", { reason: errorText(source.lastErrorCode) })}
          </p>
        )}
        {source.missingPermissions.length === 0 ? null : (
          <p className="text-xs text-destructive" dir="ltr">
            {source.missingPermissions.join(", ")}
          </p>
        )}
        {source.unsupportedMetrics.length === 0 ? null : (
          <p className="text-xs text-muted-foreground">
            {t("unsupported", { metrics: source.unsupportedMetrics.join(", ") })}
          </p>
        )}
        {source.window === null || source.totals.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noTotals")}</p>
        ) : (
          <section className="space-y-2" data-testid="insights-source-totals">
            <h4 className="flex flex-wrap items-center gap-2 text-xs font-medium">
              {t("totals", { from: day(source.window.from), to: day(source.window.to) })}
              <Badge tone="soft">{tm("enums.metricSource.VERIFIED")}</Badge>
            </h4>
            <dl className="grid gap-3 sm:grid-cols-3">
              {source.totals.map((total) => (
                <div key={total.metric} className="space-y-1 rounded-md bg-muted/40 p-3">
                  <dt className="text-xs text-muted-foreground">
                    {tm(`enums.metric.${total.metric}` as never)}
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {format.number(Number(total.value))}
                  </dd>
                  <dd className="text-xs text-muted-foreground">
                    {t("totalDays", { days: total.days })}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        {source.runs.length === 0 ? null : (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t("runsTitle")}</summary>
            <ul className="mt-2 space-y-1" data-testid="insights-source-runs">
              {source.runs.map((run) => (
                <li key={run.id}>
                  {t("run", {
                    trigger: t(`trigger.${run.trigger}`),
                    status: t(`runStatus.${run.status}` as never),
                    date: dateTime(run.startedAt),
                  })}
                  {" · "}
                  {t("runCounts", { rows: run.rowsStored, calls: run.calls })}
                  {run.errorCode === null ? "" : ` · ${errorText(run.errorCode)}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  };

  return (
    <Card title={t("title")} testId="insights-sources">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <p className="text-xs text-muted-foreground" dir="ltr">
        {t("permissions", {
          permissions: [
            ...new Set([
              ...META_INSIGHTS_SCOPES.FACEBOOK_PAGE,
              ...META_INSIGHTS_SCOPES.INSTAGRAM_ACCOUNT,
            ]),
          ].join(", "),
        })}
      </p>
      <Notice testId={`insights-sources-${connection.state}`}>
        {t(`state.${connection.state}`)}
        {connection.state === "not_connected" || connection.state === "needs_reauth" ? (
          can.connectMeta ? (
            <>
              {" "}
              <Link href={`/w/${slug}/integrations`} className="font-medium underline">
                {t("connectLink")}
              </Link>
            </>
          ) : null
        ) : null}
      </Notice>
      {connection.state === "not_configured" ? null : (
        <>
          {(["FACEBOOK_PAGE", "INSTAGRAM_ACCOUNT"] as const).map((kind) =>
            connection.missing[kind].length === 0 || connection.state === "not_connected" ? null : (
              <p
                key={kind}
                className="text-xs text-destructive"
                data-testid="insights-sources-missing"
              >
                {t("missing", {
                  kind: t(`kind.${kind}`),
                  permissions: connection.missing[kind].join(", "),
                })}
              </p>
            ),
          )}
          {sources.channels.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="insights-sources-empty">
              {t("noChannels")}{" "}
              <Link href={`/w/${slug}/social`} className="font-medium underline">
                {t("socialLink")}
              </Link>
            </p>
          ) : (
            <ul className="space-y-4">
              {sources.channels.map((channel) => {
                const source = channel.source;
                return (
                  <li
                    key={channel.channelId}
                    className="space-y-3 rounded-lg border p-4"
                    data-testid="insights-source"
                    data-status={source?.status ?? "none"}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{channel.name}</span>
                      <Badge>{t(`platform.${channel.platform}`)}</Badge>
                      {source === null ? null : (
                        <Badge tone={STATUS_TONES[source.status]} testId="insights-source-status">
                          {t(`status.${source.status}`)}
                        </Badge>
                      )}
                      {channel.channelEnabled ? null : (
                        <Badge tone="danger">{t("channelUnavailable")}</Badge>
                      )}
                    </div>
                    {source === null ? (
                      <p className="text-sm text-muted-foreground">{t("notRead")}</p>
                    ) : (
                      details(source)
                    )}
                    <div className="flex flex-wrap items-end gap-3">
                      {source !== null && source.enabled && can.manage && usable ? (
                        <ActionButton
                          action={submitSyncSource.bind(null, slug, locale, source.id)}
                          label={t("syncNow")}
                          variant="default"
                          testId="insights-source-sync"
                        />
                      ) : null}
                      {!can.manageSources ? null : source?.enabled === true ? (
                        <ActionButton
                          action={submitDisableSource.bind(null, slug, locale, source.id)}
                          label={t("disable")}
                          testId="insights-source-disable"
                        />
                      ) : usable && channel.channelEnabled ? (
                        <ActionButton
                          action={submitEnableSource.bind(null, slug, locale, channel.channelId)}
                          label={t("enable")}
                          testId="insights-source-enable"
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
