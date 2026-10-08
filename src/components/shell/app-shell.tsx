import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

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
  readonly nav: { readonly members: boolean };
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
  const navItems: ShellNavItem[] = [
    { id: "home", href: home, label: t("nav.home") },
    ...(nav.members
      ? [{ id: "members", href: `${home}/members`, label: t("nav.members") } as const]
      : []),
  ];

  return (
    <div className="flex min-h-screen flex-col" data-testid="app-shell">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <Link href={home} className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles aria-hidden="true" className="size-4" />
            </span>
            <span className="hidden sm:inline">{tCommon("appName")}</span>
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
          <div className="ms-auto flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
            <UserMenu name={user.name} email={user.email} role={workspace.role} signOut={signOut} />
          </div>
        </div>
        <ShellNav items={navItems} label={t("nav.label")} />
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        {children}
      </main>
    </div>
  );
}
