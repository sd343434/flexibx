import { randomUUID } from "node:crypto";

import { getFormatter, getTranslations } from "next-intl/server";

import { EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { getBillingPage } from "@/server/billing/billing-actions";
import { CREDIT_FEATURES } from "@/server/billing/pricing";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import { submitCheckout, submitCreditSettings } from "./actions";

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

/**
 * Credits: what the workspace has, what each AI task costs, what it used this period,
 * its own spending caps, optional automatic top-up and every movement. Owners and
 * admins see it; owners change the caps. Credits pay for Flexibx's AI work only — the
 * advertising budget is paid to the ad platform and set on the Ads page.
 */
export default async function BillingRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "billing" });
  const tv = await getTranslations({ locale, namespace: "validation" });
  const format = await getFormatter({ locale });
  const query = await searchParams;
  const checkoutState = one(query.checkout);
  const data = await guardPage(getBillingPage(workspace.slug, one(query.intent)));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const number = (value: number) => format.number(value);
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });
  const value = (cap: number | null | undefined) =>
    cap === null || cap === undefined ? "" : String(cap);

  const fields: readonly FieldSpec[] = [
    {
      kind: "number",
      name: "dailyCap",
      label: t("caps.daily"),
      hint: t("caps.emptyHint"),
      defaultValue: value(data.dailyCap),
      dir: "ltr",
    },
    {
      kind: "number",
      name: "periodCap",
      label: t("caps.period"),
      hint: t("caps.emptyHint"),
      defaultValue: value(data.periodCap),
      dir: "ltr",
    },
    ...CREDIT_FEATURES.map((feature): FieldSpec => ({
      kind: "number",
      name: `featureCap_${feature}`,
      label: t("caps.feature", { feature: t(`features.${feature}`) }),
      defaultValue: value(data.featureCaps[feature]),
      dir: "ltr",
    })),
    {
      kind: "checkbox",
      name: "autoRechargeEnabled",
      label: t("auto.enabled"),
      hint: data.paymentsConfigured ? t("auto.hint") : t("auto.unavailable"),
      defaultChecked: data.autoRecharge.enabled,
      wide: true,
    },
    {
      kind: "number",
      name: "autoRechargeThreshold",
      label: t("auto.threshold"),
      defaultValue: value(data.autoRecharge.threshold),
      dir: "ltr",
    },
    {
      kind: "number",
      name: "autoRechargeAmount",
      label: t("auto.amount"),
      defaultValue: value(data.autoRecharge.amount),
      dir: "ltr",
    },
    {
      kind: "number",
      name: "autoRechargePeriodMax",
      label: t("auto.periodMax"),
      hint: t("auto.periodMaxHint"),
      defaultValue: value(data.autoRecharge.periodMax),
      dir: "ltr",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <Notice testId="billing-provisional">{t("provisional")}</Notice>
      <Notice testId="billing-separation">{t("separation")}</Notice>

      {checkoutState === "success" ? (
        <Notice testId="checkout-return">
          {data.checkout?.status === "SUCCEEDED"
            ? t("buy.credited", { credits: number(data.checkout.credits) })
            : t("buy.processing")}
        </Notice>
      ) : checkoutState === "cancelled" ? (
        <Notice testId="checkout-return">{t("buy.cancelled")}</Notice>
      ) : checkoutState === "error" ? (
        <Notice testId="checkout-return">
          {(() => {
            const reason = one(query.reason) ?? "";
            return /^payments_[a-z_]+$/.test(reason) && tv.has(reason as never)
              ? tv(reason as "payments_checkout_failed")
              : tv("payments_checkout_failed");
          })()}
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3" data-testid="billing-balance">
        <Card title={t("balance.available")}>
          <p className="text-3xl font-bold" data-testid="billing-available">
            {number(data.available)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("balance.split", {
              subscription: number(data.subscriptionCredits),
              purchased: number(data.purchasedCredits),
            })}
          </p>
          {data.heldCredits > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("balance.held", { held: number(data.heldCredits) })}
            </p>
          ) : null}
        </Card>
        <Card title={t("plan.title")}>
          <p className="text-lg font-semibold" data-testid="billing-plan">
            {t.has(`plans.${data.planCode}` as never)
              ? t(`plans.${data.planCode}` as "plans.trial")
              : data.planCode}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("plan.period", { start: date(data.periodStart), end: date(data.periodEnd) })}
          </p>
          <p className="text-sm text-muted-foreground">{t("plan.expiry")}</p>
        </Card>
        <Card title={t("usage.title")}>
          <p className="text-3xl font-bold">{number(data.usage.periodTotal)}</p>
          <p className="text-sm text-muted-foreground">
            {t("usage.today", { today: number(data.usage.today) })}
          </p>
        </Card>
      </div>

      <Card title={t("buy.title")} testId="billing-buy">
        <p className="text-sm text-muted-foreground">{t("buy.hint")}</p>
        {!data.cardCheckout ? (
          <p className="text-sm text-muted-foreground" data-testid="billing-buy-off">
            {t("buy.unavailable")}
          </p>
        ) : !data.canManage ? (
          <p className="text-sm text-muted-foreground">{t("buy.ownerOnly")}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-3">
            {data.packages.map((pack) => (
              <li key={pack.id} className="rounded-md border p-3 text-sm" data-package={pack.id}>
                <p className="font-semibold">{t("prices.credits", { count: pack.credits })}</p>
                <p className="text-muted-foreground" dir="ltr">
                  {format.number(pack.amountMinor / 100, {
                    style: "currency",
                    currency: pack.currency.toUpperCase(),
                  })}
                </p>
                <form
                  action={submitCheckout.bind(null, workspace.slug, locale, pack.id, randomUUID())}
                >
                  <button
                    type="submit"
                    className="mt-2 rounded-md border px-3 py-1 text-sm font-medium"
                    data-testid={`buy-${pack.id}`}
                  >
                    {t("buy.button")}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("buy.testMode")}</p>
      </Card>

      <Card title={t("prices.title")} testId="billing-prices">
        <p className="text-sm text-muted-foreground">{t("prices.hint")}</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.prices.map((price) => (
            <li
              key={price.feature}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              data-feature={price.feature}
            >
              <span>{t(`features.${price.feature}`)}</span>
              <span className="font-medium">
                {t("prices.credits", { count: price.credits })}
                {" · "}
                {t("prices.used", { count: data.usage.period[price.feature] ?? 0 })}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t("prices.version")}</p>
      </Card>

      <Card title={t("caps.title")} testId="billing-settings">
        <p className="text-sm text-muted-foreground">{t("caps.hint")}</p>
        {data.canManage ? (
          <EntityForm
            action={submitCreditSettings.bind(null, workspace.slug, locale, data.version)}
            fields={fields}
            submitLabel={t("caps.save")}
            pendingLabel={t("caps.saving")}
            testId="billing-settings-form"
          />
        ) : (
          <ul className="space-y-1 text-sm">
            <li>
              {t("caps.daily")}: {data.dailyCap === null ? t("caps.none") : number(data.dailyCap)}
            </li>
            <li>
              {t("caps.period")}:{" "}
              {data.periodCap === null ? t("caps.none") : number(data.periodCap)}
            </li>
            <li>
              {t("auto.enabled")}: {data.autoRecharge.enabled ? t("auto.on") : t("auto.off")}
            </li>
          </ul>
        )}
      </Card>

      {data.recharges.length === 0 ? null : (
        <Card title={t("recharges.title")} testId="billing-recharges">
          <ul className="space-y-1 text-sm">
            {data.recharges.map((recharge) => (
              <li key={recharge.id} className="flex items-center justify-between">
                <span>
                  {date(recharge.createdAt)} · {t("prices.credits", { count: recharge.amount })}
                </span>
                <Badge tone={recharge.status === "SUCCEEDED" ? "solid" : "outline"}>
                  {t(`recharges.${recharge.status as "PENDING"}`)}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={t("ledger.title")} testId="billing-ledger">
        {data.ledger.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("ledger.empty")}</p>
        ) : (
          <ul className="divide-y text-sm">
            {data.ledger.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-kind={entry.kind}
              >
                <span>
                  {t(`ledger.kinds.${entry.kind}`)}
                  {entry.feature === null ? null : (
                    <>
                      {" "}
                      ·{" "}
                      {t.has(`features.${entry.feature}` as never)
                        ? t(`features.${entry.feature}` as "features.ai_text")
                        : entry.feature}
                    </>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  <span dir="ltr" className={entry.amount < 0 ? "text-destructive" : undefined}>
                    {entry.amount > 0 ? "+" : ""}
                    {number(entry.amount)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("ledger.after", { balance: number(entry.balanceAfter) })}
                  </span>
                  <span className="text-muted-foreground">{date(entry.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
