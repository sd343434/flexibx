import type { ClipSuggestion, ClipSuggestionProvider, TimedText } from "./types";

// Rule-based clip suggestions from the transcript's text and timestamps only. It does
// not look at the picture: no visual moments, faces, gestures or speaker changes. A
// window of consecutive segments between MIN and MAX length is scored from plain text
// signals; the best non-overlapping windows are suggested. The score ranks suggestions
// against each other — it is not a prediction of how a clip will perform. Pure.

export const MIN_CLIP_MS = 15_000;
export const MAX_CLIP_MS = 60_000;
const TARGET_MS = 30_000;
const MAX_SUGGESTIONS = 5;

const HOOK_WORDS = [
  // Arabic and English words that usually open an explanation or a tip.
  "كيف",
  "لماذا",
  "نصيحة",
  "سر",
  "خطوات",
  "أهم",
  "how",
  "why",
  "tip",
  "secret",
  "steps",
  "mistake",
];

function signals(text: string): { reasons: string[]; points: number } {
  const reasons: string[] = [];
  let points = 0;
  const lower = text.toLowerCase();
  if (/[?؟]/.test(text)) {
    reasons.push("question");
    points += 20;
  }
  if (/[0-9٠-٩]/.test(text)) {
    reasons.push("number");
    points += 15;
  }
  if (text.includes("!")) {
    reasons.push("exclamation");
    points += 10;
  }
  if (HOOK_WORDS.some((word) => lower.includes(word))) {
    reasons.push("hook_word");
    points += 15;
  }
  return { reasons, points };
}

function title(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  return words.length > 120 ? `${words.slice(0, 117)}…` : words;
}

export function suggestClips(segments: readonly TimedText[]): ClipSuggestion[] {
  const candidates: ClipSuggestion[] = [];
  for (let first = 0; first < segments.length; first += 1) {
    const start = segments[first];
    if (start === undefined) continue;
    let last = first;
    while (
      last + 1 < segments.length &&
      (segments[last + 1]?.endMs ?? 0) - start.startMs <= MAX_CLIP_MS &&
      (segments[last]?.endMs ?? 0) - start.startMs < TARGET_MS
    ) {
      last += 1;
    }
    const end = segments[last];
    if (end === undefined) continue;
    const length = end.endMs - start.startMs;
    if (length < MIN_CLIP_MS || length > MAX_CLIP_MS) continue;
    const text = segments
      .slice(first, last + 1)
      .map((segment) => segment.text)
      .join(" ");
    const found = signals(text);
    // Closer to the target length scores higher (up to 30 points).
    const fit = Math.round(30 * (1 - Math.abs(length - TARGET_MS) / TARGET_MS));
    const reasons = [...found.reasons, ...(fit >= 20 ? ["fits_length"] : [])];
    candidates.push({
      title: title(start.text),
      startMs: start.startMs,
      endMs: end.endMs,
      text: text.slice(0, 4000),
      reasons,
      score: Math.min(100, Math.max(0, found.points + Math.max(fit, 0))),
    });
  }
  // Best first; ties go to the earlier clip. Then keep only non-overlapping ones.
  candidates.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const chosen: ClipSuggestion[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= MAX_SUGGESTIONS) break;
    if (chosen.some((c) => candidate.startMs < c.endMs && c.startMs < candidate.endMs)) continue;
    chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.startMs - b.startMs);
}

export const ruleBasedClipSuggester: ClipSuggestionProvider = {
  id: "rules-v1",
  suggest: ({ segments }) => suggestClips(segments),
};
