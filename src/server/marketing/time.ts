// Workspace time-zone arithmetic for scheduling and the calendar. Pure (no
// `server-only`). Times are stored as UTC instants; people enter and read them as
// wall-clock times in the workspace's IANA time zone (default Asia/Riyadh).

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_TIME_ZONE = "Asia/Riyadh";

/** True if `zone` is an IANA time zone this runtime knows. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A usable time zone: the workspace's own, or the default when it is unknown. */
export function resolveTimeZone(zone: string | null | undefined): string {
  return zone !== null && zone !== undefined && isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let existing = formatters.get(zone);
  if (existing === undefined) {
    existing = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, existing);
  }
  return existing;
}

/** The wall-clock reading of `instant` in `zone`. */
export function wallClock(instant: Date, zone: string): WallClock & { readonly second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Milliseconds `zone` is ahead of UTC at `instant`. */
function offsetAt(instant: Date, zone: string): number {
  const clock = wallClock(instant, zone);
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocal(value: string): WallClock | null {
  const match = LOCAL_PATTERN.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

/**
 * The UTC instant of a wall-clock time (`YYYY-MM-DDTHH:mm`) in `zone`, or null when the
 * text is not a real date and time. A time skipped by a daylight-saving jump resolves to
 * the instant after the jump.
 */
export function zonedLocalToUtc(value: string, zone: string): Date | null {
  const local = parseLocal(value);
  if (local === null) return null;
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const first = naive - offsetAt(new Date(naive), zone);
  const second = naive - offsetAt(new Date(first), zone);
  // `second` is exact unless the time falls in a daylight-saving gap (it then reads an
  // hour early); `first` is then the same wall-clock distance after the jump.
  return new Date(utcToZonedLocal(new Date(second), zone) === value ? second : first);
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** `instant` as a datetime-local value (`YYYY-MM-DDTHH:mm`) in `zone`. */
export function utcToZonedLocal(instant: Date, zone: string): string {
  const c = wallClock(instant, zone);
  return `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}

/** The calendar day (`YYYY-MM-DD`) of `instant` in `zone`. */
export function zonedDateKey(instant: Date, zone: string): string {
  return utcToZonedLocal(instant, zone).slice(0, 10);
}

/** Whether `value` is a real `YYYY-MM-DD` date. */
export function isDateKey(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  return parseLocal(`${value}T00:00`) !== null;
}

/** `dateKey` moved by `days` (calendar arithmetic, independent of time zones). */
export function addDays(dateKey: string, days: number): string {
  const base = new Date(`${dateKey}T00:00:00Z`).getTime() + days * DAY_MS;
  return new Date(base).toISOString().slice(0, 10);
}

/** Day of week of a date key: 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** Weeks start on Sunday (the working week in the default market). */
export const WEEK_START_DAY = 0;

export interface CalendarPeriod {
  /** Days shown, in order (`YYYY-MM-DD`). */
  readonly days: readonly string[];
  /** First instant of the first day in the workspace time zone. */
  readonly start: Date;
  /** First instant after the last day (exclusive). */
  readonly end: Date;
  readonly previous: string;
  readonly next: string;
}

/** The day or week (Sunday-first) containing `dateKey`, as UTC bounds for `zone`. */
export function calendarPeriod(
  view: "day" | "week",
  dateKey: string,
  zone: string,
): CalendarPeriod {
  const first =
    view === "day" ? dateKey : addDays(dateKey, -((dayOfWeek(dateKey) - WEEK_START_DAY + 7) % 7));
  const length = view === "day" ? 1 : 7;
  const days = Array.from({ length }, (_, index) => addDays(first, index));
  const after = addDays(first, length);
  const start = zonedLocalToUtc(`${first}T00:00`, zone);
  const end = zonedLocalToUtc(`${after}T00:00`, zone);
  if (start === null || end === null) throw new Error("Invalid calendar date");
  return {
    days,
    start,
    end,
    previous: addDays(first, -length),
    next: after,
  };
}
