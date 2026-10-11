import { recordAudit } from "../audit/audit-log";
import type { Db } from "../db/types";
import type { TenantContext } from "../tenancy/context";

// WhatsApp consent, in one place for staff actions, the webhook and the send workflow.
//
// Two separate things:
// - Consent to be messaged at all (OPTED_IN / OPTED_OUT). Opt-in is recorded by staff with
//   its source, or by the customer writing START; opt-out by staff, or by the customer
//   writing STOP. Only the customer can opt back in after an opt-out.
// - Marketing messages (`marketingOptedOutAt`). Meta reports that a customer stopped (or
//   resumed) marketing messages from the business through the `user_preferences` webhook,
//   and refuses marketing templates to them with error 131050. Utility/authentication
//   templates and service replies remain allowed. Only the customer resumes.
//
// Every change is appended to `whatsapp_consent_events` (never updated or deleted) and
// audited. Changes are applied only when newer than the last change of the same kind, so
// late or repeated webhooks cannot undo a newer decision. An opt-out cancels the
// contact's messages still waiting for approval (all of them, or the marketing ones).

export type ConsentKind = "OPTED_IN" | "OPTED_OUT" | "MARKETING_OPTED_OUT" | "MARKETING_RESUMED";

/** Template categories that are not marketing (Meta: UTILITY, AUTHENTICATION). */
const NON_MARKETING = new Set(["UTILITY", "AUTHENTICATION"]);

/** Unknown categories count as marketing (the stricter rule). */
export const isMarketingCategory = (category: string | null | undefined) =>
  !NON_MARKETING.has((category ?? "").toUpperCase());

/** One second: webhook times have one-second resolution. */
const TICK_MS = 1000;

async function appendEvent(
  db: Db,
  event: {
    readonly workspaceId: string;
    readonly contactId: string;
    readonly kind: ConsentKind;
    readonly source: string;
    readonly occurredAt: Date;
    /** The member who recorded it; null for the customer or the platform. */
    readonly actor: TenantContext | null;
  },
) {
  await db.whatsAppConsentEvent.create({
    data: {
      workspaceId: event.workspaceId,
      contactId: event.contactId,
      kind: event.kind,
      source: event.source.slice(0, 40),
      occurredAt: event.occurredAt,
      actorUserId: event.actor?.userId ?? null,
    },
  });
  await recordAudit(db, event.actor ?? { workspaceId: event.workspaceId, userId: null }, {
    action:
      event.kind === "OPTED_IN"
        ? "whatsapp.contact_added"
        : event.kind === "OPTED_OUT"
          ? "whatsapp.contact_opted_out"
          : event.kind === "MARKETING_OPTED_OUT"
            ? "whatsapp.marketing_opted_out"
            : "whatsapp.marketing_resumed",
    entityType: "whatsapp_contact",
    entityId: event.contactId,
    metadata: { source: event.source, at: event.occurredAt.toISOString() },
  });
}

/** Records the first opt-in of a new contact (staff-recorded, with its source). */
export async function recordInitialOptIn(
  db: Db,
  event: { workspaceId: string; contactId: string; source: string; at: Date; actor: TenantContext },
) {
  await appendEvent(db, {
    workspaceId: event.workspaceId,
    contactId: event.contactId,
    kind: "OPTED_IN",
    source: event.source,
    occurredAt: event.at,
    actor: event.actor,
  });
}

/**
 * Cancels the contact's messages still waiting for approval: all of them, or only
 * marketing templates (by the template's category in the account's last sync).
 */
export async function cancelPendingMessages(
  db: Db,
  workspaceId: string,
  contactId: string,
  scope: "all" | "marketing",
): Promise<number> {
  const pending = await db.whatsAppMessage.findMany({
    where: { workspaceId, contactId, status: "PENDING" },
    select: {
      id: true,
      kind: true,
      templateName: true,
      templateLanguage: true,
      account: { select: { whatsappSnapshot: { select: { templates: true } } } },
    },
  });
  const cancel = pending.filter((message) => {
    if (scope === "all") return true;
    if (message.kind !== "TEMPLATE") return false;
    const templates = Array.isArray(message.account.whatsappSnapshot?.templates)
      ? (message.account.whatsappSnapshot.templates as {
          name?: unknown;
          language?: unknown;
          category?: unknown;
        }[])
      : [];
    const template = templates.find(
      (item) => item.name === message.templateName && item.language === message.templateLanguage,
    );
    return isMarketingCategory(typeof template?.category === "string" ? template.category : null);
  });
  for (const message of cancel) {
    const updated = await db.whatsAppMessage.updateMany({
      where: { workspaceId, id: message.id, status: "PENDING" },
      data: { status: "CANCELLED", statusAt: new Date() },
    });
    if (updated.count > 0) {
      await recordAudit(
        db,
        { workspaceId, userId: null },
        {
          action: "whatsapp.send_cancelled",
          entityType: "whatsapp_message",
          entityId: message.id,
          metadata: { reason: scope === "all" ? "opted_out" : "marketing_opted_out" },
        },
      );
    }
  }
  return cancel.length;
}

