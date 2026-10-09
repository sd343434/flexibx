import type { CampaignStatus, ContentStatus, ContentType } from "@/generated/prisma/enums";

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
      campaign: string | null;
    }[];
    /** Content waiting for a decision (IN_REVIEW), soonest planned first. */
    readonly review: readonly {
      id: string;
      title: string;
      type: ContentType;
      scheduledAt: Date | null;
      campaign: string | null;
    }[];
    /** Drafts to finish, soonest planned first; `excerpt` is the start of the body. */
    readonly drafts: readonly {
      id: string;
      title: string;
      excerpt: string;
      scheduledAt: Date | null;
      pillar: string | null;
    }[];
    /** The current week (Sunday first) with the number of dated items per day. */
    readonly week: {
      readonly today: string;
      readonly days: readonly { readonly date: string; readonly count: number }[];
    };
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
      published: number;
    }[];
    readonly activeGoals: number;
  } | null;
  readonly activity: readonly ActivityEntry[] | null;
  readonly can: {
    readonly editBrand: boolean;
    readonly createContent: boolean;
    readonly manageCampaigns: boolean;
    readonly approveContent: boolean;
  };
}

/** Dashboard lists show at most this many items each. */
export const DASHBOARD_LIST_LIMIT = 4;
/** Characters of a draft's body shown on its dashboard card. */
export const DASHBOARD_EXCERPT_LENGTH = 140;

/** The start of a body as one line, cut at a word boundary when it is too long. */
export function excerpt(body: string, length = DASHBOARD_EXCERPT_LENGTH): string {
  const line = body.replace(/\s+/g, " ").trim();
  if (line.length <= length) return line;
  const cut = line.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
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
    const week = calendarPeriod("week", zonedDateKey(now, timeZone), timeZone);
    const weekRange = { gte: week.start, lt: week.end };
    const planned = [
      { scheduledAt: { sort: "asc", nulls: "last" } },
      { updatedAt: "desc" },
      { id: "asc" },
    ] as const;
    const [groups, upcoming, review, drafts, dated] = await Promise.all([
      db.contentItem.groupBy({ by: ["status"], where: { workspaceId }, _count: { _all: true } }),
      db.contentItem.findMany({
        where: { workspaceId, status: "SCHEDULED", scheduledAt: { gte: now, lt: horizon } },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        take: DASHBOARD_LIST_LIMIT,
        select: {
          id: true,
          title: true,
          status: true,
          scheduledAt: true,
          campaign: { select: { name: true } },
        },
      }),
      db.contentItem.findMany({
        where: { workspaceId, status: "IN_REVIEW" },
        orderBy: [...planned],
        take: DASHBOARD_LIST_LIMIT,
        select: {
          id: true,
          title: true,
          type: true,
          scheduledAt: true,
          campaign: { select: { name: true } },
        },
      }),
      db.contentItem.findMany({
        where: { workspaceId, status: "DRAFT" },
        orderBy: [...planned],
        take: 2,
        select: {
          id: true,
          title: true,
          body: true,
          scheduledAt: true,
          pillar: { select: { name: true } },
        },
      }),
      db.contentItem.findMany({
        where: {
          workspaceId,
          OR: [
            { status: { not: "PUBLISHED" }, scheduledAt: weekRange },
            { status: "PUBLISHED", publishedAt: weekRange },
          ],
        },
        take: MAX_CALENDAR_ITEMS,
        select: { status: true, scheduledAt: true, publishedAt: true },
      }),
    ]);
    const byStatus = Object.fromEntries(CONTENT_STATUSES.map((status) => [status, 0])) as Record<
      ContentStatus,
      number
    >;
    for (const group of groups) byStatus[group.status] = group._count._all;
    contentTotal = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
    const perDay = new Map<string, number>();
    for (const row of dated) {
      const at = row.status === "PUBLISHED" ? row.publishedAt : row.scheduledAt;
      if (at === null) continue;
      const key = zonedDateKey(at, timeZone);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    content = {
      byStatus,
      upcoming: upcoming.flatMap(({ campaign, ...row }) =>
        row.scheduledAt === null
          ? []
          : [{ ...row, scheduledAt: row.scheduledAt, campaign: campaign?.name ?? null }],
      ),
      review: review.map(({ campaign, ...row }) => ({ ...row, campaign: campaign?.name ?? null })),
      drafts: drafts.map(({ body, pillar, ...row }) => ({
        ...row,
        excerpt: excerpt(body),
        pillar: pillar?.name ?? null,
      })),
      week: {
        today: zonedDateKey(now, timeZone),
        days: week.days.map((date) => ({ date, count: perDay.get(date) ?? 0 })),
      },
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
        take: 3,
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
    const published =
      list.length === 0
        ? []
        : await db.contentItem.groupBy({
            by: ["campaignId"],
            where: {
              workspaceId,
              status: "PUBLISHED",
              campaignId: { in: list.map((row) => row.id) },
            },
            _count: { _all: true },
          });
    const publishedBy = new Map(published.map((row) => [row.campaignId, row._count._all]));
    campaigns = {
      active,
      activeGoals,
      // Active campaigns first (the query orders by status, where PLANNED sorts first).
      list: list
        .map(({ _count, ...row }) => ({
          ...row,
          content: _count.contentItems,
          published: publishedBy.get(row.id) ?? 0,
        }))
        .sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE")),
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
      approveContent: can(ctx.role, "content.approve"),
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
