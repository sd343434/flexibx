import { getTranslations } from "next-intl/server";

import { requireLocale } from "@/i18n/params";

import { loadWorkspace } from "./load-workspace";

interface WorkspacePageProps {
  readonly params: Promise<{ locale: string; workspaceSlug: string }>;
}

/** Workspace home: deliberately minimal until later phases add product features. */
export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { locale: rawLocale, workspaceSlug } = await params;
  const locale = requireLocale(rawLocale);
  const { workspace } = await loadWorkspace(locale, workspaceSlug);
  const t = await getTranslations({ locale, namespace: "workspaces" });

  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-bold" data-testid="workspace-name">
        {workspace.name}
      </h1>
      <p className="text-muted-foreground" data-testid="workspace-role">
        {t("home.role", { role: t(`roles.${workspace.role}`) })}
      </p>
      <p className="text-muted-foreground">{t("home.intro")}</p>
    </section>
  );
}
