import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { SignInRequired } from "@/components/common/sign-in-required";
import { SiteHeader } from "@/components/common/site-header";
import { Button } from "@/components/ui/button";
import { Link, redirect } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { getCurrentUser } from "@/server/auth/session";
import { listMyWorkspaces } from "@/server/tenancy/access";
import { decideWorkspaceLanding } from "@/server/workspaces/landing";

interface WorkspacesPageProps {
  readonly params: Promise<{ locale: string }>;
}

export default async function WorkspacesPage({ params }: WorkspacesPageProps) {
  const locale = requireLocale((await params).locale);
  if ((await getCurrentUser()) === null) {
    return (
      <>
        <SiteHeader />
        <SignInRequired />
      </>
    );
  }

  const landing = decideWorkspaceLanding(await listMyWorkspaces());
  if (landing.kind === "create") return redirect({ href: "/workspaces/new", locale });
  if (landing.kind === "open") return redirect({ href: `/w/${landing.slug}`, locale });

  const t = await getTranslations({ locale, namespace: "workspaces" });
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-xl space-y-8 px-4 py-16 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">{t("list.title")}</h1>
          <p className="text-muted-foreground">{t("list.description")}</p>
        </header>
        <ul className="space-y-3" data-testid="workspace-list">
          {landing.workspaces.map((workspace) => (
            <li key={workspace.slug}>
              <Link
                href={`/w/${workspace.slug}`}
                className="flex items-center justify-between gap-4 rounded-xl border bg-card p-4 text-card-foreground hover:bg-accent"
              >
                <span className="font-medium">{workspace.name}</span>
                <span className="text-sm text-muted-foreground">
                  {t(`roles.${workspace.role}`)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <Button asChild variant="outline">
          <Link href="/workspaces/new">
            <Plus aria-hidden="true" />
            {t("list.create")}
          </Link>
        </Button>
      </main>
    </>
  );
}
