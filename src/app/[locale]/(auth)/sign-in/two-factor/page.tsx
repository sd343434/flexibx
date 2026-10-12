import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { Link } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { getCurrentUser } from "@/server/auth/session";
import { postSignInPath } from "@/server/auth/safe-redirect";

import { TwoFactorForm } from "./two-factor-form";

interface TwoFactorPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Second sign-in step. Reached after a correct password for an account with two-factor
 * authentication; the challenge itself lives in a signed, short-lived cookie checked by
 * the server action, so opening this page directly grants nothing.
 */
export default async function TwoFactorPage({ params, searchParams }: TwoFactorPageProps) {
  const locale = requireLocale((await params).locale);
  const raw = (await searchParams).next;
  const next = typeof raw === "string" ? raw : undefined;
  if ((await getCurrentUser()) !== null) redirect(postSignInPath(next, locale));

  const t = await getTranslations({ locale, namespace: "auth.twoFactor" });
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-md space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("challengeTitle")}</h1>
          <p className="text-muted-foreground">{t("challengeDescription")}</p>
        </header>
        <TwoFactorForm next={next} />
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
