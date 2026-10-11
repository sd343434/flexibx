import { useFormatter, useTranslations } from "next-intl";

import { ActionButton } from "@/components/marketing/entity-form";
import { Badge, Detail, EmptyState } from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import type { ExternalAction } from "@/server/ads/adapter";
import type { AdPlanReview } from "@/server/ads/planner";
import type { AdsPage } from "@/server/ads/ads-queries";
import { currencyDigits, type Money } from "@/server/ads/model";
import { formatDeletionTime } from "@/server/videos/retention-policy";

import {
  submitConnect,
  submitDisconnect,
  submitRefreshAccounts,
  submitSelectAccount,
  submitSyncAccount,
} from "./actions";

// Views of the advertising area. Display only — every button posts to a server action
// that re-checks access. Platforms that cannot be used here say so and why; nothing
// unimplemented is presented as working.

/** Formats integer minor units as money in the viewer's locale. */
export function MoneyText({ money }: { readonly money: Money }) {
  const format = useFormatter();
  return (
    <span dir="ltr" className="tabular-nums">
      {format.number(money.minor / 10 ** currencyDigits(money.currency), {
        style: "currency",
        currency: money.currency,
      })}
    </span>
  );
}

/** One platform as the cards show it (the Integrations overview and the ads page). */
export interface PlatformCardRow {
  readonly platform: AdsPage["platforms"][number]["platform"];
  readonly available: boolean;
  readonly reason: "not_configured" | "not_implemented" | null;
  readonly capabilities: Readonly<Record<string, boolean>> | null;
  readonly connection: {
    readonly status: "ACTIVE" | "EXPIRED" | "REVOKED" | "ERROR";
    readonly externalUserName: string | null;
    readonly scopes: readonly string[];
    readonly tokenExpiresAt: Date | null;
    readonly lastErrorCode: string | null;
    readonly connectedByName: string | null;
  } | null;
  /** This workspace's accounts on the platform, when known. */
  readonly accounts?: {
    readonly total: number;
    readonly selected: number;
    readonly accessLost: number;
  };
}

type PlatformRow = PlatformCardRow;

function platformStatus(row: PlatformRow) {
  if (!row.available) return row.reason === "not_configured" ? "notConfigured" : "notAvailable";
  if (row.connection === null || row.connection.status === "REVOKED") return "notConnected";
  if (row.connection.status === "EXPIRED") return "expired";
  if (row.connection.status === "ERROR") return "needsPermission";
  return "connected";
}

