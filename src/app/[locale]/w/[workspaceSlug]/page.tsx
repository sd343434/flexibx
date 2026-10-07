import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { requireLocale } from "@/i18n/params";
import { requirePageUser } from "@/server/auth/session";
import { isAppError } from "@/server/errors/app-error";
import { getWorkspaceOverview } from "@/server/workspaces/workspace-queries";

import { SignOutButton } from "../../(auth)/sign-out-button";

interface WorkspacePageProps {
  readonly params: Promise<{ locale: string; workspaceSlug: string }>;
}

// Minimal landing target for Step 4's redirects (after creation, and for a user with
// exactly one workspace). The workspace layout, shell and switcher are Step 6.
export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { locale: rawLocale, workspaceSlug } = await params;
  const locale = requireLocale(rawLocale);
  await requirePageUser(locale, `/${locale}/w/${encodeURIComponent(workspaceSlug)}`);

  const workspace = await getWorkspaceOverview(workspaceSlug).catch((error: unknown) => {
    // Unknown, deleted and foreign workspaces are indistinguishable: all render 404.
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  });
  const t = await getTranslations({ locale, namespace: "workspaces" });

  return (
    <>
      <SiteHeader actions={<SignOutButton />} />
      <main id="main" className="mx-auto max-w-xl space-y-4 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold" data-testid="workspace-name">
          {workspace.name}
        </h1>
        <p className="text-muted-foreground">
          {t("home.role", { role: t(`roles.${workspace.role}`) })}
        </p>
      </main>
    </>
  );
}
