// Parsing of Meta Page and Instagram webhook notifications for the AI Social Manager.
// Pure (no `server-only`). The signature (X-Hub-Signature-256) is verified by the caller
// before this runs; everything here is still treated as untrusted input: unknown shapes
// are skipped, ids must be numeric-ish, text is bounded, and events outside the replay
// window are ignored.
//
// Handled (Graph webhooks, documented):
// - object "page": changes field "feed" with item "comment", verb "add" (a new comment),
//   and "messaging" (Messenger messages; echoes of the Page's own messages skipped);
// - object "instagram": changes field "comments" (a new comment) and "messaging"
//   (Instagram Direct).

export const SOCIAL_REPLAY_WINDOW_MS = 7 * 24 * 3_600_000;
const CLOCK_SKEW_MS = 5 * 60_000;

export interface SocialEvent {
  readonly platform: "FACEBOOK" | "INSTAGRAM";
  /** The Page id or Instagram account id the event belongs to. */
  readonly accountId: string;
  readonly kind: "COMMENT" | "MESSAGE";
  readonly externalId: string;
  /** The post (comments) or the sender to answer (messages). */
  readonly threadExternalId: string;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly text: string;
  readonly receivedAt: Date;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);
const ID = /^[0-9A-Za-z_.:-]{1,128}$/;
const cleanId = (value: unknown) => {
  const text = typeof value === "number" ? String(value) : str(value);
  return text !== null && ID.test(text) ? text : null;
};
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function instant(value: unknown, unit: "s" | "ms"): Date | null {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (Number.isFinite(number)) return new Date(unit === "s" ? number * 1000 : number);
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** The events of one notification (null = not a Page/Instagram notification). */
export function parseSocialWebhook(payload: unknown, now: Date): readonly SocialEvent[] | null {
  if (!isRecord(payload)) return null;
  const platform =
    payload.object === "page" ? "FACEBOOK" : payload.object === "instagram" ? "INSTAGRAM" : null;
  if (platform === null) return null;
  const events: SocialEvent[] = [];
  const fresh = (at: Date | null) =>
    at !== null &&
    at.getTime() <= now.getTime() + CLOCK_SKEW_MS &&
    now.getTime() - at.getTime() <= SOCIAL_REPLAY_WINDOW_MS;

  for (const entry of list(payload.entry)) {
    const accountId = cleanId(entry.id);
    if (accountId === null) continue;

    for (const change of list(entry.changes)) {
      const value = isRecord(change.value) ? change.value : null;
      if (value === null) continue;
      if (platform === "FACEBOOK" && change.field === "feed") {
        if (value.item !== "comment" || value.verb !== "add") continue;
        const from = isRecord(value.from) ? value.from : {};
        const authorId = cleanId(from.id);
        const externalId = cleanId(value.comment_id);
        const postId = cleanId(value.post_id);
        const text = str(value.message)?.trim() ?? "";
        const at = instant(value.created_time, "s") ?? instant(entry.time, "s");
        if (externalId === null || postId === null || text === "" || authorId === accountId)
          continue;
        if (!fresh(at) || at === null) continue;
        events.push({
          platform,
          accountId,
          kind: "COMMENT",
          externalId,
          threadExternalId: postId,
          authorId,
          authorName: str(from.name)?.slice(0, 200) ?? null,
          text: text.slice(0, 8000),
          receivedAt: at,
        });
      }
      if (platform === "INSTAGRAM" && change.field === "comments") {
        const from = isRecord(value.from) ? value.from : {};
        const authorId = cleanId(from.id);
        const externalId = cleanId(value.id);
        const media = isRecord(value.media) ? cleanId(value.media.id) : null;
        const text = str(value.text)?.trim() ?? "";
        const at = instant(entry.time, "s") ?? now;
        if (externalId === null || media === null || text === "" || authorId === accountId)
          continue;
        if (!fresh(at)) continue;
        events.push({
          platform,
          accountId,
          kind: "COMMENT",
          externalId,
          threadExternalId: media,
          authorId,
          authorName: str(from.username)?.slice(0, 200) ?? null,
          text: text.slice(0, 8000),
          receivedAt: at,
        });
      }
    }

    for (const item of list(entry.messaging)) {
      const message = isRecord(item.message) ? item.message : null;
      if (message === null || message.is_echo === true) continue;
      const sender = isRecord(item.sender) ? cleanId(item.sender.id) : null;
      const mid = cleanId(message.mid);
      const text = str(message.text)?.trim() ?? "";
      const at = instant(item.timestamp, "ms");
      if (sender === null || mid === null || text === "" || sender === accountId) continue;
      if (!fresh(at) || at === null) continue;
      events.push({
        platform,
        accountId,
        kind: "MESSAGE",
        externalId: mid,
        threadExternalId: sender,
        authorId: sender,
        authorName: null,
        text: text.slice(0, 8000),
        receivedAt: at,
      });
    }
  }
  return events;
}
