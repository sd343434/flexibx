import type { BrandLanguage, ContentType, MarketingGoalType } from "@/generated/prisma/enums";

import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";

import type { AiLanguage } from "./provider";

// The workspace context an AI request may see (Phase 4 context contract). Loading is
// workspace-scoped and the caller has already been authorized; rendering is pure and
// deterministic: the same records always produce the same text.
//
// Included: brand profile fields, up to five audiences, five active pillars and five
// active goals (names and short descriptions), the one relevant campaign and, for
// assistance, the target draft. Never included: ids, emails, people, sessions, secrets
// or raw rows. Pillars and the campaign carry short handles (P1…, C1) that the model may
// cite; the handle → id map stays on the server.

export const CONTEXT_LIMITS = {
  audiences: 5,
  pillars: 5,
  goals: 5,
  /** Characters per short field (names, labels). */
  short: 120,
  /** Characters per descriptive field. */
  long: 400,
  /** Characters of a draft's body. */
  body: 2000,
  /** Keywords / forbidden words / hashtags listed. */
  listItems: 20,
  /** Hard cap on the rendered context. */
  total: 8000,
} as const;

export interface ContextBrand {
  readonly name: string;
  readonly industry: string | null;
  readonly market: string | null;
  readonly language: BrandLanguage;
  readonly mission: string | null;
  readonly positioning: string | null;
  readonly valueProposition: string | null;
  readonly toneOfVoice: string | null;
  readonly personality: string | null;
  readonly keywords: readonly string[];
  readonly forbiddenWords: readonly string[];
  readonly ctaStyle: string | null;
}

export interface ContextData {
  readonly brand: ContextBrand | null;
  readonly audiences: readonly { readonly name: string; readonly description: string | null }[];
  readonly pillars: readonly {
    readonly handle: string;
    readonly name: string;
    readonly description: string | null;
  }[];
  readonly goals: readonly {
    readonly title: string;
    readonly type: MarketingGoalType;
    readonly kpi: string | null;
  }[];
  readonly campaign: {
    readonly handle: string;
    readonly name: string;
    readonly objective: string | null;
  } | null;
  readonly content: {
    readonly title: string;
    readonly type: ContentType;
    readonly body: string;
    readonly callToAction: string | null;
    readonly hashtags: readonly string[];
  } | null;
}

export interface LoadedContext {
  readonly data: ContextData;
  /** Handle → record id, kept server-side. */
  readonly references: Readonly<Record<string, string>>;
}

export interface ContextFocus {
  /** A campaign the person chose (already resolved inside the workspace). */
  readonly campaignId?: string | null;
  /** A pillar the person chose; listed first. */
  readonly pillarId?: string | null;
  readonly content?: ContextData["content"];
}

