import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";

import { createGuardedClient } from "../db/prisma";
import type { Db } from "../db/types";

import { applyCustomerOptIn, applyMarketingPreference, applyOptOut } from "./consent";

import { advanceStatus, consentKeyword, phoneHash, type MessageStatus } from "./messaging";

// WhatsApp webhooks (developers.facebook.com, "WhatsApp webhooks"):
// - Verification: GET with hub.mode=subscribe, hub.verify_token (the Verify Token set in
//   the App Dashboard) and hub.challenge, which is echoed back when the token matches.
// - Notifications: POST, signed with HMAC-SHA256 of the raw body using the app secret, in
//   `X-Hub-Signature-256: sha256=<hex>`. Payloads can be up to 3 MB. Meta retries failed
//   deliveries for up to 7 days and retries can arrive as duplicates, so handling is
//   idempotent: every event is recorded at most once per workspace (`event_hash`).
//
// Privacy: an event is reduced to its kind (an outgoing message's status, or "a customer
// wrote"), its status, the business phone number's id, an error code and its time. Customer
// phone numbers (`from`, `recipient_id`), message ids and message contents are never
// stored or logged; the message id only feeds the one-way deduplication hash. While a
// notification is processed (in memory only), a status's message id is matched against
// Flexibx's own sent messages (their wamid), and an inbound message's sender is matched,
// through the keyed hash, against the workspace's contacts: it opens the 24-hour window,
// and a message that is exactly STOP/START (or the Arabic equivalents) records the
// customer's opt-out or opt-in. The text itself is never kept.

export const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;
/** Events older than Meta's retry window (or from the future) are ignored as replays. */
export const REPLAY_WINDOW_MS = 7 * 24 * 3_600_000;
export const CLOCK_SKEW_MS = 5 * 60_000;

