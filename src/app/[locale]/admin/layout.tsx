import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { SiteHeader } from "@/components/common/site-header";
import { Link } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { requirePlatformAdminPage } from "@/server/admin/platform-admin";

import { SignOutButton } from "../(auth)/sign-out-button";

// Internal platform administration (Flexibx staff). Every page and action below checks
// the platform-admin flag on the server; anyone else gets the standard 404.

export const metadata: Metadata = { robots: { index: false, follow: false } };

interface AdminLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ locale: string }>;
}

export default async function AdminLayout({ children, params }: AdminLayoutProps) {
  const locale = requireLocale((await params).locale);
  await requirePlatformAdminPage();
  const t = await getTranslations({ locale, namespace: "admin" });
  return (
    <>
      <SiteHeader actions={<SignOutButton />} />
      <main id="main" className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
        <header className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{t("internal")}</p>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
        </header>
        <nav aria-label={t("nav.label")} className="flex gap-4 border-b pb-2 text-sm">
          <Link href="/admin/storage" className="font-medium underline-offset-4 hover:underline">
            {t("nav.storage")}
          </Link>
        </nav>
        {children}
      </main>
    </>
  );
}
