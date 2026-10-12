import { randomUUID } from "node:crypto";

import { getFormatter, getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import { Card } from "@/components/marketing/page-parts";
import { requireLocale } from "@/i18n/params";
import { getCreditsAdminView } from "@/server/admin/credits-admin-actions";

import { submitAddCredits, submitChangePlan } from "./actions";

/** Platform admin → Credits: one workspace's balance, plan, costs; add credits; change plan. */
export default async function CreditsAdminPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = requireLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "admin.credits" });
  const format = await getFormatter({ locale });
  const raw = (await searchParams).workspace;
  const slug = typeof raw === "string" ? raw : null;
  const view = await getCreditsAdminView(slug);
  const usd = (micros: string | null) =>
    micros === null
      ? t("unknown")
      : format.number(Number(micros) / 1_000_000, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 4,
        });

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      <form
        method="get"
        className="flex flex-wrap items-end gap-2"
        data-testid="admin-credits-search"
      >
        <label className="space-y-1 text-sm">
          <span className="block font-medium">{t("slug")}</span>
          <input
            name="workspace"
            defaultValue={slug ?? ""}
            dir="ltr"
            className="h-9 rounded-md border bg-background px-3"
          />
        </label>
        <button type="submit" className="h-9 rounded-md border px-3 text-sm font-medium">
          {t("find")}
        </button>
      </form>
      {slug !== null && view.workspace === null ? <p className="text-sm">{t("notFound")}</p> : null}
      {view.workspace === null ? null : (
        <>
          <Card
            title={`${view.workspace.name} (${view.workspace.slug})`}
            testId="admin-credits-account"
          >
            <ul className="space-y-1 text-sm">
              <li>
                {t("plan")}: {view.workspace.planCode}
              </li>
              <li>
                {t("balance", {
                  subscription: view.workspace.subscriptionCredits,
                  purchased: view.workspace.purchasedCredits,
                  held: view.workspace.heldCredits,
                })}
              </li>
              <li>{t("charged", { credits: view.workspace.report.credits })}</li>
              <li>
                {t("cost")}: {usd(view.workspace.report.providerCostMicros)}
              </li>
              <li>
                {t("margin")}: {usd(view.workspace.report.marginMicros)}
              </li>
              {view.workspace.report.unknownCost > 0 ? (
                <li>{t("unknownCount", { count: view.workspace.report.unknownCost })}</li>
              ) : null}
            </ul>
          </Card>
          <Card title={t("add.title")}>
            <EntityForm
              action={submitAddCredits.bind(null, locale, view.workspace.id, randomUUID())}
              fields={[
                {
                  kind: "select",
                  name: "kind",
                  label: t("add.kind"),
                  required: true,
                  options: [
                    { value: "PURCHASE", label: t("add.purchase") },
                    { value: "ADJUSTMENT", label: t("add.adjustment") },
                  ],
                },
                {
                  kind: "number",
                  name: "amount",
                  label: t("add.amount"),
                  hint: t("add.amountHint"),
                  required: true,
                  dir: "ltr",
                },
                {
                  kind: "text",
                  name: "externalRef",
                  label: t("add.reference"),
                  maxLength: 160,
                  dir: "ltr",
                },
                { kind: "text", name: "note", label: t("add.note"), maxLength: 300 },
              ]}
              submitLabel={t("add.submit")}
              pendingLabel={t("saving")}
              testId="admin-credits-add"
            />
          </Card>
          <Card title={t("planChange.title")}>
            <p className="text-sm text-muted-foreground">{t("planChange.hint")}</p>
            <EntityForm
              action={submitChangePlan.bind(null, locale, view.workspace.id)}
              fields={[
                {
                  kind: "select",
                  name: "planCode",
                  label: t("plan"),
                  required: true,
                  options: view.plans.map((plan) => ({
                    value: plan.code,
                    label: `${plan.code} (${String(plan.periodCredits)})`,
                  })),
                },
              ]}
              submitLabel={t("planChange.submit")}
              pendingLabel={t("saving")}
              testId="admin-credits-plan"
            />
          </Card>
        </>
      )}
    </div>
  );
}
