import { Check, ChevronsUpDown, List } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";

export interface SwitcherWorkspace {
  readonly name: string;
  readonly slug: string;
}

interface WorkspaceSwitcherProps {
  readonly current: SwitcherWorkspace;
  /** The signed-in user's own memberships, loaded on the server. */
  readonly workspaces: readonly SwitcherWorkspace[];
}

/**
 * Switching is plain navigation to `/{locale}/w/{slug}`, which authorizes again on the
 * server. Links keep the current locale. No JavaScript is needed (`<details>`).
 */
export function WorkspaceSwitcher({ current, workspaces }: WorkspaceSwitcherProps) {
  const t = useTranslations("shell.switcher");

  return (
    <details className="group relative" data-testid="workspace-switcher">
      <summary
        className="flex max-w-56 cursor-pointer list-none items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent [&::-webkit-details-marker]:hidden"
        aria-label={t("label")}
      >
        <span className="truncate" data-testid="current-workspace">
          {current.name}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 opacity-60" />
      </summary>
      <div className="absolute start-0 z-30 mt-2 w-64 rounded-md border bg-card p-1 text-card-foreground shadow-lg">
        <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t("label")}</p>
        <ul>
          {workspaces.map((workspace) => {
            const isCurrent = workspace.slug === current.slug;
            return (
              <li key={workspace.slug}>
                <Link
                  href={`/w/${workspace.slug}`}
                  aria-current={isCurrent ? "page" : undefined}
                  data-testid={`switch-to-${workspace.slug}`}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent aria-[current=page]:font-semibold"
                >
                  <Check aria-hidden="true" className={isCurrent ? "size-4" : "invisible size-4"} />
                  <span className="truncate">{workspace.name}</span>
                  {isCurrent ? <span className="sr-only">({t("current")})</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 border-t pt-1">
          <Link
            href={{ pathname: "/workspaces", query: { list: "1" } }}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            data-testid="all-workspaces"
          >
            <List aria-hidden="true" className="size-4" />
            {t("all")}
          </Link>
        </div>
      </div>
    </details>
  );
}
