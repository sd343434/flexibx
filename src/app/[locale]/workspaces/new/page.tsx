import { getTranslations } from "next-intl/server";

import { SignInRequired } from "@/components/common/sign-in-required";
import { SiteHeader } from "@/components/common/site-header";
import { requireLocale } from "@/i18n/params";
import { getCurrentUser } from "@/server/auth/session";

import { CreateWorkspaceForm } from "./create-workspace-form";

interface NewWorkspacePageProps {
  readonly params: Promise<{ locale: string }>;
}

export default async function NewWorkspacePage({ params }: NewWorkspacePageProps) {
  const locale = requireLocale((await params).locale);
  const user = await getCurrentUser();
  const t = await getTranslations({ locale, namespace: "workspaces.new" });

  return (
    <>
      <SiteHeader />
      {user === null ? (
        <SignInRequired />
      ) : (
        <main id="main" className="mx-auto max-w-xl space-y-8 px-4 py-16 sm:px-6">
          <header className="space-y-2">
            <h1 className="text-3xl font-bold">{t("title")}</h1>
            <p className="text-muted-foreground">{t("description")}</p>
          </header>
          <CreateWorkspaceForm />
        </main>
      )}
    </>
  );
}
