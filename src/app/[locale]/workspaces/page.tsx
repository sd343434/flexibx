import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { SiteHeader } from "@/components/common/site-header";
import { Button } from "@/components/ui/button";
import { Link, redirect } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { requirePageUser } from "@/server/auth/session";
import { getMyWorkspaceLanding } from "@/server/workspaces/workspace-queries";

import { SignOutButton } from "../(auth)/sign-out-button";

interface WorkspacesPageProps {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function WorkspacesPage({ params, searchParams }: WorkspacesPageProps) {
  const locale = requireLocale((await params).locale);
  await requirePageUser(locale, `/${locale}/workspaces`);

  // `?list=1` (the switcher's "all workspaces" link) shows the list instead of a default.
  const showList = (await searchParams).list === "1";
  const landing = await getMyWorkspaceLanding({ showList });
  if (landing.kind === "create") return redirect({ href: "/workspaces/new", locale });
  if (landing.kind === "open") return redirect({ href: `/w/${landing.slug}`, locale });

  const t = await getTranslations({ locale, namespace: "workspaces" });
  return (
    <>
      <SiteHeader actions={<SignOutButton />} />
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