export async function loadContext(
  db: Db,
  ctx: TenantContext,
  focus: ContextFocus = {},
): Promise<LoadedContext> {
  const workspaceId = ctx.workspaceId;
  const [brand, audiences, pillars, goals, campaign] = await Promise.all([
    db.brand.findFirst({
      where: { workspaceId },
      select: {
        name: true,
        industry: true,
        market: true,
        language: true,
        mission: true,
        positioning: true,
        valueProposition: true,
        toneOfVoice: true,
        personality: true,
        keywords: true,
        forbiddenWords: true,
        ctaStyle: true,
      },
    }),
    db.audience.findMany({
      where: { workspaceId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: CONTEXT_LIMITS.audiences,
      select: { name: true, description: true },
    }),
    db.contentPillar.findMany({
      where: { workspaceId, status: "ACTIVE" },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: 50,
      select: { id: true, name: true, description: true, objective: true },
    }),
    db.marketingGoal.findMany({
      where: { workspaceId, status: "ACTIVE" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CONTEXT_LIMITS.goals,
      select: { title: true, type: true, kpi: true },
    }),
    focus.campaignId === undefined || focus.campaignId === null
      ? Promise.resolve(null)
      : db.campaign.findFirst({
          where: { workspaceId, id: focus.campaignId },
          select: { id: true, name: true, objective: true, description: true },
        }),
  ]);

  // A chosen pillar goes first; the rest keep their configured order.
  const ordered =
    focus.pillarId === undefined || focus.pillarId === null
      ? pillars
      : [
          ...pillars.filter((pillar) => pillar.id === focus.pillarId),
          ...pillars.filter((pillar) => pillar.id !== focus.pillarId),
        ];
  const references: Record<string, string> = {};
  const pillarRows = ordered.slice(0, CONTEXT_LIMITS.pillars).map((pillar, index) => {
    const handle = `P${String(index + 1)}`;
    references[handle] = pillar.id;
    return { handle, name: pillar.name, description: pillar.objective ?? pillar.description };
  });
  if (campaign !== null) references.C1 = campaign.id;

  return {
    data: {
      brand,
      audiences,
      pillars: pillarRows,
      goals,
      campaign:
        campaign === null
          ? null
          : {
              handle: "C1",
              name: campaign.name,
              objective: campaign.objective ?? campaign.description,
            },
      content: focus.content ?? null,
    },
    references,
  };
}

/** Single-line, length-bounded text (deterministic truncation with an ellipsis). */
export function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (line === "") return null;
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function clipBlock(value: string, max: number): string {
  const block = value.replace(/\r\n?/g, "\n").trim();
  return block.length <= max ? block : `${block.slice(0, max - 1).trimEnd()}…`;
}

function list(values: readonly string[]): string | null {
  const items = values
    .map((value) => clip(value, CONTEXT_LIMITS.short))
    .filter((value): value is string => value !== null)
    .slice(0, CONTEXT_LIMITS.listItems);
  return items.length === 0 ? null : items.join(", ");
}

const LABELS = {
  ar: {
    brand: "العلامة التجارية",
    noBrand: "لا يوجد ملف علامة تجارية بعد. لا تخترع حقائق عن العلامة.",
    name: "الاسم",
    industry: "القطاع",
    market: "السوق",
    language: "لغة المحتوى",
    mission: "الرسالة",
    positioning: "التموضع",
    valueProposition: "القيمة المقدمة",
    tone: "نبرة الصوت",
    personality: "الشخصية",
    keywords: "كلمات مفتاحية",
    forbidden: "كلمات ممنوعة",
    ctaStyle: "أسلوب الدعوة لاتخاذ إجراء",
    audiences: "الجماهير",
    pillars: "ركائز المحتوى",
    goals: "الأهداف النشطة",
    campaign: "الحملة",
    content: "المسودة الحالية",
    title: "العنوان",
    type: "النوع",
    body: "النص",
    cta: "الدعوة لاتخاذ إجراء",
    hashtags: "الوسوم",
    none: "لا يوجد",
  },
  en: {
    brand: "Brand",
    noBrand: "No brand profile yet. Do not invent facts about the brand.",
    name: "Name",
    industry: "Industry",
    market: "Market",
    language: "Content language",
    mission: "Mission",
    positioning: "Positioning",
    valueProposition: "Value proposition",
    tone: "Tone of voice",
    personality: "Personality",
    keywords: "Keywords",
    forbidden: "Forbidden words",
    ctaStyle: "Call-to-action style",
    audiences: "Audiences",
    pillars: "Content pillars",
    goals: "Active goals",
    campaign: "Campaign",
    content: "Current draft",
    title: "Title",
    type: "Type",
    body: "Body",
    cta: "Call to action",
    hashtags: "Hashtags",
    none: "none",
  },
} as const;

/**
 * Renders the context as labelled lines, highest priority first (brand, draft, campaign,
 * pillars, audiences, goals). Lines that would exceed the total budget are left out.
 */
export function renderContext(data: ContextData, language: AiLanguage): string {
  const l = LABELS[language];
  const lines: string[] = [];
  const field = (label: string, value: string | null) => {
    if (value !== null) lines.push(`- ${label}: ${value}`);
  };

  lines.push(`## ${l.brand}`);
  if (data.brand === null) {
    lines.push(l.noBrand);
  } else {
    const b = data.brand;
    field(l.name, clip(b.name, CONTEXT_LIMITS.short));
    field(l.industry, clip(b.industry, CONTEXT_LIMITS.short));
    field(l.market, clip(b.market, CONTEXT_LIMITS.short));
    field(l.language, b.language);
    field(l.mission, clip(b.mission, CONTEXT_LIMITS.long));
    field(l.positioning, clip(b.positioning, CONTEXT_LIMITS.long));
    field(l.valueProposition, clip(b.valueProposition, CONTEXT_LIMITS.long));
    field(l.tone, clip(b.toneOfVoice, CONTEXT_LIMITS.long));
    field(l.personality, clip(b.personality, CONTEXT_LIMITS.long));
    field(l.keywords, list(b.keywords));
    field(l.forbidden, list(b.forbiddenWords));
    field(l.ctaStyle, clip(b.ctaStyle, CONTEXT_LIMITS.long));
  }

  if (data.content !== null) {
    const c = data.content;
    lines.push(`## ${l.content}`);
    field(l.title, clip(c.title, CONTEXT_LIMITS.short * 2));
    field(l.type, c.type);
    field(l.cta, clip(c.callToAction, CONTEXT_LIMITS.short * 2));
    field(l.hashtags, list(c.hashtags));
    if (c.body.trim() !== "") {
      lines.push(`- ${l.body}:`, clipBlock(c.body, CONTEXT_LIMITS.body));
    }
  }

  if (data.campaign !== null) {
    lines.push(`## ${l.campaign}`);
    lines.push(
      `- [${data.campaign.handle}] ${clip(data.campaign.name, CONTEXT_LIMITS.short) ?? ""}` +
        (data.campaign.objective === null
          ? ""
          : ` — ${clip(data.campaign.objective, CONTEXT_LIMITS.long) ?? ""}`),
    );
  }

  lines.push(`## ${l.pillars}`);
  if (data.pillars.length === 0) lines.push(`- ${l.none}`);
  for (const pillar of data.pillars) {
    const description = clip(pillar.description, CONTEXT_LIMITS.long);
    lines.push(
      `- [${pillar.handle}] ${clip(pillar.name, CONTEXT_LIMITS.short) ?? ""}` +
        (description === null ? "" : ` — ${description}`),
    );
  }

  lines.push(`## ${l.audiences}`);
  if (data.audiences.length === 0) lines.push(`- ${l.none}`);
  for (const audience of data.audiences) {
    const description = clip(audience.description, CONTEXT_LIMITS.long);
    lines.push(
      `- ${clip(audience.name, CONTEXT_LIMITS.short) ?? ""}` +
        (description === null ? "" : ` — ${description}`),
    );
  }

  lines.push(`## ${l.goals}`);
  if (data.goals.length === 0) lines.push(`- ${l.none}`);
  for (const goal of data.goals) {
    const kpi = clip(goal.kpi, CONTEXT_LIMITS.short);
    lines.push(
      `- ${clip(goal.title, CONTEXT_LIMITS.short) ?? ""} (${goal.type}${kpi === null ? "" : `, ${kpi}`})`,
    );
  }

  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (total + line.length + 1 > CONTEXT_LIMITS.total) break;
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join("\n");
}
