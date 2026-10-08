import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { requireLocale } from "@/i18n/params";

import { ResetPasswordForm } from "./reset-password-form";

interface ResetPasswordPageProps {
  readonly params: Promise<{ locale: string }>;
}

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({ params }: ResetPasswordPageProps) {
  const locale = requireLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "auth.resetPassword" });

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-md space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </header>
        <ResetPasswordForm />
      </main>
    </>
  );
}
