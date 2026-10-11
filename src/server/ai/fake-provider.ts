import type { AiOperation, ContentType } from "@/generated/prisma/enums";

import { AiProviderError, type AiProvider, type AiRequest, type AiResponse } from "./provider";

// A deterministic local adapter for development and automated tests (AI_PROVIDER=fake).
// It calls nothing external: the same request always yields the same, schema-valid
// placeholder output, clearly marked as a sample. It reports no token usage (null) and
// has no cost. Failure scenarios exist only as constructor options for tests — nothing
// in a request can switch them on.

export type FakeScenario =
  | "ok"
  | "malformed"
  | "empty"
  | "oversized"
  | "schema_mismatch"
  | "unknown_references"
  | "timeout"
  | "unavailable"
  | "refused"
  | "rate_limited";

export interface FakeProviderOptions {
  readonly scenario?: FakeScenario;
  /** Fail this many calls with `scenario` first, then answer normally (retry tests). */
  readonly failTimes?: number;
  /** Artificial delay before answering, in ms (honours the abort signal). */
  readonly delayMs?: number;
}

export const FAKE_PROVIDER_NAME = "fake";
export const FAKE_MODEL = "fake-deterministic-1";

/** Small stable hash (FNV-1a) used to vary the sample text deterministically. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const COPY = {
  ar: {
    sample: "اقتراح تجريبي",
    idea: "فكرة",
    angle: "زاوية تعرض قيمة العلامة بلغة بسيطة.",
    objective: "رفع التفاعل مع الجمهور المستهدف.",
    audience: "الجمهور الأساسي للعلامة",
    cta: "اكتشف المزيد",
    rationale: "تنسجم مع ركائز المحتوى ونبرة العلامة.",
    caption: "نص تجريبي يوضح شكل المنشور المقترح.",
    hook: "هل جربت هذا من قبل؟",
    tone: "ودودة وواضحة",
    point: "نقطة داعمة",
    step: "خطوة",
    tag: "تجربة",
  },
  en: {
    sample: "Sample suggestion",
    idea: "Idea",
    angle: "An angle that shows the brand's value in plain words.",
    objective: "Grow engagement with the target audience.",
    audience: "The brand's core audience",
    cta: "Learn more",
    rationale: "Fits the content pillars and the brand's tone.",
    caption: "Sample text that shows the shape of the suggested post.",
    hook: "Have you tried this before?",
    tone: "Friendly and clear",
    point: "Supporting point",
    step: "Step",
    tag: "sample",
  },
} as const;

const TYPES: readonly ContentType[] = ["POST", "REEL", "STORY", "CAROUSEL", "VIDEO"];
const TYPES_ALL: readonly ContentType[] = [
  "POST",
  "REEL",
  "STORY",
  "VIDEO",
  "CAROUSEL",
  "ARTICLE",
  "EMAIL",
  "OTHER",
];

function handlesIn(text: string, prefix: "P" | "C" | "M"): string[] {
  return [
    ...new Set(
      [...text.matchAll(new RegExp(`\\[(${prefix}[1-9])\\]`, "g"))].map((m) => m[1] ?? ""),
    ),
  ];
}

/** Values the task asks for (content type, list sizes), read from the prompt. */
function requested(text: string) {
  const type = /^(?:Requested content type|نوع المحتوى المطلوب): ([A-Z]+)$/m.exec(text)?.[1];
  const exactly = /exactly (\d+) items/.exec(text)?.[1];
  return {
    type: TYPES_ALL.find((candidate) => candidate === type) ?? null,
    count: exactly === undefined ? null : Number(exactly),
  };
}

