import { getTranslations } from "next-intl/server";

import { Card, ForbiddenNotice, Notice, PageHeader } from "@/components/marketing/page-parts";
import { getIntegrationsPage } from "@/server/ads/ads-queries";
import { AD_PLATFORMS } from "@/server/ads/model";

import { PlatformCards } from "../ads/ads-views";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import { WhatsAppMessaging } from "./messaging-views";
import { WhatsAppAccounts } from "./whatsapp-views";

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
 * Integrations: every platform Flexibx supports and THIS workspace's own connection to
 * it. Flexibx owns one developer app per platform (server configuration); each workspace
 * connects its own accounts through the platform's sign-in and can reconnect or
 * disconnect at any time. Connecting never authorizes spending, publishing or messaging.
 */
export default async function IntegrationsRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "integrations" });
  const tAds = await getTranslations({ locale, namespace: "ads" });
  const data = await guardPage(getIntegrationsPage(workspace.slug));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const query = await searchParams;
  const outcome = CONNECT_OUTCOMES.find((value) => value === query.connect) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <ul className="grid gap-2 text-sm sm:grid-cols-3" data-testid="integrations-principles">
        {(["own", "consent", "noSpend"] as const).map((key) => (
          <li key={key} className="rounded-lg border bg-card px-3 py-2">
            {t(`principles.${key}`)}
          </li>
        ))}
      </ul>
      {outcome === null ? null : outcome === "connected" ? (
        <Notice testId="ads-connect-outcome">{tAds("connectOutcome.connected")}</Notice>
      ) : (
        <p
          className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive"
          role="alert"
          data-testid="ads-connect-outcome"
        >
          {tAds(`connectOutcome.${outcome}`)}
        </p>
      )}

      <Card title={t("platformsTitle")} testId="integrations-platforms-card">
        <PlatformCards
          slug={workspace.slug}
          locale={locale}
          timeZone={data.timeZone}
          platforms={data.platforms}
          canManage={data.canManage}
        />
      </Card>

      <Card title={t("whatsapp.title")} testId="integrations-whatsapp-card">
        <p className="text-sm text-muted-foreground">{t("whatsapp.hint")}</p>
        <WhatsAppAccounts
          slug={workspace.slug}
          locale={locale}
          timeZone={data.timeZone}
          accounts={data.whatsapp}
          canManage={data.canManage}
          canPlan={data.canPlan}
        />
        <p className="text-sm text-muted-foreground">{t("whatsapp.ctwa")}</p>
      </Card>

      <Card title={t("messaging.title")} testId="integrations-messaging-card">
        <WhatsAppMessaging
          slug={workspace.slug}
          locale={locale}
          timeZone={data.timeZone}
          data={data}
          requestKey={crypto.randomUUID()}
        />
      </Card>

      <Card title={t("requirementsTitle")} testId="integrations-requirements">
        <dl className="grid gap-3 text-sm">
          {AD_PLATFORMS.map((platform) => (
            <div key={platform} data-platform={platform}>
              <dt className="font-medium">{tAds(`platforms.${platform}.name`)}</dt>
              <dd className="text-muted-foreground">{t(`requirements.${platform}`)}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
