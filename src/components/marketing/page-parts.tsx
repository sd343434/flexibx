import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Presentational building blocks shared by the Marketing Core pages (server-safe: no
// hooks). Text arrives already translated.

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <h1 className="text-3xl font-bold" data-testid="page-title">
          {title}
        </h1>
        {description === undefined ? null : <p className="text-muted-foreground">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

/** Shown instead of a section the role may not open. */
export function ForbiddenNotice({
  title,
  message,
}: {
  readonly title: string;
  readonly message: string;
}) {
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-bold">{title}</h1>
      <p className="text-muted-foreground" data-testid="section-forbidden">
        {message}
      </p>
    </section>
  );
}

export function Notice({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <p
      className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

export function EmptyState({
  message,
  action,
  testId = "empty-state",
}: {
  readonly message: string;
  readonly action?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center"
      data-testid={testId}
    >
      <p className="text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

export function Card({
  title,
  children,
  actions,
  className,
  testId,
}: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <section
      className={cn("space-y-4 rounded-lg border bg-card p-4 sm:p-6", className)}
      data-testid={testId}
    >
      {title === undefined && actions === undefined ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title === undefined ? <span /> : <h2 className="text-lg font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export interface Tab {
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
}

/** Secondary navigation inside a section (e.g. Brand → Profile / Audiences / Pillars). */
export function SectionTabs({
  label,
  tabs,
}: {
  readonly label: string;
  readonly tabs: readonly Tab[];
}) {
  return (
    <nav aria-label={label} className="overflow-x-auto">
      <ul className="flex gap-1 rounded-lg bg-muted p-1">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className="block rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-sm"
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const BADGE_TONES = {
  muted: "border-transparent bg-muted text-muted-foreground",
  accent: "border-transparent bg-accent text-accent-foreground",
  outline: "border-primary/40 text-primary",
  soft: "border-transparent bg-primary/10 text-primary",
  solid: "border-transparent bg-primary text-primary-foreground",
  danger: "border-destructive/40 text-destructive",
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  children,
  tone = "muted",
  testId,
}: {
  readonly children: ReactNode;
  readonly tone?: BadgeTone | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        BADGE_TONES[tone],
      )}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

export const CONTENT_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  DRAFT: "muted",
  IN_REVIEW: "accent",
  APPROVED: "outline",
  SCHEDULED: "soft",
  PUBLISHED: "solid",
};

export const CAMPAIGN_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  DRAFT: "muted",
  PLANNED: "outline",
  ACTIVE: "solid",
  PAUSED: "accent",
  COMPLETED: "soft",
  ARCHIVED: "muted",
};

/** A labelled value in a definition list. */
export function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words whitespace-pre-line">{children}</dd>
    </div>
  );
}
