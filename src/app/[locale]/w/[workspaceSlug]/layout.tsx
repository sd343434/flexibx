import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { requireLocale } from "@/i18n/params";

import { SignOutButton } from "../../(auth)/sign-out-button";

import { loadWorkspace } from "./load-workspace";

interface WorkspaceLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ locale: string; workspaceSlug: string }>;
}

export default async function WorkspaceLayout({ children, params }: WorkspaceLayoutProps) {
  const { locale: rawLocale, workspaceSlug } = await params;
  const shell = await loadWorkspace(requireLocale(rawLocale), workspaceSlug);

  return (
    <AppShell
      workspace={shell.workspace}
      workspaces={shell.workspaces}
      user={shell.user}
      nav={shell.nav}
      signOut={<SignOutButton />}
    >
      {children}
    </AppShell>
  );
}
