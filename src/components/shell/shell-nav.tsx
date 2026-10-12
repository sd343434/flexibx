"use client";

import {
  Bot,
  CalendarDays,
  Coins,
  MessagesSquare,
  FileText,
  History,
  House,
  Images,
  Megaphone,
  Palette,
  PlugZap,
  Sparkles,
  Target,
  Users,
} from "lucide-react";

import { Link, usePathname } from "@/i18n/navigation";

export interface ShellNavItem {
  readonly id:
    | "home"
    | "content"
    | "ai"
    | "autopilot"
    | "ads"
    | "integrations"
    | "social"
    | "billing"
    | "calendar"
    | "campaigns"
    | "brand"
    | "media"
    | "activity"
    | "members";
  readonly href: string;
  readonly label: string;
}

const ICONS = {
  home: House,
  content: FileText,
  ai: Sparkles,
  autopilot: Bot,
  ads: Target,
  integrations: PlugZap,
  social: MessagesSquare,
  billing: Coins,
  calendar: CalendarDays,
  campaigns: Megaphone,
  brand: Palette,
  media: Images,
  activity: History,
  members: Users,
} as const;

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
    <nav
      aria-label={label}
      className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:min-h-0 lg:overflow-x-hidden lg:overflow-y-auto lg:p-1"
    >
      <ul className="flex gap-1 lg:flex-col">
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
                className="flex min-h-11 items-center gap-3 rounded-xl px-3.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-accent-foreground aria-[current=page]:bg-primary aria-[current=page]:font-semibold aria-[current=page]:text-primary-foreground lg:text-[0.95rem]"
              >
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
