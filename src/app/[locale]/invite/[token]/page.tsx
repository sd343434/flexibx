import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { requirePageUser } from "@/server/auth/session";
import { previewInvitationForCurrentUser } from "@/server/tenancy/invitation-acceptance";

import { SignOutButton } from "../../(auth)/sign-out-button";

import { AcceptInvitationForm } from "./accept-form";

interface InvitePageProps {
  readonly params: Promise<{ locale: string; token: string }>;
}

// The URL carries a one-time token: keep it out of search indexes and Referer headers.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/{locale}/invite/{token}`: sign in (or sign up) first — the return path brings the
 * user back here in the same locale — then accept. Unusable tokens all look the same.
 */
export default async function InvitePage({ params }: InvitePageProps) {
  const { locale: rawLocale, token } = await params;
  const locale = requireLocale(rawLocale);
  const user = await requirePageUser(locale, `/${locale}/invite/${encodeURIComponent(token)}`);
  const preview = await previewInvitationForCurrentUser(token);
  const t = await getTranslations({ locale, namespace: "invite" });
  const tRoles = await getTranslations({ locale, namespace: "workspaces.roles" });
  const format = await getFormatter({ locale });

  let body;
  if (preview.status === "valid") {
    const params = { workspace: preview.workspaceName, role: tRoles(preview.role) };
    body = (
      <div className="space-y-4" data-testid="invitation-valid">
        <p className="text-lg">
          {preview.inviterName === null
            ? t("validNoInviter", params)
            : t("valid", { ...params, inviter: preview.inviterName })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("expires", { date: format.dateTime(preview.expiresAt, { dateStyle: "long" }) })}
        </p>
        <AcceptInvitationForm token={token} />
      </div>
    );
  } else if (preview.status === "already_member") {
    body = (
      <div className="space-y-4" data-testid="invitation-already-member">
        <h2 className="text-xl font-semibold">{t("alreadyMemberTitle")}</h2>
        <p className="text-muted-foreground">{t("alreadyMember")}</p>
        <Button asChild>
          <Link href={`/w/${preview.slug}`}>{t("openWorkspace")}</Link>
        </Button>
      </div>
    );
  } else if (preview.status === "email_mismatch") {
    body = (
      <div className="space-y-4" data-testid="invitation-email-mismatch">
        <h2 className="text-xl font-semibold">{t("mismatchTitle")}</h2>
        <p className="text-muted-foreground">{t("mismatch")}</p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4" data-testid="invitation-invalid">
        <h2 className="text-xl font-semibold">{t("invalidTitle")}</h2>
        <p className="text-muted-foreground">{t("invalid")}</p>
        <Button asChild variant="outline">
          <Link href="/workspaces">{t("goToWorkspaces")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <SiteHeader actions={<SignOutButton />} />
      <main id="main" className="mx-auto max-w-xl space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground" dir="auto">
            {t("signedInAs", { email: user.email })}
          </p>
        </header>
        {body}
      </main>
    </>
  );
}
