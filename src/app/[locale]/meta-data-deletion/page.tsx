import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { requireLocale } from "@/i18n/params";

interface DataDeletionPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = { referrer: "no-referrer" };

const CODE = /^[0-9a-f]{20}$/;
const SECTIONS = ["removed", "kept", "yourself", "contact"] as const;

/**
 * `/{locale}/meta-data-deletion`: public. The "Data deletion instructions" page for the
 * Meta app, and the status page a data deletion request's confirmation code links to
 * (POST /api/integrations/meta/data-deletion deletes synchronously, so a valid code is
 * always complete). The code is only echoed back; nothing is looked up.
 */
export default async function DataDeletionPage({ params, searchParams }: DataDeletionPageProps) {
  const locale = requireLocale((await params).locale);
  const raw = (await searchParams).code;
  const code = typeof raw === "string" && CODE.test(raw) ? raw : null;
  const t = await getTranslations({ locale, namespace: "metaDataDeletion" });
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-3xl space-y-8 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        {code === null ? null : (
          <p
            className="rounded-lg border bg-card p-4 text-card-foreground"
            data-testid="meta-deletion-status"
          >
            {t("completed", { code })}
          </p>
        )}
        {SECTIONS.map((section) => (
          <section key={section} className="space-y-2">
            <h2 className="text-xl font-semibold">{t(`${section}.title`)}</h2>
            <p className="text-muted-foreground">{t(`${section}.body`)}</p>
          </section>
        ))}
      </main>
    </>
  );
}