export function PlatformCards({
  slug,
  locale,
  timeZone,
  platforms,
  canManage,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly platforms: readonly PlatformCardRow[];
  readonly canManage: boolean;
}) {
  const t = useTranslations("ads");
  return (
    <ul className="grid gap-4 sm:grid-cols-2" data-testid="ads-platforms">
      {platforms.map((row) => {
        const status = platformStatus(row);
        const connected = status === "connected";
        return (
          <li
            key={row.platform}
            className="flex flex-col gap-3 rounded-xl border bg-card p-4"
            data-testid="ads-platform"
            data-platform={row.platform}
            data-status={status}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">{t(`platforms.${row.platform}.name`)}</p>
              <Badge tone={connected ? "solid" : status === "notAvailable" ? "muted" : "outline"}>
                {t(`platformStatus.${status}`)}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{t(`platforms.${row.platform}.scope`)}</p>
            {status === "notAvailable" ? (
              <p className="text-sm" data-testid="ads-platform-unavailable">
                {t(`platforms.${row.platform}.unavailable`)}
              </p>
            ) : null}
            {status === "notConfigured" ? (
              <p className="text-sm" data-testid="ads-platform-unconfigured">
                {t("notConfigured")}
              </p>
            ) : null}
            {row.capabilities === null ? null : (
              <ul className="grid gap-1 text-sm" data-testid="ads-capabilities">
                {capabilityRows(row).map(({ key: capability, on }) => {
                  return (
                    <li
                      key={capability}
                      className="flex items-center justify-between gap-2"
                      data-capability={capability}
                      data-available={String(on)}
                    >
                      <span>{t(`capabilities.${capability}`)}</span>
                      <Badge tone={on ? "outline" : "muted"}>
                        {on ? t("capabilityOn") : t("capabilityOff")}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            {row.connection !== null && row.connection.status !== "REVOKED" ? (
              <dl className="grid gap-2 text-sm">
                <Detail label={t("connection.as")}>{row.connection.externalUserName ?? "—"}</Detail>
                {row.connection.connectedByName === null ? null : (
                  <Detail label={t("connection.by")}>{row.connection.connectedByName}</Detail>
                )}
                <Detail label={t("connection.permissions")}>
                  <span dir="ltr">{row.connection.scopes.join(", ") || "—"}</span>
                </Detail>
                {row.connection.tokenExpiresAt === null ? null : (
                  <Detail label={t("connection.expires")}>
                    {formatDeletionTime(row.connection.tokenExpiresAt, locale, timeZone)}
                  </Detail>
                )}
                {row.accounts === undefined ? null : (
                  <Detail label={t("connection.accounts")}>
                    <span data-testid="ads-connection-accounts">
                      {t("connection.accountsSummary", {
                        total: row.accounts.total,
                        selected: row.accounts.selected,
                      })}
                    </span>
                    {row.accounts.accessLost === 0 ? null : (
                      <span className="block text-destructive" data-testid="ads-access-lost">
                        {t("connection.accessLost", { count: row.accounts.accessLost })}
                      </span>
                    )}
                  </Detail>
                )}
                {row.connection.lastErrorCode === null ? null : (
                  <p className="text-destructive" role="alert" data-testid="ads-connection-error">
                    {t(`connectionErrors.${connectionErrorKey(row.connection.lastErrorCode)}`)}
                  </p>
                )}
              </dl>
            ) : null}
            {canManage && row.available ? (
              <div className="mt-auto flex flex-wrap gap-2">
                <ActionButton
                  action={submitConnect.bind(null, slug, locale, row.platform)}
                  label={connected ? t("reconnect") : t("connect")}
                  variant={connected ? "outline" : "default"}
                  testId="ads-connect"
                />
                {connected ? (
                  <ActionButton
                    action={submitRefreshAccounts.bind(null, slug, locale, row.platform)}
                    label={t("refreshAccounts")}
                    testId="ads-refresh-accounts"
                  />
                ) : null}
                {row.connection !== null && row.connection.status !== "REVOKED" ? (
                  <ActionButton
                    action={submitDisconnect.bind(null, slug, locale, row.platform)}
                    label={t("disconnect")}
                    confirm={t("disconnectConfirm")}
                    variant="ghost"
                    danger
                    testId="ads-disconnect"
                  />
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** What each available platform can do here — unavailable ones are labelled as such. */
const CAPABILITIES_SHOWN = [
  "listAccounts",
  "readCampaigns",
  "readInsights",
  "launchCampaign",
] as const;

/**
 * WhatsApp is a conversation channel: its rows say what Flexibx does with it (find
 * business accounts, read numbers and templates, record message statuses) and that
 * sending messages is not available.
 */
function capabilityRows(row: PlatformRow) {
  const on = (key: string) => row.capabilities?.[key] === true;
  if (row.platform === "WHATSAPP") {
    return [
      { key: "whatsappAccounts", on: on("listAccounts") },
      { key: "whatsappRead", on: on("listAccounts") },
      { key: "whatsappStatuses", on: on("listAccounts") },
      { key: "whatsappSend", on: false },
    ] as const;
  }
  return CAPABILITIES_SHOWN.map((key) => ({ key, on: on(key) }));
}

const CONNECTION_ERRORS = [
  "permission_missing",
  "token_expired",
  "token_unreadable",
  "rate_limited",
  "provider_error",
] as const;

function connectionErrorKey(code: string): (typeof CONNECTION_ERRORS)[number] | "other" {
  return (CONNECTION_ERRORS as readonly string[]).includes(code)
    ? (code as (typeof CONNECTION_ERRORS)[number])
    : "other";
}

export function AccountList({
  slug,
  locale,
  timeZone,
  accounts,
  canManage,
  canPlan,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly accounts: AdsPage["accounts"];
  readonly canManage: boolean;
  readonly canPlan: boolean;
}) {
  const t = useTranslations("ads");
  const tStatus = useTranslations("ads.deliveryStatus");
  if (accounts.length === 0) {
    return <EmptyState message={t("accounts.empty")} testId="ads-accounts-empty" />;
  }
  return (
    <ul className="space-y-4" data-testid="ads-accounts">
      {accounts.map((account) => (
        <li
          key={account.id}
          className="space-y-3 rounded-xl border bg-card p-4"
          data-testid="ads-account"
          data-account-id={account.id}
          data-selected={String(account.selected)}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium">{account.name}</p>
              <p className="text-xs text-muted-foreground">
                {t(`platforms.${account.platform}.name`)} ·{" "}
                <bdi dir="ltr">{account.externalId}</bdi> · <bdi dir="ltr">{account.currency}</bdi>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={account.status === "ACTIVE" ? "outline" : "muted"}>
                {t(`accountStatus.${account.status as "ACTIVE"}`)}
              </Badge>
              {canManage ? (
                <ActionButton
                  action={submitSelectAccount.bind(
                    null,
                    slug,
                    locale,
                    account.id,
                    !account.selected,
                  )}
                  label={account.selected ? t("accounts.deselect") : t("accounts.select")}
                  variant={account.selected ? "ghost" : "default"}
                  testId="ads-account-select"
                />
              ) : null}
              {canPlan && account.usable ? (
                <ActionButton
                  action={submitSyncAccount.bind(null, slug, locale, account.id)}
                  label={t("accounts.sync")}
                  testId="ads-account-sync"
                />
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {account.lastSyncedAt === null
              ? t("accounts.neverSynced")
              : t("accounts.syncedAt", {
                  date: formatDeletionTime(account.lastSyncedAt, locale, timeZone),
                })}
          </p>
          {account.syncErrorCode === null ? null : (
            <p className="text-sm text-destructive" role="alert" data-testid="ads-sync-error">
              {account.syncErrorCode === "access_lost"
                ? t("accounts.accessLost")
                : t("accounts.syncFailed")}
            </p>
          )}
          {account.selected && account.counts !== null ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {t("campaigns.summary", {
                  campaigns: account.campaigns.length,
                  adSets: account.counts.adSets,
                  ads: account.counts.ads,
                  days: account.rangeDays ?? 30,
                })}
              </p>
              {account.truncated ? (
                <p className="text-xs text-muted-foreground">{t("campaigns.truncated")}</p>
              ) : null}
              {account.platform === "SNAPCHAT" ? (
                <p className="text-xs text-muted-foreground" data-testid="ads-clicks-note">
                  {t("campaigns.snapchatClicks")}
                </p>
              ) : null}
              {account.campaigns.length === 0 ? null : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm" data-testid="ads-campaigns">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="text-start">
                        <th className="py-1 text-start font-medium">{t("campaigns.name")}</th>
                        <th className="py-1 text-start font-medium">{t("campaigns.objective")}</th>
                        <th className="py-1 text-start font-medium">{t("campaigns.status")}</th>
                        <th className="py-1 text-end font-medium">{t("campaigns.impressions")}</th>
                        <th className="py-1 text-end font-medium">{t("campaigns.clicks")}</th>
                        <th className="py-1 text-end font-medium">{t("campaigns.spend")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {account.campaigns.map((campaign) => (
                        <tr
                          key={campaign.externalId}
                          className="border-t"
                          data-testid="ads-campaign"
                          data-status={campaign.status}
                        >
                          <td className="py-1.5 pe-2">{campaign.name}</td>
                          <td className="py-1.5 pe-2">
                            {campaign.objective === null
                              ? "—"
                              : t(`objectives.${campaign.objective}`)}
                          </td>
                          <td className="py-1.5 pe-2">{tStatus(campaign.status)}</td>
                          <td className="py-1.5 text-end tabular-nums">
                            {campaign.impressions ?? "—"}
                          </td>
                          <td className="py-1.5 text-end tabular-nums">{campaign.clicks ?? "—"}</td>
                          <td className="py-1.5 text-end">
                            {campaign.spend === null ? "—" : <MoneyText money={campaign.spend} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function PlanList({
  slug,
  plans,
}: {
  readonly slug: string;
  readonly plans: AdsPage["plans"];
}) {
  const t = useTranslations("ads");
  if (plans.length === 0) return <EmptyState message={t("plans.empty")} testId="ads-plans-empty" />;
  return (
    <ul className="space-y-2" data-testid="ads-plans">
      {plans.map((plan) => (
        <li
          key={plan.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
          data-testid="ads-plan"
          data-status={plan.status}
        >
          <div className="min-w-0">
            <Link
              href={`/w/${slug}/ads/plans/${plan.id}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
              data-testid="ads-plan-link"
            >
              {plan.name}
            </Link>
            <p className="text-xs text-muted-foreground">
              {plan.accountName} ·{" "}
              <span dir="ltr">
                {plan.startDate} → {plan.endDate}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <MoneyText money={plan.budget} />
            <Badge tone={plan.status === "LAUNCHED" ? "solid" : "outline"}>
              {t(`planStatus.${plan.status}`)}
            </Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Suggestions from each account's historical results. Labelled as history (never a
 * forecast); nothing here changes a campaign.
 */
export function OptimizationList({ accounts }: { readonly accounts: AdsPage["accounts"] }) {
  const t = useTranslations("ads.optimization");
  const format = useFormatter();
  const rows = accounts.filter((account) => account.optimization !== null);
  if (rows.length === 0) return <EmptyState message={t("empty")} testId="ads-optimization-empty" />;
  const percent = (value: number) =>
    format.number(value, { style: "percent", maximumFractionDigits: 2 });
  return (
    <ul className="space-y-4" data-testid="ads-optimization">
      {rows.map((account) => {
        const report = account.optimization;
        if (report === null) return null;
        return (
          <li
            key={account.id}
            className="space-y-2 rounded-lg border p-3"
            data-testid="ads-optimization-account"
          >
            <p className="font-medium">{account.name}</p>
            <p
              className="text-xs text-muted-foreground"
              data-testid="ads-optimization-basis"
              data-basis={report.basis.kind}
            >
              {t("basis", { days: report.basis.days })}
            </p>
            {report.recommendations.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("none")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {report.recommendations.map((item, index) => (
                  <li
                    key={`${item.kind}:${String(index)}`}
                    data-testid="ads-recommendation"
                    data-kind={item.kind}
                  >
                    {item.kind === "redistribute" ? (
                      <>
                        {t("redistribute", { from: item.from.name, to: item.to.name })}{" "}
                        <MoneyText money={item.amount} /> {t("perDay")}
                      </>
                    ) : item.kind === "pause" ? (
                      t(item.reason === "no_clicks" ? "pauseNoClicks" : "pauseLowCtr", {
                        name: item.campaign.name,
                        ctr: percent(item.campaign.ctr),
                        median: percent(item.medianCtr),
                      })
                    ) : (
                      t("creativeRefresh", { name: item.campaign.name })
                    )}
                  </li>
                ))}
              </ul>
            )}
            {report.insufficient.length === 0 ? null : (
              <p className="text-xs text-muted-foreground">
                {t("insufficient", { names: report.insufficient.join("، ") })}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The workspace's spending limits per currency. */
export function SpendLimitList({ limits }: { readonly limits: AdsPage["spendLimits"] }) {
  const t = useTranslations("ads");
  if (limits.length === 0) {
    return <EmptyState message={t("spendLimits.empty")} testId="ads-spend-limits-empty" />;
  }
  return (
    <ul className="space-y-2" data-testid="ads-spend-limits">
      {limits.map((limit) => (
        <li
          key={limit.currency}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
          data-testid="ads-spend-limit"
          data-currency={limit.currency}
        >
          <span className="font-medium" dir="ltr">
            {limit.currency}
          </span>
          <span className="text-sm">
            {t("spendLimits.maxPlan")}:{" "}
            <MoneyText money={{ minor: limit.maxPlanBudgetMinor, currency: limit.currency }} /> ·{" "}
            {t("spendLimits.maxDaily")}:{" "}
            <MoneyText money={{ minor: limit.maxDailyBudgetMinor, currency: limit.currency }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The exact calls a launch would make, as the platform would receive them. */
export function ExternalActions({ actions }: { readonly actions: readonly ExternalAction[] }) {
  return (
    <ol className="space-y-2" data-testid="ads-external-actions">
      {actions.map((action, index) => (
        <li
          key={`${action.endpoint}-${String(index)}`}
          className="rounded-lg border bg-muted/40 p-3"
          data-testid="ads-external-action"
        >
          <p className="font-mono text-sm font-semibold" dir="ltr">
            {String(index + 1)}. {action.method} {action.endpoint}
          </p>
          <pre className="mt-2 overflow-x-auto text-xs break-words whitespace-pre-wrap" dir="ltr">
            {JSON.stringify(action.params, null, 2)}
          </pre>
        </li>
      ))}
    </ol>
  );
}

export function ExpectedResultsView({ expected }: { readonly expected: AdPlanReview["expected"] }) {
  const t = useTranslations("ads.review");
  const format = useFormatter();
  if (!expected.available) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ads-expected-none">
        {t(`expectedNone.${expected.reason}`)}
      </p>
    );
  }
  const range = (r: { low: number; high: number }) =>
    `${format.number(r.low)} – ${format.number(r.high)}`;
  return (
    <div className="space-y-1 text-sm" data-testid="ads-expected">
      <p>
        {t("expectedImpressions")}:{" "}
        <span className="tabular-nums">{range(expected.impressions)}</span>
      </p>
      <p>
        {t("expectedClicks")}: <span className="tabular-nums">{range(expected.clicks)}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {t("expectedBasis", {
          days: expected.basis.days,
          ctr: format.number(expected.basis.ctrPercent),
        })}{" "}
        <MoneyText money={expected.basis.cpm} />
      </p>
    </div>
  );
}
