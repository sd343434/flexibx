import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { BrandMark, BrandSymbol } from "@/components/common/brand-mark";
import { LocaleSwitcher } from "@/components/common/locale-switcher";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { Link } from "@/i18n/navigation";

import { ShellNav, type ShellNavItem } from "./shell-nav";
import { UserMenu, type ShellRole } from "./user-menu";
import { WorkspaceSwitcher, type SwitcherWorkspace } from "./workspace-switcher";

export interface AppShellProps {
  readonly workspace: SwitcherWorkspace & { readonly role: ShellRole };
  readonly workspaces: readonly SwitcherWorkspace[];
  readonly user: { readonly name: string; readonly email: string };
  /** Navigation entries the current role may open (decided on the server). */
  readonly nav: Readonly<Record<Exclude<ShellNavItem["id"], "home">, boolean>>;
  readonly signOut: ReactNode;
  readonly children: ReactNode;
}

/**
 * The authenticated workspace frame: brand, workspace switcher, user menu and the
 * workspace navigation. Presentational only — every value comes from server-side
 * data loaded after `requireWorkspaceAccess`. Navigation lists only pages that exist.
 */
export function AppShell({ workspace, workspaces, user, nav, signOut, children }: AppShellProps) {
  const t = useTranslations("shell");
  const tCommon = useTranslations("common");
  const home = `/w/${workspace.slug}`;
  const sections = [
    "content",
    "social",
    "ai",
    "autopilot",
    "ads",
    "integrations",
    "calendar",
    "campaigns",
    "brand",
    "media",
    "activity",
    "members",
    "billing",
  ] as const;
  const navItems: ShellNavItem[] = [
    { id: "home", href: home, label: t("nav.home") },
    ...sections
      .filter((id) => nav[id])
      .map((id) => ({ id, href: `${home}/${id}`, label: t(`nav.${id}`) })),
  ];

  return (
    <div
      className="min-h-screen bg-background lg:flex lg:items-stretch lg:gap-4 lg:p-4"
      data-testid="app-shell"
    >
      <aside className="flex flex-col gap-4 px-4 pt-4 lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)] lg:w-64 lg:shrink-0 lg:gap-6 lg:px-2 lg:py-4">
        <Link href={home} className="self-start rounded-md px-2">
          <BrandMark label={tCommon("appName")} />
        </Link>
        <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
        <ShellNav items={navItems} label={t("nav.label")} />
        <div className="mt-auto hidden shrink-0 space-y-4 rounded-3xl bg-feature p-5 text-feature-foreground lg:block dark:[--brand-loop:#ffffff]">
          <BrandSymbol className="h-8 w-16" />
          <p className="text-lg leading-snug font-bold">{t("brand.tagline")}</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 lg:p-0">
        <div className="flex items-center justify-end gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
          <UserMenu name={user.name} email={user.email} role={workspace.role} signOut={signOut} />
        </div>
        <main id="main" className="w-full flex-1 rounded-3xl bg-panel p-4 shadow-sm sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
