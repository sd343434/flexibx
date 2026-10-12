import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { requireLocale } from "@/i18n/params";
import { requirePageUser } from "@/server/auth/session";
import { isTwoFactorEnabled } from "@/server/auth/two-factor-status";

import { SignOutButton } from "../../(auth)/sign-out-button";

import { ChangePasswordForm } from "./change-password-form";
import { TwoFactorSection } from "./two-factor-section";

interface AccountSecurityPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Account security: password change and two-step verification (no session list/revoke
 * UI, C7). Platform administrators are sent here when the admin area needs it.
 */
export default async function AccountSecurityPage({
  params,
  searchParams,
}: AccountSecurityPageProps) {
  const locale = requireLocale((await params).locale);
  const user = await requirePageUser(locale, `/${locale}/account/security`);
  const t = await getTranslations({ locale, namespace: "auth.changePassword" });
  const query = await searchParams;
  const enabled = await isTwoFactorEnabled(user.id);
  const notice =
    query.mfa === "enabled"
      ? "enabled"
      : query.mfa === "disabled"
        ? "disabled"
        : query.admin === "enroll" && !enabled
          ? "adminEnroll"
          : query.admin === "verify"
            ? "adminVerify"
            : undefined;

  return (
    <>
      <SiteHeader actions={<SignOutButton />} />
      <main id="main" className="mx-auto max-w-md space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground" dir="ltr">
            <bdi>{user.email}</bdi>
          </p>
          <p className="text-muted-foreground">{t("description")}</p>
        </header>
        <ChangePasswordForm changed={query.changed === "1"} />
        <TwoFactorSection enabled={enabled} notice={notice} />
      </main>
    </>
  );
}
