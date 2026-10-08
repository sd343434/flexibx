import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { Link } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";

import { EmailRequestForm } from "../email-request-form";

interface ForgotPasswordPageProps {
  readonly params: Promise<{ locale: string }>;
}

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Request a reset link. The answer is the same whether or not the account exists. */
export default async function ForgotPasswordPage({ params }: ForgotPasswordPageProps) {
  const locale = requireLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "auth.forgotPassword" });

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-md space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </header>
        <EmailRequestForm
          kind="forgot-password"
          label={t("email")}
          submit={t("submit")}
          submitting={t("submitting")}
          sent={t("sent")}
        />
        <p className="text-sm">
          <Link
            href="/sign-in"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("backToSignIn")}
          </Link>
        </p>
      </main>
    </>
  );
}
