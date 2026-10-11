import type { AiOperation, ContentType } from "@/generated/prisma/enums";

import { contentFieldsSchema, type ContentFields } from "../marketing/inputs";

import type {
  AnyAiOutput,
  AssistOperation,
  BriefOutput,
  CopyOutput,
  IdeasOutput,
} from "./operations";
import type { AiLanguage } from "./provider";

// Turning a stored, validated suggestion into content fields (pure). The result always
// passes through the content input schema, so it obeys exactly the limits a person's own
// input would. Resolved ids come from the server (reference map + workspace lookup),
// never from the model.

const MAX_BODY = 10_000;
const MAX_NOTES = 4000;

const BRIEF_LABELS = {
  ar: {
    heading: "موجز من اقتراح الذكاء الاصطناعي",
    objective: "الهدف",
    audience: "الجمهور",
    keyMessage: "الرسالة الأساسية",
    angle: "الزاوية",
    hook: "الافتتاحية",
    cta: "الدعوة لاتخاذ إجراء",
    tone: "النبرة",
    points: "نقاط داعمة",
    structure: "البنية المقترحة",
    idea: "فكرة من اقتراح الذكاء الاصطناعي",
    rationale: "السبب",
  },
  en: {
    heading: "Brief from an AI suggestion",
    objective: "Objective",
    audience: "Audience",
    keyMessage: "Key message",
    angle: "Angle",
    hook: "Hook",
    cta: "Call to action",
    tone: "Tone",
    points: "Supporting points",
    structure: "Suggested structure",
    idea: "Idea from an AI suggestion",
    rationale: "Rationale",
  },
} as const;

function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** A brief as plain text for the content's notes. */
export function briefNotes(brief: BriefOutput, language: AiLanguage): string {
  const l = BRIEF_LABELS[language];
  const lines = [
    l.heading,
    `${l.objective}: ${brief.objective}`,
    `${l.audience}: ${brief.audience}`,
    `${l.keyMessage}: ${brief.keyMessage}`,
    `${l.angle}: ${brief.angle}`,
    `${l.hook}: ${brief.hook}`,
    `${l.cta}: ${brief.cta}`,
    `${l.tone}: ${brief.tone}`,
    `${l.points}:`,
    ...brief.supportingPoints.map((point) => `- ${point}`),
    `${l.structure}:`,
    ...brief.structure.map((step, index) => `${String(index + 1)}. ${step}`),
  ];
  return cut(lines.join("\n"), MAX_NOTES);
}

/** Hook followed by the caption, unless the caption already opens with it. */
export function bodyWithHook(hook: string, caption: string): string {
  const text = caption.trimStart().startsWith(hook.trim()) ? caption : `${hook}\n\n${caption}`;
  return cut(text.trim(), MAX_BODY);
}

export interface ResolvedRefs {
  readonly pillarId: string | null;
  readonly campaignId: string | null;
}

function fields(raw: Record<string, unknown>): ContentFields {
  return contentFieldsSchema.parse(raw);
}

const EMPTY = {
  audienceId: null,
  goalId: null,
  plannedAt: null,
  link: null,
  assetIds: [],
} as const;

/** Fields for a new DRAFT from an IDEAS, BRIEF or COPY suggestion. */
export function newContentFields(
  operation: AiOperation,
  output: AnyAiOutput,
  choice: number,
  refs: ResolvedRefs,
  language: AiLanguage,
): ContentFields {
  const l = BRIEF_LABELS[language];
  switch (operation) {
    case "IDEAS": {
      const idea = (output as IdeasOutput).ideas[choice];
      if (idea === undefined) throw new RangeError("No such idea");
      return fields({
        ...EMPTY,
        title: idea.title,
        body: "",
        type: idea.contentType,
        pillarId: refs.pillarId,
        campaignId: refs.campaignId,
        notes: cut(
          [
            l.idea,
            `${l.angle}: ${idea.angle}`,
            `${l.objective}: ${idea.objective}`,
            `${l.audience}: ${idea.audience}`,
            `${l.rationale}: ${idea.rationale}`,
          ].join("\n"),
          MAX_NOTES,
        ),
        hashtags: [],
        callToAction: idea.ctaDirection,
      });
    }
    case "BRIEF": {
      const brief = output as BriefOutput;
      return fields({
        ...EMPTY,
        title: brief.title,
        body: "",
        type: brief.contentType,
        pillarId: refs.pillarId,
        campaignId: refs.campaignId,
        notes: briefNotes(brief, language),
        hashtags: [],
        callToAction: brief.cta,
      });
    }
    case "COPY": {
      const copy = output as CopyOutput;
      const version = choice === 0 ? copy : copy.variants[choice - 1];
      if (version === undefined) throw new RangeError("No such variant");
      return fields({
        ...EMPTY,
        title: copy.title,
        body: bodyWithHook(version.hook, version.caption),
        type: copy.contentType,
        pillarId: null,
        campaignId: refs.campaignId,
        notes: null,
        hashtags: copy.hashtags,
        callToAction: version.cta,
      });
    }
    case "CONTENT_DRAFT":
    case "CONTENT_REWRITE":
    case "CONTENT_ALTERNATIVES":
    case "CONTENT_HOOK":
    case "CONTENT_CTA":
    case "CONTENT_BRIEF":
    case "AD_PLAN":
      throw new TypeError(`${operation} does not create content`);
  }
}

/** Fields of an existing draft, in content-input form. */
export interface DraftFields {
  readonly title: string;
  readonly body: string;
  readonly type: ContentType;
  readonly campaignId: string | null;
  readonly pillarId: string | null;
  readonly audienceId: string | null;
  readonly goalId: string | null;
  readonly plannedAt: string | null;
  readonly notes: string | null;
  readonly hashtags: readonly string[];
  readonly callToAction: string | null;
  readonly link: string | null;
  readonly assetIds: readonly string[];
}

/** The draft's fields with one AI suggestion applied; everything else is kept. */
export function assistedFields(
  operation: AssistOperation,
  output: AnyAiOutput,
  choice: number,
  current: DraftFields,
  language: AiLanguage,
): ContentFields {
  const next: Record<string, unknown> = { ...current, hashtags: [...current.hashtags] };
  const record = output as Record<string, unknown>;
  switch (operation) {
    case "CONTENT_DRAFT":
    case "CONTENT_REWRITE": {
      const draft = output as { caption: string; hook: string; cta: string; hashtags: string[] };
      next.body = bodyWithHook(draft.hook, draft.caption);
      next.callToAction = draft.cta;
      if (draft.hashtags.length > 0) next.hashtags = draft.hashtags;
      break;
    }
    case "CONTENT_ALTERNATIVES": {
      const alternative = (record.alternatives as { caption: string; hook: string; cta: string }[])[
        choice
      ];
      if (alternative === undefined) throw new RangeError("No such alternative");
      next.body = bodyWithHook(alternative.hook, alternative.caption);
      next.callToAction = alternative.cta;
      break;
    }
    case "CONTENT_HOOK": {
      const hook = (record.hooks as string[])[choice];
      if (hook === undefined) throw new RangeError("No such hook");
      next.body = bodyWithHook(hook, current.body);
      break;
    }
    case "CONTENT_CTA": {
      const cta = (record.ctas as string[])[choice];
      if (cta === undefined) throw new RangeError("No such call to action");
      next.callToAction = cta;
      break;
    }
    case "CONTENT_BRIEF":
      next.notes = briefNotes(output as BriefOutput, language);
      break;
  }
  return fields(next);
}
