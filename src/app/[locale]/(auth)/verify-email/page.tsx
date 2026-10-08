import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { requireLocale } from "@/i18n/params";
import { getCurrentUser } from "@/server/auth/session";

import { VerifyEmailFlow } from "./verify-email-flow";

interface VerifyEmailPageProps {
  readonly params: Promise<{ locale: string }>;
}

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function VerifyEmailPage({ params }: VerifyEmailPageProps) {
  const locale = requireLocale((await params).locale);
  const user = await getCurrentUser();
  const t = await getTranslations({ locale, namespace: "auth.verifyEmail" });

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-md space-y-8 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <VerifyEmailFlow signedIn={user !== null} alreadyVerified={user?.emailVerified === true} />
      </main>
    </>
  );
}
