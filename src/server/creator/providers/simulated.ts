import type { TimedText, TranscriptionProvider, TranslationProvider } from "./types";

// The declared simulator (CREATOR_AI_PROVIDER=simulated; refused in production). It
// makes NO external call and never reads the audio's content: it only uses the media's
// real duration to lay out timestamps. Every line says that it is simulated, and the
// transcript is stored with `simulated = true`, shown with a "simulated" label and never
// charged. It exists so the whole pipeline — clips, review, subtitles, export — can be
// developed and tested without a commercial provider. Pure.

const SEGMENT_MS = 6000;
const MAX_SEGMENTS = 400;

const LINES = {
  ar: [
    "نص محاكاة رقم {n}: هذا ليس كلامًا من الفيديو.",
    "نص محاكاة رقم {n}: كيف نختبر المقاطع دون مزود حقيقي؟",
    "نص محاكاة رقم {n}: ثلاث خطوات للتجربة، والرقم {n} للتوضيح فقط.",
    "نص محاكاة رقم {n}: نصيحة تجريبية لاختبار المراجعة!",
  ],
  en: [
    "Simulated line {n}: these are not words from the video.",
    "Simulated line {n}: how do we test clips without a real provider?",
    "Simulated line {n}: three steps to try, and number {n} is for illustration only.",
    "Simulated line {n}: a test tip to exercise the review!",
  ],
} as const;

export const SIMULATED_PROVIDER_ID = "simulated";

export function createSimulatedTranscription(): TranscriptionProvider {
  return {
    id: SIMULATED_PROVIDER_ID,
    model: "simulator-v1",
    simulated: true,
    external: false,
    region: null,
    chunkMs: null,
    costMicroUsdPerAudioSecond: null,
    maxDurationMs: 4 * 3_600_000,
    supportsLanguage: (language) => language === "ar" || language === "en",
    transcribe: ({ durationMs, languageHint, signal }) => {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      const language = languageHint === "en" ? "en" : "ar";
      const lines = LINES[language];
      const segments: TimedText[] = [];
      for (
        let start = 0, n = 1;
        start < durationMs && n <= MAX_SEGMENTS;
        start += SEGMENT_MS, n += 1
      ) {
        const end = Math.min(start + SEGMENT_MS, durationMs);
        if (end - start < 200) break;
        const template = lines[(n - 1) % lines.length] ?? lines[0];
        segments.push({ startMs: start, endMs: end, text: template.replaceAll("{n}", String(n)) });
      }
      return Promise.resolve({ language, segments, billedSeconds: null });
    },
  };
}

export function createSimulatedTranslation(): TranslationProvider {
  return {
    id: SIMULATED_PROVIDER_ID,
    model: "simulator-v1",
    simulated: true,
    external: false,
    region: null,
    batchSize: 10_000,
    supportsLanguage: (language) => ["ar", "en", "fr", "es", "tr", "ur"].includes(language),
    translate: ({ segments, to, signal }) => {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      // Not a translation: the original line, marked as a simulated one in the target.
      return Promise.resolve({
        segments: segments.map((segment) => ({
          ...segment,
          text: `[simulated ${to}] ${segment.text}`.slice(0, 2000),
        })),
        usage: null,
      });
    },
  };
}
