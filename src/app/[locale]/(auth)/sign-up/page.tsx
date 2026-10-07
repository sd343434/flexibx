import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { Link } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { getCurrentUser } from "@/server/auth/session";
import { postSignInPath } from "@/server/auth/safe-redirect";

import { SignUpForm } from "./sign-up-form";

interface SignUpPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignUpPage({ params, searchParams }: SignUpPageProps) {
  const locale = requireLocale((await params).locale);
  const rawNext = (await searchParams).next;
  const next = typeof rawNext === "string" ? rawNext : undefined;
  // Signed-in users have nothing to do here.
  if ((await getCurrentUser()) !== null) redirect(postSignInPath(next, locale));

  const t = await getTranslations({ locale, namespace: "auth.signUp" });
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-md space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </header>
        <SignUpForm next={next} />
        <p className="text-sm text-muted-foreground">
          {t("haveAccount")}{" "}
          <Link
            href={next === undefined ? "/sign-in" : { pathname: "/sign-in", query: { next } }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("signInLink")}
          </Link>
        </p>
      </main>
    </>
  );
}
