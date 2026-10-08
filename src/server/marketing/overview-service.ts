import type { CampaignStatus, ContentStatus } from "@/generated/prisma/enums";

import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";
import { assertCan, can } from "../tenancy/permissions";

import { workspaceTimeZone } from "./common";
import type { CalendarView } from "./inputs";
import { calendarPeriod, isDateKey, zonedDateKey, type CalendarPeriod } from "./time";
import { reschedulePermission } from "./workflow";

// Read models for the calendar, the marketing dashboard and the activity history. Each
// section is included only when the role may see it; nothing is filtered in the UI.

export const CONTENT_STATUSES: readonly ContentStatus[] = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHED",
];

/** At most this many items are placed on one calendar period (a week has 7 days). */
export const MAX_CALENDAR_ITEMS = 300;

export interface CalendarItem {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly status: ContentStatus;
  /** When it is planned/scheduled or went out (publishedAt for published content). */
  readonly at: Date;
  readonly dateKey: string;
  readonly campaign: string | null;
  readonly canReschedule: boolean;
}

export interface CalendarData {
  readonly timeZone: string;
  readonly view: CalendarView;
  readonly date: string;
  readonly today: string;
  readonly period: CalendarPeriod;
  readonly items: readonly CalendarItem[];
  readonly truncated: boolean;
}

export async function getCalendar(
  db: Db,
  ctx: TenantContext,
  query: { readonly view: CalendarView; readonly date?: string | undefined },
  now: Date = new Date(),
): Promise<CalendarData> {
  assertCan(ctx, "content.view");
  const timeZone = await workspaceTimeZone(db, ctx);
  const today = zonedDateKey(now, timeZone);
  const date = query.date !== undefined && isDateKey(query.date) ? query.date : today;
  const period = calendarPeriod(query.view, date, timeZone);
  const range = { gte: period.start, lt: period.end };

  const rows = await db.contentItem.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      OR: [
        { status: { not: "PUBLISHED" }, scheduledAt: range },
        { status: "PUBLISHED", publishedAt: range },
      ],
    },
    orderBy: [{ scheduledAt: "asc" }, { publishedAt: "asc" }, { id: "asc" }],
    take: MAX_CALENDAR_ITEMS + 1,
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      scheduledAt: true,
      publishedAt: true,
      campaign: { select: { name: true } },
    },
  });

  const items = rows.slice(0, MAX_CALENDAR_ITEMS).flatMap((row): CalendarItem[] => {
    const at = row.status === "PUBLISHED" ? row.publishedAt : row.scheduledAt;
    if (at === null) return [];
    const permission = reschedulePermission(row.status);
    return [
      {
        id: row.id,
        title: row.title,
        type: row.type,
        status: row.status,
        at,
        dateKey: zonedDateKey(at, timeZone),
        campaign: row.campaign?.name ?? null,
        canReschedule: permission !== null && can(ctx.role, permission),
      },
    ];
  });
  items.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    timeZone,
    view: query.view,
    date,
    today,
    period,
    items,
    truncated: rows.length > MAX_CALENDAR_ITEMS,
  };
}

export interface DashboardData {
  readonly timeZone: string;
  readonly setup: {
    readonly brand: boolean;
    readonly audiences: number;
    readonly pillars: number;
    readonly goals: number;
    readonly campaigns: number;
    readonly content: number;
  };
  readonly brand: { readonly name: string } | null;
  readonly content: {
    readonly byStatus: Readonly<Record<ContentStatus, number>>;
    readonly upcoming: readonly {
      id: string;
      title: string;
      status: ContentStatus;
      scheduledAt: Date;
    }[];
    readonly recent: readonly {
      id: string;
      title: string;
      status: ContentStatus;
      updatedAt: Date;
    }[];
  } | null;
  readonly campaigns: {
    readonly active: number;
    readonly list: readonly {
      id: string;
      name: string;
      status: CampaignStatus;
      startDate: Date | null;
      endDate: Date | null;
      content: number;
    }[];
    readonly activeGoals: number;
  } | null;
  readonly activity: readonly ActivityEntry[] | null;
  readonly can: {
    readonly editBrand: boolean;
    readonly createContent: boolean;
    readonly manageCampaigns: boolean;
  };
}

/** Upcoming scheduled content shown on the dashboard: the next 14 days. */
export const DASHBOARD_UPCOMING_DAYS = 14;

