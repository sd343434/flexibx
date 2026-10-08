import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { Link } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { getCurrentUser } from "@/server/auth/session";
import { postSignInPath } from "@/server/auth/safe-redirect";

import { SignInForm } from "./sign-in-form";

interface SignInPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const single = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function SignInPage({ params, searchParams }: SignInPageProps) {
  const locale = requireLocale((await params).locale);
  const query = await searchParams;
  const next = single(query.next);
  // Signed-in users have nothing to do here.
  if ((await getCurrentUser()) !== null) redirect(postSignInPath(next, locale));

  const t = await getTranslations({ locale, namespace: "auth.signIn" });
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-md space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </header>
        <SignInForm
          next={next}
          notice={
            single(query.reset) === "1"
              ? "passwordReset"
              : single(query.verified) === "1"
                ? "verified"
                : single(query.registered) === "1"
                  ? "registered"
                  : undefined
          }
        />
        <p className="text-sm">
          <Link
            href="/forgot-password"
            className="font-medium text-primary underline-offset-4 hover:underline"
            data-testid="forgot-password-link"
          >
            {t("forgotPassword")}
          </Link>
        </p>
        <p className="text-sm text-muted-foreground">
          {t("noAccount")}{" "}
          <Link
            href={next === undefined ? "/sign-up" : { pathname: "/sign-up", query: { next } }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("signUpLink")}
          </Link>
        </p>
      </main>
    </>
  );
}
