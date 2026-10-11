import { getTranslations } from "next-intl/server";

import { EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import { Card, ForbiddenNotice, Notice, PageHeader } from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getAdsPage } from "@/server/ads/ads-queries";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import { submitCreatePlan, submitSpendLimit } from "./actions";
import { AccountList, OptimizationList, PlanList, SpendLimitList } from "./ads-views";

const CONNECT_OUTCOMES = [
  "connected",
  "oauth_invalid",
  "denied",
  "forbidden",
  "permission_missing",
  "not_configured",
  "provider_error",
] as const;

/**
 * Advertising: the workspace's platform connections (Meta and Snapchat; the others shown as not
 * yet available), its ad accounts with read-only campaigns and results, and campaign
 * plans. Everything comes from server-side data; every control posts to a server action.
 */
export default async function AdsRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "ads" });
  const data = await guardPage(getAdsPage(workspace.slug));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const query = await searchParams;
  const outcome = CONNECT_OUTCOMES.find((value) => value === query.connect) ?? null;
  const usableAccounts = data.accounts.filter((account) => account.usable);
  const today = new Date().toISOString().slice(0, 10);

  const planFields: readonly FieldSpec[] = [
    {
      kind: "select",
      name: "accountId",
      label: t("planForm.account"),
      required: true,
      options: usableAccounts.map((account) => ({
        value: account.id,
        label: `${account.name} (${account.currency})`,
      })),
    },
    {
      kind: "text",
      name: "budget",
      label: t("planForm.budget"),
      hint: t("planForm.budgetHint"),
      required: true,
      dir: "ltr",
      maxLength: 20,
    },
    {
      kind: "date",
      name: "startDate",
      label: t("planForm.start"),
      required: true,
      defaultValue: today,
    },
    { kind: "date", name: "endDate", label: t("planForm.end"), required: true },
    {
      kind: "textarea",
      name: "request",
      label: t("planForm.request"),
      hint: t("planForm.requestHint"),
      maxLength: 1000,
      rows: 3,
      wide: true,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {outcome === null ? null : outcome === "connected" ? (
        <Notice testId="ads-connect-outcome">{t("connectOutcome.connected")}</Notice>
      ) : (
        <p
          className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive"
          role="alert"
          data-testid="ads-connect-outcome"
        >
          {t(`connectOutcome.${outcome}`)}
        </p>
      )}

      <Card title={t("platformsTitle")} testId="ads-platforms-card">
        <p className="text-sm text-muted-foreground">{t("manageLink")}</p>
        <ul className="flex flex-wrap gap-2 text-sm" data-testid="ads-platform-summary">
          {data.platforms.map((row) => (
            <li
              key={row.platform}
              className="rounded-full border px-3 py-1"
              data-platform={row.platform}
              data-connected={String(row.connection?.status === "ACTIVE")}
            >
              {t(`platforms.${row.platform}.name`)}
            </li>
          ))}
        </ul>
        <Link
          href={`/w/${workspace.slug}/integrations`}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          data-testid="ads-integrations-link"
        >
          {t("manageLinkLabel")}
        </Link>
      </Card>

      <Card title={t("accounts.title")} testId="ads-accounts-card">
        <p className="text-sm text-muted-foreground">{t("accounts.hint")}</p>
        <AccountList
          slug={workspace.slug}
          locale={locale}
          timeZone={data.timeZone}
          accounts={data.accounts}
          canManage={data.canManage}
          canPlan={data.canPlan}
        />
      </Card>

      <Card title={t("optimization.title")} testId="ads-optimization-card">
        <p className="text-sm text-muted-foreground">{t("optimization.hint")}</p>
        <OptimizationList accounts={data.accounts} />
      </Card>

      <Card title={t("spendLimits.title")} testId="ads-spend-limits-card">
        <p className="text-sm text-muted-foreground">{t("spendLimits.hint")}</p>
        <p
          className="text-sm"
          data-testid="ads-execution-flag"
          data-enabled={String(data.executionEnabled)}
        >
          {data.executionEnabled ? t("spendLimits.executionOn") : t("spendLimits.executionOff")}
        </p>
        <SpendLimitList limits={data.spendLimits} />
        {data.canManage ? (
          <EntityForm
            action={submitSpendLimit.bind(null, workspace.slug, locale)}
            fields={[
              {
                kind: "text",
                name: "currency",
                label: t("spendLimits.currency"),
                dir: "ltr",
                required: true,
                maxLength: 3,
              },
              {
                kind: "text",
                name: "maxPlanBudget",
                label: t("spendLimits.maxPlan"),
                dir: "ltr",
                required: true,
                maxLength: 20,
              },
              {
                kind: "text",
                name: "maxDailyBudget",
                label: t("spendLimits.maxDaily"),
                dir: "ltr",
                required: true,
                maxLength: 20,
              },
            ]}
            submitLabel={t("spendLimits.save")}
            pendingLabel={t("planForm.pending")}
            testId="ads-spend-limit-form"
          />
        ) : null}
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <Card title={t("plans.title")} testId="ads-plans-card">
          <PlanList slug={workspace.slug} plans={data.plans} />
        </Card>
        {data.canPlan ? (
          <Card title={t("planForm.title")} testId="ads-plan-form-card">
            <p className="text-sm text-muted-foreground">{t("planForm.hint")}</p>
            {!data.aiConfigured ? (
              <Notice testId="ads-ai-off">{t("planForm.aiOff")}</Notice>
            ) : usableAccounts.length === 0 ? (
              <Notice testId="ads-no-accounts">{t("planForm.noAccounts")}</Notice>
            ) : (
              <EntityForm
                action={submitCreatePlan.bind(null, workspace.slug, locale)}
                fields={planFields}
                submitLabel={t("planForm.submit")}
                pendingLabel={t("planForm.pending")}
                testId="ads-plan-form"
              />
            )}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
