"use client";

import { House, Users } from "lucide-react";

import { Link, usePathname } from "@/i18n/navigation";

export interface ShellNavItem {
  readonly id: "home" | "members";
  readonly href: string;
  readonly label: string;
}

const ICONS = { home: House, members: Users } as const;

/**
 * Workspace navigation. The items (and which ones the role may see) are decided on the
 * server; this component only marks the current page.
 */
export function ShellNav({
  items,
  label,
}: {
  readonly items: readonly ShellNavItem[];
  readonly label: string;
}) {
  const pathname = usePathname();
  const home = items[0]?.href;

  return (
    <nav aria-label={label} className="mx-auto max-w-6xl overflow-x-auto px-4 sm:px-6">
      <ul className="flex gap-1">
        {items.map((item) => {
          const Icon = ICONS[item.id];
          const current =
            item.href === home ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                data-testid={`nav-${item.id}`}
                className="flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground"
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