export async function getDashboard(
  db: Db,
  ctx: TenantContext,
  now: Date = new Date(),
): Promise<DashboardData> {
  assertCan(ctx, "workspace.view");
  const workspaceId = ctx.workspaceId;
  const canBrand = can(ctx.role, "brand.view");
  const canContent = can(ctx.role, "content.view");
  const canCampaigns = can(ctx.role, "campaign.view");
  const canAudit = can(ctx.role, "audit.view");
  const timeZone = await workspaceTimeZone(db, ctx);

  const [brand, audiences, pillars] = canBrand
    ? await Promise.all([
        db.brand.findFirst({ where: { workspaceId }, select: { name: true } }),
        db.audience.count({ where: { workspaceId } }),
        db.contentPillar.count({ where: { workspaceId, status: "ACTIVE" } }),
      ])
    : [null, 0, 0];

  let content: DashboardData["content"] = null;
  let contentTotal = 0;
  if (canContent) {
    const horizon = new Date(now.getTime() + DASHBOARD_UPCOMING_DAYS * 24 * 60 * 60 * 1000);
    const [groups, upcoming, recent] = await Promise.all([
      db.contentItem.groupBy({ by: ["status"], where: { workspaceId }, _count: { _all: true } }),
      db.contentItem.findMany({
        where: { workspaceId, status: "SCHEDULED", scheduledAt: { gte: now, lt: horizon } },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        take: 5,
        select: { id: true, title: true, status: true, scheduledAt: true },
      }),
      db.contentItem.findMany({
        where: { workspaceId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 5,
        select: { id: true, title: true, status: true, updatedAt: true },
      }),
    ]);
    const byStatus = Object.fromEntries(CONTENT_STATUSES.map((status) => [status, 0])) as Record<
      ContentStatus,
      number
    >;
    for (const group of groups) byStatus[group.status] = group._count._all;
    contentTotal = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
    content = {
      byStatus,
      upcoming: upcoming.flatMap((row) =>
        row.scheduledAt === null ? [] : [{ ...row, scheduledAt: row.scheduledAt }],
      ),
      recent,
    };
  }

  let campaigns: DashboardData["campaigns"] = null;
  let campaignTotal = 0;
  let goalTotal = 0;
  if (canCampaigns) {
    const [active, list, activeGoals, total, goals] = await Promise.all([
      db.campaign.count({ where: { workspaceId, status: "ACTIVE" } }),
      db.campaign.findMany({
        where: { workspaceId, status: { in: ["ACTIVE", "PLANNED"] } },
        orderBy: [{ status: "asc" }, { startDate: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        take: 5,
        select: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
          _count: { select: { contentItems: true } },
        },
      }),
      db.marketingGoal.count({ where: { workspaceId, status: "ACTIVE" } }),
      db.campaign.count({ where: { workspaceId } }),
      db.marketingGoal.count({ where: { workspaceId } }),
    ]);
    campaignTotal = total;
    goalTotal = goals;
    campaigns = {
      active,
      activeGoals,
      list: list.map(({ _count, ...row }) => ({ ...row, content: _count.contentItems })),
    };
  }

  return {
    timeZone,
    setup: {
      brand: brand !== null,
      audiences,
      pillars,
      goals: goalTotal,
      campaigns: campaignTotal,
      content: contentTotal,
    },
    brand,
    content,
    campaigns,
    activity: canAudit
      ? await listActivity(db, ctx, { limit: 8 }).then((page) => page.entries)
      : null,
    can: {
      editBrand: can(ctx.role, "brand.edit"),
      createContent: can(ctx.role, "content.create"),
      manageCampaigns: can(ctx.role, "campaign.manage"),
    },
  };
}

export interface ActivityEntry {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actor: string | null;
  readonly createdAt: Date;
  /** Status change details, when the entry has them (`from`/`to` status names). */
  readonly from: string | null;
  readonly to: string | null;
}

const STATUS_VALUE = /^[A-Z_]{2,20}$/;
const statusValue = (value: unknown) =>
  typeof value === "string" && STATUS_VALUE.test(value) ? value : null;

/**
 * The workspace's audit trail for people with audit.view, newest first. Only the action,
 * entity, actor name, time and status names are exposed — never raw metadata.
 */
export async function listActivity(
  db: Db,
  ctx: TenantContext,
  options: { readonly limit?: number; readonly before?: string | undefined } = {},
): Promise<{ readonly entries: ActivityEntry[]; readonly next: string | null }> {
  assertCan(ctx, "audit.view");
  const take = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const cursor =
    options.before === undefined
      ? null
      : await db.auditLog.findFirst({
          where: { workspaceId: ctx.workspaceId, id: options.before },
          select: { id: true, createdAt: true },
        });
  const rows = await db.auditLog.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      metadata: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });
  const entries = rows.slice(0, take).map((row): ActivityEntry => {
    const metadata =
      typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    return {
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actor: row.actor?.name ?? null,
      createdAt: row.createdAt,
      from: statusValue(metadata.from),
      to: statusValue(metadata.to),
    };
  });
  return { entries, next: rows.length > take ? (entries.at(-1)?.id ?? null) : null };
}