function sampleOutput(request: AiRequest, unknownReferences: boolean): unknown {
  const words = COPY[request.language];
  const asked = requested(request.user);
  const seed = stableHash(`${request.operation}\n${request.user}`);
  const pillars = handlesIn(request.user, "P");
  const campaigns = handlesIn(request.user, "C");
  const pillarRef = unknownReferences
    ? "P9"
    : (pillars[seed % Math.max(pillars.length, 1)] ?? null);
  const campaignRef = unknownReferences ? "C9" : (campaigns[0] ?? null);
  const tag = `${words.sample} ${String(seed % 1000)}`;
  const variant = (index: number) => ({
    caption: `${words.caption} (${String(index + 1)})`,
    hook: `${words.hook} (${String(index + 1)})`,
    cta: words.cta,
  });
  const brief = {
    title: `${tag}: ${words.idea}`,
    contentType: asked.type ?? TYPES[seed % TYPES.length] ?? "POST",
    objective: words.objective,
    audience: words.audience,
    keyMessage: words.angle,
    angle: words.angle,
    hook: words.hook,
    cta: words.cta,
    tone: words.tone,
    supportingPoints: [1, 2, 3].map((n) => `${words.point} ${String(n)}`),
    structure: [1, 2, 3].map((n) => `${words.step} ${String(n)}`),
    pillarRef,
    campaignRef,
  };
  const operation: AiOperation = request.operation;
  switch (operation) {
    case "IDEAS": {
      const count = asked.count ?? 3 + (seed % 3);
      return {
        ideas: Array.from({ length: count }, (_, index) => ({
          title: `${tag}: ${words.idea} ${String(index + 1)}`,
          angle: words.angle,
          contentType: TYPES[(seed + index) % TYPES.length] ?? "POST",
          objective: words.objective,
          audience: words.audience,
          ctaDirection: words.cta,
          rationale: words.rationale,
          pillarRef: index === 0 ? pillarRef : null,
          campaignRef: index === 0 ? campaignRef : null,
        })),
      };
    }
    case "BRIEF":
    case "CONTENT_BRIEF":
      return brief;
    case "COPY":
      return {
        title: `${tag}: ${words.idea}`,
        contentType: asked.type ?? "POST",
        caption: `${tag}. ${words.caption}`,
        hook: words.hook,
        cta: words.cta,
        hashtags: [`#${words.tag}`, "#flexibx"],
        variants: Array.from({ length: Math.min(asked.count ?? 2, 3) }, (_, index) =>
          variant(index),
        ),
      };
    case "CONTENT_DRAFT":
    case "CONTENT_REWRITE":
      return {
        caption: `${tag}. ${words.caption}`,
        hook: words.hook,
        cta: words.cta,
        hashtags: [`#${words.tag}`],
      };
    case "CONTENT_ALTERNATIVES":
      return { alternatives: [variant(0), variant(1), variant(2)] };
    case "CONTENT_HOOK":
      return { hooks: [1, 2, 3].map((n) => `${words.hook} ${String(n)}`) };
    case "CONTENT_CTA":
      return { ctas: [1, 2, 3].map((n) => `${words.cta} ${String(n)}`) };
    case "AD_PLAN": {
      const assets = handlesIn(request.user, "M");
      return {
        objective: "TRAFFIC",
        campaignName: `${tag}: ${words.idea}`,
        audience: {
          description: words.audience,
          countries: ["SA"],
          ageMin: 25,
          ageMax: 44,
          genders: "ALL",
          interests: [words.tag],
        },
        placements: ["INSTAGRAM_FEED", "INSTAGRAM_STORIES", "FACEBOOK_FEED"],
        creative: {
          headline: `${tag}: ${words.idea}`,
          primaryText: `${tag}. ${words.caption}`,
          callToAction: "LEARN_MORE",
          assetRef: unknownReferences ? "M9" : (assets[0] ?? null),
        },
        rationale: words.rationale,
      };
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AiProviderError("timeout", "Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AiProviderError("timeout", "Aborted"));
      },
      { once: true },
    );
  });
}

export function createFakeProvider(options: FakeProviderOptions = {}): AiProvider & {
  readonly calls: number;
} {
  const scenario = options.scenario ?? "ok";
  let calls = 0;
  return {
    name: FAKE_PROVIDER_NAME,
    get calls() {
      return calls;
    },
    async generate(request: AiRequest): Promise<AiResponse> {
      calls += 1;
      const failing = options.failTimes === undefined || calls <= options.failTimes;
      const active: FakeScenario = failing ? scenario : "ok";
      if (options.delayMs !== undefined) await wait(options.delayMs, request.signal);
      const answer = (text: string): AiResponse => ({
        text,
        provider: FAKE_PROVIDER_NAME,
        model: FAKE_MODEL,
        usage: { inputTokens: null, outputTokens: null },
      });
      switch (active) {
        case "timeout":
          // Never answers; the caller's timeout ends the attempt.
          await wait(2 ** 31 - 1, request.signal);
          throw new AiProviderError("timeout");
        case "unavailable":
        case "refused":
        case "rate_limited":
          throw new AiProviderError(active, `Fake ${active}`);
        case "malformed":
          return answer('{"ideas": [ {"title": "unterminated"');
        case "empty":
          return answer("   ");
        case "oversized":
          return answer(`{"caption": "${"x".repeat(30_000)}"}`);
        case "schema_mismatch":
          return answer(JSON.stringify({ unexpected: true }));
        case "unknown_references":
          return answer(JSON.stringify(sampleOutput(request, true)));
        case "ok":
          return answer(JSON.stringify(sampleOutput(request, false)));
      }
    },
  };
}
