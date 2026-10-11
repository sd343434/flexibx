import { currencyDigits, majorToMinor, type AccountSnapshot, type Money } from "./model";

// Deterministic planning arithmetic (pure). Budgets, durations and any expected result
// are computed here from a person's input and the account's own history — never by a
// model. An estimate is offered only when the history is large enough to be defensible,
// and always as a range with its basis stated.

/** History needed before results are estimated. */
export const MIN_HISTORY_IMPRESSIONS = 5_000;
/** Width of the estimate band around the historical rate. */
export const ESTIMATE_SPREAD = 0.3;
export const MAX_PLAN_DAYS = 90;

export interface AccountHistory {
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: Money;
  readonly days: number;
}

export function accountHistory(
  snapshot: AccountSnapshot | null,
  currency: string,
): AccountHistory | null {
  if (snapshot === null) return null;
  let impressions = 0;
  let clicks = 0;
  let spend = 0;
  for (const metric of snapshot.metrics) {
    if (metric.spend.currency !== currency) return null;
    impressions += metric.impressions;
    clicks += metric.clicks;
    spend += metric.spend.minor;
  }
  return { impressions, clicks, spend: { minor: spend, currency }, days: snapshot.range.days };
}

export interface Range {
  readonly low: number;
  readonly high: number;
}

export type ExpectedResults =
  | {
      readonly available: true;
      readonly impressions: Range;
      readonly clicks: Range;
      /** Historical cost per 1,000 impressions and click-through rate (the basis). */
      readonly basis: { readonly cpm: Money; readonly ctrPercent: number; readonly days: number };
    }
  | { readonly available: false; readonly reason: "no_history" | "insufficient_history" };

const band = (value: number): Range => ({
  low: Math.floor(value * (1 - ESTIMATE_SPREAD)),
  high: Math.ceil(value * (1 + ESTIMATE_SPREAD)),
});

/** Impressions and clicks a budget might buy at this account's own recent rates. */
export function expectedResults(
  history: AccountHistory | null,
  budgetMinor: number,
): ExpectedResults {
  if (history === null || history.impressions === 0) {
    return { available: false, reason: "no_history" };
  }
  if (history.impressions < MIN_HISTORY_IMPRESSIONS || history.spend.minor <= 0) {
    return { available: false, reason: "insufficient_history" };
  }
  const cpmMinor = (history.spend.minor * 1000) / history.impressions;
  const impressions = (budgetMinor * 1000) / cpmMinor;
  const ctr = history.clicks / history.impressions;
  return {
    available: true,
    impressions: band(impressions),
    clicks: band(impressions * ctr),
    basis: {
      cpm: { minor: Math.round(cpmMinor), currency: history.spend.currency },
      ctrPercent: Math.round(ctr * 10_000) / 100,
      days: history.days,
    },
  };
}

/** A person's budget text ("1500", "1,500.50") → minor units, or null when invalid. */
export function parseBudget(text: string, currency: string): number | null {
  const normalized = text.trim().replaceAll(",", "").replaceAll("٬", "").replace("٫", ".");
  const ascii = normalized.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
  const minor = majorToMinor(ascii, currency);
  return minor === null || minor <= 0 ? null : minor;
}

/** Minor units → plain major-unit text for prompts and forms ("1500.00"). */
export function formatMajor(money: Money): string {
  const digits = currencyDigits(money.currency);
  if (digits === 0) return String(money.minor);
  const text = String(money.minor).padStart(digits + 1, "0");
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** The advertising data block shown to the model (no ids, no tokens, no people). */
export function renderAdData(input: {
  readonly language: "ar" | "en";
  readonly accountName: string;
  readonly platform: string;
  /** The placements this platform supports (the model must choose among them). */
  readonly placements?: readonly string[];
  /** The only objectives that can launch here, when restricted. */
  readonly objectives?: readonly string[];
  /** The connected WhatsApp Business account's name, when conversations can go there. */
  readonly whatsapp?: string | null;
  readonly budget: Money;
  readonly days: number;
  readonly history: AccountHistory | null;
  readonly topCampaigns: readonly { readonly name: string; readonly objective: string | null }[];
  readonly assets: readonly { readonly handle: string; readonly label: string }[];
}): string {
  const ar = input.language === "ar";
  const lines = [
    `${ar ? "المنصة" : "Platform"}: ${input.platform}`,
    `${ar ? "الحساب الإعلاني" : "Ad account"}: ${input.accountName.slice(0, 120)}`,
    ...(input.placements === undefined
      ? []
      : [
          `${ar ? "مواضع الظهور المتاحة على هذه المنصة" : "Placements available on this platform"}: ${input.placements.join(", ")}`,
        ]),
    ...(input.objectives === undefined
      ? []
      : [
          `${ar ? "الأهداف المسموح بها فقط (لا تختر غيرها)" : "Allowed objectives only (choose no other)"}: ${input.objectives.join(", ")}`,
        ]),
    `${ar ? "الميزانية الإجمالية (يحددها الإنسان)" : "Total budget (set by the person)"}: ${formatMajor(input.budget)} ${input.budget.currency}`,
    `${ar ? "المدة بالأيام" : "Duration in days"}: ${String(input.days)}`,
  ];
  if (input.whatsapp !== undefined && input.whatsapp !== null) {
    lines.push(
      ar
        ? `واتساب للأعمال مربوط (${input.whatsapp.slice(0, 120)}): لبدء محادثات واتساب اختر الهدف MESSAGES ودعوة الإجراء SEND_MESSAGE. لا ترسل رسائل ولا تعد بردود.`
        : `WhatsApp Business is connected (${input.whatsapp.slice(0, 120)}): to start WhatsApp conversations choose objective MESSAGES and call to action SEND_MESSAGE. Never send messages or promise replies.`,
    );
  }
  if (input.history === null) {
    lines.push(ar ? "لا توجد نتائج سابقة متاحة." : "No past results are available.");
  } else {
    lines.push(
      `${ar ? "نتائج آخر" : "Results, last"} ${String(input.history.days)} ${ar ? "يوماً" : "days"}: ${String(input.history.impressions)} ${ar ? "ظهور" : "impressions"}, ${String(input.history.clicks)} ${ar ? "نقرة" : "clicks"}, ${formatMajor(input.history.spend)} ${input.history.spend.currency}`,
    );
  }
  if (input.topCampaigns.length > 0) {
    lines.push(ar ? "حملات حالية:" : "Existing campaigns:");
    for (const campaign of input.topCampaigns.slice(0, 5)) {
      lines.push(`- ${campaign.name.slice(0, 120)} (${campaign.objective ?? "—"})`);
    }
  }
  lines.push(ar ? "الصور المتاحة:" : "Available images:");
  if (input.assets.length === 0) lines.push(ar ? "لا توجد صور." : "No images.");
  for (const asset of input.assets) lines.push(`[${asset.handle}] ${asset.label.slice(0, 160)}`);
  return lines.join("\n");
}