/** The contact no longer wants any message. Idempotent; never undone by an older event. */
export async function applyOptOut(
  db: Db,
  args: {
    workspaceId: string;
    contactId: string;
    at: Date;
    source: string;
    actor: TenantContext | null;
  },
): Promise<boolean> {
  const updated = await db.whatsAppContact.updateMany({
    where: {
      workspaceId: args.workspaceId,
      id: args.contactId,
      consentStatus: "OPTED_IN",
      // An opt-out in the same second as the consent still counts (the safe direction).
      consentAt: { lt: new Date(args.at.getTime() + TICK_MS) },
    },
    data: { consentStatus: "OPTED_OUT", optedOutAt: args.at },
  });
  if (updated.count === 0) return false;
  await appendEvent(db, {
    workspaceId: args.workspaceId,
    contactId: args.contactId,
    kind: "OPTED_OUT",
    source: args.source,
    occurredAt: args.at,
    actor: args.actor,
  });
  await cancelPendingMessages(db, args.workspaceId, args.contactId, "all");
  return true;
}

/** The customer opted in again themselves (START): only if newer than their opt-out. */
export async function applyCustomerOptIn(
  db: Db,
  args: { workspaceId: string; contactId: string; at: Date; source: string },
): Promise<boolean> {
  const updated = await db.whatsAppContact.updateMany({
    where: {
      workspaceId: args.workspaceId,
      id: args.contactId,
      consentStatus: "OPTED_OUT",
      optedOutAt: { lt: args.at },
    },
    data: {
      consentStatus: "OPTED_IN",
      consentSource: args.source,
      consentAt: args.at,
      optedOutAt: null,
    },
  });
  if (updated.count === 0) return false;
  await appendEvent(db, {
    workspaceId: args.workspaceId,
    contactId: args.contactId,
    kind: "OPTED_IN",
    source: args.source,
    occurredAt: args.at,
    actor: null,
  });
  return true;
}

/**
 * A marketing preference reported by Meta (user_preferences, or error 131050 → "stop").
 * Applied only when newer than the contact's last marketing change.
 */
export async function applyMarketingPreference(
  db: Db,
  args: {
    workspaceId: string;
    contactId: string;
    at: Date;
    preference: "stop" | "resume";
    source: string;
  },
): Promise<boolean> {
  const last = await db.whatsAppConsentEvent.findFirst({
    where: {
      workspaceId: args.workspaceId,
      contactId: args.contactId,
      kind: { in: ["MARKETING_OPTED_OUT", "MARKETING_RESUMED"] },
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: { occurredAt: true, kind: true },
  });
  if (last !== null && last.occurredAt.getTime() > args.at.getTime()) return false;
  if (args.preference === "stop") {
    if (last?.kind === "MARKETING_OPTED_OUT") return false;
    const updated = await db.whatsAppContact.updateMany({
      where: { workspaceId: args.workspaceId, id: args.contactId },
      data: { marketingOptedOutAt: args.at, marketingOptOutSource: args.source.slice(0, 40) },
    });
    if (updated.count === 0) return false;
  } else {
    if (last === null || last.kind === "MARKETING_RESUMED") return false;
    const updated = await db.whatsAppContact.updateMany({
      where: { workspaceId: args.workspaceId, id: args.contactId },
      data: { marketingOptedOutAt: null, marketingOptOutSource: null },
    });
    if (updated.count === 0) return false;
  }
  await appendEvent(db, {
    workspaceId: args.workspaceId,
    contactId: args.contactId,
    kind: args.preference === "stop" ? "MARKETING_OPTED_OUT" : "MARKETING_RESUMED",
    source: args.source,
    occurredAt: args.at,
    actor: null,
  });
  if (args.preference === "stop") {
    await cancelPendingMessages(db, args.workspaceId, args.contactId, "marketing");
  }
  return true;
}

export interface ConsentEventView {
  readonly kind: ConsentKind;
  readonly source: string;
  readonly occurredAt: Date;
  readonly actorName: string | null;
}

/** A contact's consent history, newest first. */
export async function readConsentHistory(
  db: Db,
  workspaceId: string,
  contactId: string,
  take = 20,
): Promise<ConsentEventView[]> {
  const rows = await db.whatsAppConsentEvent.findMany({
    where: { workspaceId, contactId },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take,
    select: { kind: true, source: true, occurredAt: true, actor: { select: { name: true } } },
  });
  return rows.map((row) => ({
    kind: row.kind as ConsentKind,
    source: row.source,
    occurredAt: row.occurredAt,
    actorName: row.actor?.name ?? null,
  }));
}
