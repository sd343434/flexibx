import { CircleUser } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Workspace roles as stored on the server (WorkspaceRole); only ever displayed here. */
export type ShellRole = "OWNER" | "ADMIN" | "MANAGER" | "EDITOR" | "VIEWER" | "CLIENT";

interface UserMenuProps {
  readonly name: string;
  readonly email: string;
  readonly role: ShellRole;
  /** The sign-out control (a server action form). */
  readonly signOut: ReactNode;
}

/** Who is signed in, their role in this workspace, and sign-out. */
export function UserMenu({ name, email, role, signOut }: UserMenuProps) {
  const t = useTranslations("shell.userMenu");
  const tRoles = useTranslations("workspaces.roles");

  return (
    <details className="relative" data-testid="user-menu">
      <summary
        className="flex cursor-pointer list-none items-center rounded-md p-2 hover:bg-accent [&::-webkit-details-marker]:hidden"
        aria-label={t("label")}
      >
        <CircleUser aria-hidden="true" className="size-5" />
      </summary>
      <div className="absolute end-0 z-30 mt-2 w-64 rounded-md border bg-card p-3 text-card-foreground shadow-lg">
        <p className="text-xs text-muted-foreground">{t("signedInAs")}</p>
        <p className="truncate font-medium" data-testid="user-name">
          {name}
        </p>
        <p className="truncate text-sm text-muted-foreground" dir="ltr" data-testid="user-email">
          {email}
        </p>
        <p className="mt-2 text-sm" data-testid="user-role">
          {t("role", { role: tRoles(role) })}
        </p>
        <div className="mt-3 border-t pt-2">{signOut}</div>
      </div>
    </details>
  );
}
