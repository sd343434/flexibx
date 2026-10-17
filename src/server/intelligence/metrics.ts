import { createHash } from "node:crypto";

import { z } from "zod";

import { MarketingChannel, PerformanceMetric } from "@/generated/prisma/enums";

// Performance metrics (Pass 5). Pure (no `server-only`): definitions, units, and the
// validation of rows before anything is stored. A row is rejected — never "fixed" — when
// it is malformed: unknown metric, negative or fractional count, money without a valid
// currency (or a count with one), an impossible or future date, a period longer than
// MAX_PERIOD_DAYS. Values are whole numbers: counts, or money in minor units.

export const PERFORMANCE_METRICS = Object.values(PerformanceMetric);

/** Money metrics carry a currency; every other metric is a count. */
export const MONEY_METRICS: ReadonlySet<PerformanceMetric> = new Set(["REVENUE", "SPEND"]);

export function isMoneyMetric(metric: PerformanceMetric): boolean {
  return MONEY_METRICS.has(metric);
}

/** Metrics a goal's target can be compared with (counts only). */
export const TARGET_METRICS = PERFORMANCE_METRICS.filter((metric) => !isMoneyMetric(metric));

/** Longest period one observation may cover (also a database CHECK). */
export const MAX_PERIOD_DAYS = 92;
/** Most rows in one import, and the largest import text accepted (bytes). */
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 200_000;
/** Largest count accepted (a sanity bound, far above any real campaign). */
export const MAX_COUNT = 1_000_000_000_000n;
/** Largest money value accepted, in minor units. */
export const MAX_MONEY_MINOR = 100_000_000_000_00n;

const DAY_MS = 24 * 3_600_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type RowIssue =
  | "columns"
  | "date_invalid"
  | "period_order"
  | "period_too_long"
  | "period_future"
  | "metric_unknown"
  | "value_invalid"
  | "value_negative"
  | "value_fraction"
  | "value_too_big"
  | "currency_missing"
  | "currency_invalid"
  | "currency_unexpected"
  | "content_invalid"
  | "content_not_in_campaign"
  | "duplicate_in_batch"
  | "conflict";

/** One observation, validated, ready to store (dates are UTC midnights). */
export interface ObservationRow {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly metric: PerformanceMetric;
  readonly value: bigint;
  readonly currency: string | null;
  readonly contentItemId: string | null;
}

function parseDay(value: string): Date | null {
  if (!DATE_PATTERN.test(value)) return null;
  const day = new Date(`${value}T00:00:00Z`);
  return day.toISOString().startsWith(value) ? day : null;
}

const UUID = z.uuid();

/**
 * Validates one row (all text, as read from CSV or a provider). `today` is the last day a
 * period may end on (no observation of the future).
 */
export function validateRow(
  raw: {
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly metric: string;
    readonly value: string;
    readonly currency: string;
    readonly contentItemId: string;
  },
  today: Date,
): { ok: true; row: ObservationRow } | { ok: false; issue: RowIssue } {
  const periodStart = parseDay(raw.periodStart.trim());
  const periodEnd = parseDay(raw.periodEnd.trim());
  if (periodStart === null || periodEnd === null) return { ok: false, issue: "date_invalid" };
  if (periodEnd < periodStart) return { ok: false, issue: "period_order" };
  if ((periodEnd.getTime() - periodStart.getTime()) / DAY_MS > MAX_PERIOD_DAYS) {
    return { ok: false, issue: "period_too_long" };
  }
  if (periodEnd.getTime() > today.getTime()) return { ok: false, issue: "period_future" };

  const metric = raw.metric.trim().toUpperCase();
  if (!(PERFORMANCE_METRICS as readonly string[]).includes(metric)) {
    return { ok: false, issue: "metric_unknown" };
  }
  const typed = metric as PerformanceMetric;
  const money = isMoneyMetric(typed);

  const text = raw.value.trim();
  if (text.startsWith("-")) return { ok: false, issue: "value_negative" };
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    return { ok: false, issue: /^\d+\.\d+$/.test(text) ? "value_fraction" : "value_invalid" };
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = match[2] ?? "";
  if (!money && fraction !== "" && /[1-9]/.test(fraction)) {
    return { ok: false, issue: "value_fraction" };
  }
  const value = money ? whole * 100n + BigInt(fraction.padEnd(2, "0")) : whole;
  if (value > (money ? MAX_MONEY_MINOR : MAX_COUNT)) return { ok: false, issue: "value_too_big" };

  const currency = raw.currency.trim().toUpperCase();
  if (money && currency === "") return { ok: false, issue: "currency_missing" };
  if (money && !CURRENCY_PATTERN.test(currency)) return { ok: false, issue: "currency_invalid" };
  if (!money && currency !== "") return { ok: false, issue: "currency_unexpected" };

  const content = raw.contentItemId.trim();
  if (content !== "" && !UUID.safeParse(content).success) {
    return { ok: false, issue: "content_invalid" };
  }
  return {
    ok: true,
    row: {
      periodStart,
      periodEnd,
      metric: typed,
      value,
      currency: money ? currency : null,
      contentItemId: content === "" ? null : content.toLowerCase(),
    },
  };
}

/** The CSV columns of a manual import, in this order (a header line is required). */
export const CSV_COLUMNS = [
  "period_start",
  "period_end",
  "metric",
  "value",
  "currency",
  "content_id",
] as const;

export interface ParsedCsv {
  readonly rows: readonly { readonly line: number; readonly fields: readonly string[] }[];
  /** Null when the header is right. */
  readonly headerIssue: "header_missing" | "too_many_rows" | "too_large" | null;
}

/**
 * Splits a simple CSV (comma-separated, no quoted commas — metric exports from the
 * platforms people copy from are plain). Empty lines are ignored.
 */
export function parseCsv(text: string): ParsedCsv {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES)
    return { rows: [], headerIssue: "too_large" };
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((entry) => entry.text !== "");
  const header = lines[0]?.text
    .split(",")
    .map((cell) => cell.trim().toLowerCase())
    .join(",");
  if (header !== CSV_COLUMNS.join(",")) return { rows: [], headerIssue: "header_missing" };
  const body = lines.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { rows: [], headerIssue: "too_many_rows" };
  return {
    rows: body.map((entry) => ({ line: entry.line, fields: entry.text.split(",") })),
    headerIssue: null,
  };
}

/**
 * The identity of a person-entered observation: the same campaign, content, channel,
 * metric and period always give the same reference, so importing it again is recognized
 * (as a duplicate when the value is the same, a conflict when it differs).
 */
export function manualSourceRef(
  campaignId: string,
  channel: MarketingChannel,
  row: Pick<ObservationRow, "contentItemId" | "metric" | "periodStart" | "periodEnd">,
): string {
  const key = [
    campaignId,
    row.contentItemId ?? "-",
    channel,
    row.metric,
    row.periodStart.toISOString().slice(0, 10),
    row.periodEnd.toISOString().slice(0, 10),
  ].join("|");
  return `manual:${createHash("sha256").update(key).digest("hex")}`;
}

export const MARKETING_CHANNELS_FOR_METRICS = Object.values(MarketingChannel);
