import { useTranslations } from "next-intl";

import { ActionButton } from "@/components/marketing/entity-form";
import { Badge, EmptyState } from "@/components/marketing/page-parts";
import type { IntegrationsPage } from "@/server/ads/ads-queries";
import { formatDeletionTime } from "@/server/videos/retention-policy";

import { submitSelectWhatsApp, submitSyncWhatsApp } from "./actions";

// WhatsApp Business accounts of the workspace: masked business numbers, message templates
// and message-status counts from verified webhooks. Display only; there is no send action.

const STATUS_ORDER = ["sent", "delivered", "read", "failed", "received", "other"] as const;

export function WhatsAppAccounts({
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
  readonly accounts: IntegrationsPage["whatsapp"];
  readonly canManage: boolean;
  readonly canPlan: boolean;
}) {
  const t = useTranslations("integrations.whatsapp");
  const tAds = useTranslations("ads");
  if (accounts.length === 0) return <EmptyState message={t("empty")} testId="whatsapp-empty" />;
  return (
    <ul className="space-y-4" data-testid="whatsapp-accounts">
      {accounts.map((account) => (
        <li
          key={account.id}
          className="space-y-3 rounded-xl border bg-card p-4"
          data-testid="whatsapp-account"
          data-selected={String(account.selected)}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium">{account.name}</p>
              <p className="text-xs text-muted-foreground">
                <bdi dir="ltr">{account.externalId}</bdi>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={account.status === "ACTIVE" ? "outline" : "muted"}>
                {tAds(`accountStatus.${account.status as "ACTIVE"}`)}
              </Badge>
              {canManage ? (
                <ActionButton
                  action={submitSelectWhatsApp.bind(
                    null,
                    slug,
                    locale,
                    account.id,
                    !account.selected,
                  )}
                  label={account.selected ? t("deselect") : t("select")}
                  variant={account.selected ? "ghost" : "default"}
                  testId="whatsapp-select"
                />
              ) : null}
              {canPlan && account.usable ? (
                <ActionButton
                  action={submitSyncWhatsApp.bind(null, slug, locale, account.id)}
                  label={t("sync")}
                  testId="whatsapp-sync"
                />
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {account.lastSyncedAt === null
              ? t("neverSynced")
              : t("syncedAt", { date: formatDeletionTime(account.lastSyncedAt, locale, timeZone) })}
          </p>
          {account.syncErrorCode === null ? null : (
            <p className="text-sm text-destructive" role="alert" data-testid="whatsapp-sync-error">
              {account.syncErrorCode === "access_lost"
                ? tAds("accounts.accessLost")
                : t("syncFailed")}
            </p>
          )}
          {account.selected ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="space-y-2" data-testid="whatsapp-numbers">
                <h3 className="text-sm font-semibold">{t("numbers")}</h3>
                {account.snapshot === null || account.snapshot.phoneNumbers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noNumbers")}</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {account.snapshot.phoneNumbers.map((number) => (
                      <li
                        key={number.id}
                        className="flex flex-wrap items-center justify-between gap-2"
                        data-testid="whatsapp-number"
                      >
                        <span>
                          <bdi dir="ltr" className="tabular-nums">
                            {number.maskedNumber}
                          </bdi>{" "}
                          · {number.verifiedName ?? "—"}
                        </span>
                        <Badge tone={number.qualityRating === "GREEN" ? "outline" : "muted"}>
                          {t("quality")}: {t(`qualityLabels.${number.qualityRating}`)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="space-y-2" data-testid="whatsapp-templates">
                <h3 className="text-sm font-semibold">{t("templates")}</h3>
                {account.snapshot === null || account.snapshot.templates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noTemplates")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr>
                          <th className="py-1 text-start font-medium">{t("templateName")}</th>
                          <th className="py-1 text-start font-medium">{t("language")}</th>
                          <th className="py-1 text-start font-medium">{t("category")}</th>
                          <th className="py-1 text-start font-medium">{t("status")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {account.snapshot.templates.map((template) => (
                          <tr
                            key={`${template.name}:${template.language}`}
                            className="border-t"
                            data-testid="whatsapp-template"
                          >
                            <td className="py-1.5 pe-2">
                              <bdi dir="ltr">{template.name}</bdi>
                            </td>
                            <td className="py-1.5 pe-2">
                              <bdi dir="ltr">{template.language}</bdi>
                            </td>
                            <td className="py-1.5 pe-2">
                              <bdi dir="ltr">{template.category}</bdi>
                            </td>
                            <td className="py-1.5">
                              <bdi dir="ltr">{template.status}</bdi>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="space-y-2 lg:col-span-2" data-testid="whatsapp-statuses">
                <h3 className="text-sm font-semibold">{t("statuses")}</h3>
                <p className="text-xs text-muted-foreground">{t("statusesHint")}</p>
                <dl className="flex flex-wrap gap-4 text-sm">
                  {STATUS_ORDER.map((status) => (
                    <div key={status} data-status={status}>
                      <dt className="text-xs text-muted-foreground">
                        {t(`statusLabels.${status}`)}
                      </dt>
                      <dd className="tabular-nums">{account.statusCounts[status] ?? 0}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
