import { createHmac } from "node:crypto";

// Pure rules of WhatsApp messaging (no I/O): recipient numbers, their keyed hash, the
// 24-hour customer service window, opt-out keywords, and the order of delivery statuses.

/** The customer service window: free-form messages only within 24 h of the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * 3_600_000;
/** At most this many messages per workspace in any 24 hours (each one approved separately). */
export const WORKSPACE_DAILY_CAP = 50;
/** At most this many messages to one contact in any 24 hours. */
export const CONTACT_DAILY_CAP = 2;
export const MAX_TEXT_LENGTH = 4096;
export const MAX_TEMPLATE_PARAMETERS = 10;

/**
 * An international number ("+999 50 123 4567", "00999501234567") → its digits (E.164
 * without "+"), or null. Local numbers without a country code are refused.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!/^(\+|00)[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/^00/, "").replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/**
 * A keyed one-way hash of a number within one workspace and account (finds a contact
 * again, e.g. from a webhook, without storing the number in clear).
 */
export function phoneHash(
  base64Key: string,
  binding: { readonly workspaceId: string; readonly accountId: string },
  digits: string,
): string {
  return createHmac("sha256", Buffer.from(base64Key, "base64"))
    .update(`flexibx:whatsapp-contact:v1:${binding.workspaceId}:${binding.accountId}:${digits}`)
    .digest("hex");
}

/** "999501234567" → "•••• 4567". */
export const maskDigits = (digits: string) => `•••• ${digits.slice(-4)}`;

export function windowOpen(lastInboundAt: Date | null, now: Date): boolean {
  return (
    lastInboundAt !== null &&
    lastInboundAt.getTime() <= now.getTime() + 60_000 &&
    now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS
  );
}

const OPT_OUT = new Set([
  "stop",
  "unsubscribe",
  "optout",
  "opt out",
  "cancel",
  "ايقاف",
  "إيقاف",
  "الغاء",
  "إلغاء",
  "الغاء الاشتراك",
  "إلغاء الاشتراك",
  "توقف",
]);
const OPT_IN = new Set(["start", "subscribe", "اشتراك", "ابدأ"]);

/** A customer's whole message as a keyword: "out", "in", or null (anything else). */
export function consentKeyword(text: string | null): "out" | "in" | null {
  if (text === null) return null;
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!؟?،,]+$/u, "")
    .replace(/\s+/g, " ");
  if (OPT_OUT.has(normalized)) return "out";
  if (OPT_IN.has(normalized)) return "in";
  return null;
}

/** Outbound message states in order. FAILED is terminal but never overrides delivery. */
export type MessageStatus =
  | "PENDING"
  | "SENDING"
  | "UNCERTAIN"
  | "ACCEPTED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "CANCELLED";

const RANK: Readonly<Record<MessageStatus, number>> = {
  PENDING: 0,
  CANCELLED: 0,
  SENDING: 1,
  UNCERTAIN: 1,
  ACCEPTED: 2,
  SENT: 3,
  DELIVERED: 4,
  READ: 5,
  FAILED: 6,
};

/**
 * The status after a delivery report, or null when the report is stale: reports may
 * arrive late, twice or out of order, so a status only ever moves forward, and "failed"
 * is accepted only while the message was not yet delivered.
 */
export function advanceStatus(
  current: MessageStatus,
  report: "sent" | "delivered" | "read" | "failed",
): MessageStatus | null {
  if (current === "FAILED" || current === "CANCELLED") return null;
  if (report === "failed") return RANK[current] < RANK.DELIVERED ? "FAILED" : null;
  const next: MessageStatus =
    report === "sent" ? "SENT" : report === "delivered" ? "DELIVERED" : "READ";
  return RANK[next] > RANK[current] ? next : null;
}