/** Constant-time check of `X-Hub-Signature-256` against the raw body. */
export function verifySignature(
  rawBody: Uint8Array,
  header: string | null,
  appSecret: string,
): boolean {
  if (header === null || !/^sha256=[0-9a-f]{64}$/i.test(header.trim())) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.trim().slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The challenge to echo for a valid subscription check, or null. */
export function verifyChallenge(
  params: URLSearchParams,
  verifyToken: string | undefined,
): string | null {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (verifyToken === undefined || mode !== "subscribe" || token === null || challenge === null) {
    return null;
  }
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(verifyToken).digest();
  if (!timingSafeEqual(a, b)) return null;
  return /^[A-Za-z0-9_-]{1,128}$/.test(challenge) ? challenge : null;
}

export type WebhookStatus =
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "received"
  | "other"
  | "marketing_stop"
  | "marketing_resume";

export interface WebhookEvent {
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly kind: "status" | "message" | "preference";
  readonly status: WebhookStatus;
  readonly errorCode: number | null;
  readonly eventAt: Date;
  /** sha256 of WABA, kind, message id and status: deduplicates without keeping the id. */
  readonly eventHash: string;
  /** Transient (never stored): the message id of a status report. */
  readonly messageId: string | null;
  /** Transient (never stored): the customer's digits (inbound sender, preference wa_id). */
  readonly from: string | null;
  /** Transient: an inbound message that is exactly an opt-out / opt-in keyword. */
  readonly keyword: "out" | "in" | null;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const id = (value: unknown): string | null => {
  const text = str(value);
  return text !== null && /^[0-9A-Za-z_-]{1,64}$/.test(text) ? text : null;
};

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function eventTime(value: unknown): Date | null {
  const seconds = typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : null;
  return seconds === null ? null : new Date(seconds * 1000);
}

const hash = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex");

/** The dedup hash of one status report of one message (also used to find early reports). */
export const statusEventHash = (wabaId: string, messageId: string, status: string) =>
  hash(wabaId, "status", messageId, status);

/**
 * The events in a `whatsapp_business_account` notification. Returns null when the payload
 * is not one (wrong shape); entries or items that cannot be read are skipped.
 */
export function parseWebhook(payload: unknown): WebhookEvent[] | null {
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account") return null;
  if (!Array.isArray(payload.entry)) return null;
  const events: WebhookEvent[] = [];
  for (const entry of records(payload.entry)) {
    const wabaId = id(entry.id);
    if (wabaId === null) continue;
    for (const change of records(entry.changes)) {
      if (change.field === "user_preferences" && isRecord(change.value)) {
        events.push(...parsePreferences(wabaId, change.value));
        continue;
      }
      if (change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      const metadata = isRecord(value.metadata) ? value.metadata : {};
      const phoneNumberId = id(metadata.phone_number_id);
      if (phoneNumberId === null) continue;
      for (const status of records(value.statuses)) {
        const messageId = str(status.id);
        const eventAt = eventTime(status.timestamp);
        const raw = str(status.status);
        if (messageId === null || eventAt === null || raw === null) continue;
        const errors = records(status.errors);
        const code = errors[0]?.code;
        events.push({
          wabaId,
          phoneNumberId,
          kind: "status",
          status: STATUSES.has(raw) ? (raw as WebhookStatus) : "other",
          errorCode: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
          eventAt,
          eventHash: statusEventHash(wabaId, messageId, raw),
          messageId,
          from: null,
          keyword: null,
        });
      }
      for (const message of records(value.messages)) {
        const messageId = str(message.id);
        const eventAt = eventTime(message.timestamp);
        if (messageId === null || eventAt === null) continue;
        const from = str(message.from);
        const text = isRecord(message.text) ? str(message.text.body) : null;
        const button = isRecord(message.button) ? str(message.button.text) : null;
        events.push({
          wabaId,
          phoneNumberId,
          kind: "message",
          status: "received",
          errorCode: null,
          eventAt,
          eventHash: hash(wabaId, "message", messageId),
          messageId: null,
          from: from !== null && /^[1-9]\d{7,14}$/.test(from) ? from : null,
          keyword: consentKeyword(text ?? button),
        });
      }
    }
  }
  return events;
}

/**
 * `user_preferences`: a customer stopped or resumed MARKETING messages from the business
 * (entries: wa_id, category "marketing_messages", value, timestamp). Only an explicit
 * "resume" counts as resuming; any other value is treated as "stop" (the safe reading).
 * Entries without a wa_id (customers using a username) cannot be matched and are skipped.
 */
function parsePreferences(wabaId: string, value: Json): WebhookEvent[] {
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const phoneNumberId = id(metadata.phone_number_id) ?? "none";
  return records(value.user_preferences).flatMap((preference) => {
    const category = str(preference.category);
    const waId = str(preference.wa_id);
    const eventAt = eventTime(
      typeof preference.timestamp === "number"
        ? String(preference.timestamp)
        : preference.timestamp,
    );
    if (category !== "marketing_messages" || waId === null || eventAt === null) return [];
    if (!/^[1-9]\d{7,14}$/.test(waId)) return [];
    const resume = (str(preference.value) ?? "").toLowerCase() === "resume";
    const status = resume ? "marketing_resume" : "marketing_stop";
    return [
      {
        wabaId,
        phoneNumberId,
        kind: "preference" as const,
        status,
        errorCode: null,
        eventAt,
        // Replaced by a keyed hash before storage (the customer's number never is).
        eventHash: hash(wabaId, "preference", status, String(eventAt.getTime())),
        messageId: null,
        from: waId,
        keyword: null,
      },
    ];
  });
}

export interface WebhookOutcome {
  readonly recorded: number;
  readonly duplicates: number;
  readonly replayed: number;
  readonly unknownAccount: number;
  /** Outbound messages whose status moved forward. */
  readonly statusesApplied: number;
  /** Inbound messages matched to a contact (window opened, consent keywords). */
  readonly contactsUpdated: number;
}

/** The customer's marketing opt-out reported in a failed status (Cloud API 131050). */
export const MARKETING_OPT_OUT = 131_050;

/**
 * Records verified events. SYSTEM PATH (reviewed): a webhook carries no session, so the
 * WABA is resolved to the workspaces that connected and selected it (active connection);
 * each gets its own copy, scoped by workspace id (through the tenant guard). Duplicates
 * are skipped by the (workspace, event_hash) key and every effect is order-safe; events
 * outside the replay window are ignored.
 */
export async function recordWebhookEvents(
  system: PrismaClient,
  events: readonly WebhookEvent[],
  now: Date = new Date(),
  /** ENCRYPTION_KEY: matches customers to contacts (keyed hash). */
  phoneKey: string | null = null,
): Promise<WebhookOutcome> {
  const db = createGuardedClient(system);
  const fresh = events.filter(
    (event) =>
      event.eventAt.getTime() >= now.getTime() - REPLAY_WINDOW_MS &&
      event.eventAt.getTime() <= now.getTime() + CLOCK_SKEW_MS &&
      // A preference cannot be matched (or deduplicated privately) without the key.
      (event.kind !== "preference" || phoneKey !== null),
  );
  const wabaIds = [...new Set(fresh.map((event) => event.wabaId))];
  const accounts =
    wabaIds.length === 0
      ? []
      : await system.adAccount.findMany({
          where: {
            platform: "WHATSAPP",
            externalId: { in: wabaIds },
            selected: true,
            connection: { status: "ACTIVE" },
            workspace: { deletedAt: null },
          },
          select: { id: true, workspaceId: true, externalId: true },
        });
  const storedHash = (event: WebhookEvent, account: { workspaceId: string; accountId: string }) =>
    event.kind === "preference" && phoneKey !== null
      ? phoneHash(phoneKey, account, `${event.from ?? ""}|${event.eventHash}`)
      : event.eventHash;
  const rows = fresh.flatMap((event) =>
    accounts
      .filter((account) => account.externalId === event.wabaId)
      .map((account) => ({
        workspaceId: account.workspaceId,
        accountId: account.id,
        eventHash: storedHash(event, { workspaceId: account.workspaceId, accountId: account.id }),
        kind: event.kind,
        status: event.status,
        phoneNumberId: event.phoneNumberId,
        errorCode: event.errorCode,
        eventAt: event.eventAt,
      })),
  );
  const unknownAccount = fresh.filter(
    (event) => !accounts.some((account) => account.externalId === event.wabaId),
  ).length;
  const created =
    rows.length === 0
      ? { count: 0 }
      : await system.whatsAppWebhookEvent.createMany({ data: rows, skipDuplicates: true });
  let statusesApplied = 0;
  let contactsUpdated = 0;
  for (const event of fresh) {
    for (const account of accounts.filter((a) => a.externalId === event.wabaId)) {
      if (event.kind === "status" && event.messageId !== null) {
        if (await applyStatusEvent(db, account.workspaceId, event)) statusesApplied += 1;
      } else if (event.from !== null && phoneKey !== null) {
        if (await applyCustomerEvent(db, account, event, phoneKey)) contactsUpdated += 1;
      }
    }
  }
  return {
    recorded: created.count,
    duplicates: rows.length - created.count,
    replayed: events.length - fresh.length,
    unknownAccount,
    statusesApplied,
    contactsUpdated,
  };
}

/** A delivery report moves Flexibx's own message forward (never backward). */
async function applyStatusEvent(
  db: Db,
  workspaceId: string,
  event: WebhookEvent,
): Promise<boolean> {
  if (
    event.status !== "sent" &&
    event.status !== "delivered" &&
    event.status !== "read" &&
    event.status !== "failed"
  ) {
    return false;
  }
  const message = await db.whatsAppMessage.findFirst({
    where: { workspaceId, externalMessageId: event.messageId ?? "" },
    select: { id: true, status: true, contactId: true },
  });
  if (message === null) return false;
  const next = advanceStatus(message.status as MessageStatus, event.status);
  if (next === null) return false;
  const updated = await db.whatsAppMessage.updateMany({
    where: { workspaceId, id: message.id, status: message.status },
    data: {
      status: next,
      statusAt: event.eventAt,
      ...(next === "FAILED" ? { errorCode: event.errorCode } : {}),
    },
  });
  if (updated.count > 0 && next === "FAILED" && event.errorCode === MARKETING_OPT_OUT) {
    await applyMarketingPreference(db, {
      workspaceId,
      contactId: message.contactId,
      at: event.eventAt,
      preference: "stop",
      source: "error_131050",
    });
  }
  return updated.count > 0;
}

/**
 * A customer did something: wrote to the business (their window opens — lastInboundAt
 * only moves forward — and an exact STOP/START records their choice), or changed their
 * marketing preference. Every change is applied only if newer than the last one.
 */
async function applyCustomerEvent(
  db: Db,
  account: { readonly id: string; readonly workspaceId: string },
  event: WebhookEvent,
  phoneKey: string,
): Promise<boolean> {
  const contact = await db.whatsAppContact.findFirst({
    where: {
      workspaceId: account.workspaceId,
      accountId: account.id,
      phoneHash: phoneHash(
        phoneKey,
        { workspaceId: account.workspaceId, accountId: account.id },
        event.from ?? "",
      ),
    },
    select: { id: true, consentStatus: true },
  });
  if (contact === null) return false;
  const base = { workspaceId: account.workspaceId, contactId: contact.id, at: event.eventAt };
  if (event.kind === "preference") {
    await applyMarketingPreference(db, {
      ...base,
      preference: event.status === "marketing_resume" ? "resume" : "stop",
      source: "user_preferences",
    });
    return true;
  }
  await db.whatsAppContact.updateMany({
    where: {
      workspaceId: account.workspaceId,
      id: contact.id,
      OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: event.eventAt } }],
    },
    data: { lastInboundAt: event.eventAt },
  });
  if (event.keyword === "out") {
    await applyOptOut(db, { ...base, source: "whatsapp_keyword", actor: null });
  } else if (event.keyword === "in") {
    await applyCustomerOptIn(db, { ...base, source: "whatsapp_keyword" });
  }
  return true;
}
