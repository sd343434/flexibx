import { z } from "zod";

import { encryptToken } from "../ads/token-vault";
import { adsError, adsNotConfigured } from "../ads/errors";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";
import { parseInput } from "../validation/parse";

import {
  applyOptOut,
  readConsentHistory,
  recordInitialOptIn,
  type ConsentEventView,
} from "./consent";
import { maskDigits, normalizePhone, phoneHash, windowOpen } from "./messaging";

// WhatsApp contacts of a workspace: people who agreed to receive messages from the
// business on one WhatsApp Business account. A contact is only ever added with a recorded
// opt-in (where it was given); its number is stored encrypted (AES-256-GCM bound to the
// workspace) plus a keyed hash to find it again and a masked form for display — never in
// clear. A contact who opted out (here, or by writing STOP) is never messaged, and only
// the customer can opt in again (by writing START): staff cannot re-add them.

/** The vault binding of contact numbers (distinct from platform tokens). */
export const CONTACT_BINDING = "WHATSAPP_CONTACT";

export const CONSENT_SOURCES = ["website_form", "in_store", "whatsapp_message", "other"] as const;

const addContactSchema = z.object({
  accountId: z.string().max(100),
  phone: z.string().trim().min(1).max(40),
  consentSource: z.enum(CONSENT_SOURCES),
  /** The person confirms the customer agreed to receive WhatsApp messages. */
  consentConfirmed: z.literal(true),
});

const notFound = (resource: string) => new AppError("NOT_FOUND", { metadata: { resource } });
const invalidNumber = () =>
  new AppError("VALIDATION_FAILED", {
    fields: [{ path: "phone", code: "whatsapp_invalid_number" }],
  });

async function whatsAppAccount(db: Db, ctx: TenantContext, accountId: string) {
  if (!isUuid(accountId)) throw notFound("ad_account");
  const account = await db.adAccount.findFirst({
    where: { workspaceId: ctx.workspaceId, id: accountId, platform: "WHATSAPP" },
    select: { id: true, selected: true },
  });
  if (account === null) throw notFound("ad_account");
  if (!account.selected) throw adsError("CONFLICT", "ads_account_unavailable");
  return account;
}

/** Adds a contact with their recorded opt-in (ads.plan). Idempotent per number. */
export async function addWhatsAppContact(
  deps: { readonly db: Db; readonly tokenKey: string | null },
  ctx: TenantContext,
  input: unknown,
): Promise<{ readonly contactId: string; readonly created: boolean }> {
  assertCan(ctx, "ads.plan");
  const data = parseInput(addContactSchema, input);
  if (deps.tokenKey === null) throw adsNotConfigured();
  const digits = normalizePhone(data.phone);
  if (digits === null) throw invalidNumber();
  const account = await whatsAppAccount(deps.db, ctx, data.accountId);
  const hash = phoneHash(
    deps.tokenKey,
    { workspaceId: ctx.workspaceId, accountId: account.id },
    digits,
  );
  const existing = await deps.db.whatsAppContact.findFirst({
    where: { workspaceId: ctx.workspaceId, accountId: account.id, phoneHash: hash },
    select: { id: true, consentStatus: true },
  });
  if (existing !== null) {
    // An opt-out is the customer's decision: only their own START message reverses it.
    if (existing.consentStatus !== "OPTED_IN") throw adsError("CONFLICT", "whatsapp_no_consent");
    return { contactId: existing.id, created: false };
  }
  const now = new Date();
  const contact = await deps.db.$transaction(async (tx) => {
    const created = await tx.whatsAppContact.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        phoneHash: hash,
        phoneCiphertext: encryptToken(deps.tokenKey ?? "", digits, {
          workspaceId: ctx.workspaceId,
          platform: CONTACT_BINDING,
        }),
        maskedNumber: maskDigits(digits),
        consentStatus: "OPTED_IN",
        consentSource: data.consentSource,
        consentAt: now,
        addedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordInitialOptIn(tx, {
      workspaceId: ctx.workspaceId,
      contactId: created.id,
      source: data.consentSource,
      at: now,
      actor: ctx,
    });
    return created;
  });
  return { contactId: contact.id, created: true };
}

/** Records a contact's opt-out (ads.plan). Nothing is sent to them afterwards. */
export async function optOutWhatsAppContact(
  db: Db,
  ctx: TenantContext,
  contactId: string,
): Promise<void> {
  assertCan(ctx, "ads.plan");
  if (!isUuid(contactId)) throw notFound("whatsapp_contact");
  const contact = await db.whatsAppContact.findFirst({
    where: { workspaceId: ctx.workspaceId, id: contactId },
    select: { id: true, consentStatus: true, maskedNumber: true },
  });
  if (contact === null) throw notFound("whatsapp_contact");
  if (contact.consentStatus === "OPTED_OUT") return;
  await db.$transaction(async (tx) => {
    await applyOptOut(tx, {
      workspaceId: ctx.workspaceId,
      contactId: contact.id,
      at: new Date(),
      source: "staff",
      actor: ctx,
    });
  });
}

export interface WhatsAppContactView {
  readonly id: string;
  readonly accountId: string;
  readonly maskedNumber: string;
  readonly consentStatus: string;
  readonly consentSource: string;
  readonly consentAt: Date;
  readonly optedOutAt: Date | null;
  readonly lastInboundAt: Date | null;
  readonly windowOpen: boolean;
  /** The customer stopped marketing messages (utility templates and replies allowed). */
  readonly marketingOptedOutAt: Date | null;
  readonly history: readonly ConsentEventView[];
}

export const CONTACTS_LISTED = 100;

/** The workspace's WhatsApp contacts (ads.view): masked numbers only. */
export async function listWhatsAppContacts(
  db: Db,
  ctx: TenantContext,
  now: Date = new Date(),
): Promise<WhatsAppContactView[]> {
  assertCan(ctx, "ads.view");
  const rows = await db.whatsAppContact.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: CONTACTS_LISTED,
    select: {
      id: true,
      accountId: true,
      maskedNumber: true,
      consentStatus: true,
      consentSource: true,
      consentAt: true,
      optedOutAt: true,
      lastInboundAt: true,
      marketingOptedOutAt: true,
    },
  });
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      windowOpen: windowOpen(row.lastInboundAt, now),
      history: await readConsentHistory(db, ctx.workspaceId, row.id, 5),
    })),
  );
}
