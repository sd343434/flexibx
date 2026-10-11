import { createHash } from "node:crypto";

import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";

import { WHATSAPP_SEND_SCOPE, whatsAppSnapshotSchema } from "../ads/adapters/whatsapp";
import { adsError } from "../ads/errors";
import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import { createRun, type OrchestrationDeps } from "../orchestration/engine";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan, can } from "../tenancy/permissions";
import { parseInput } from "../validation/parse";

import {
  advanceStatus,
  CONTACT_DAILY_CAP,
  MAX_TEMPLATE_PARAMETERS,
  MAX_TEXT_LENGTH,
  windowOpen,
  WORKSPACE_DAILY_CAP,
  type MessageStatus,
} from "./messaging";
import { isMarketingCategory } from "./consent";
import { statusEventHash } from "./webhook";

// Outbound WhatsApp messages. A person asks to send ONE message to ONE contact who opted in
// (no lists, no bulk); the whatsapp_send workflow then stops at its approval step, an owner
// or admin approves exactly that message, and only then is it sent — once. Everything is
// checked when it is asked for and again right before sending: sending enabled on this
// server, the account selected with an active connection holding
// whatsapp_business_messaging, the business number on that account, the contact's
// consent, an APPROVED template in that exact language (or, for free text, an open
// 24-hour window), and the workspace and per-contact daily caps.
//
// A send whose outcome is unknown (network failure, 5xx) is recorded UNCERTAIN and never
// repeated automatically; the platform's message id (wamid) and its delivery reports
// (webhooks) are recorded as they arrive, in any order.

export const WHATSAPP_SEND_WORKFLOW = "whatsapp_send";
const DAY_MS = 24 * 3_600_000;
/** Sends rely on numbers and template statuses synced at most this long ago. */
export const SNAPSHOT_MAX_AGE_MS = DAY_MS;

const sendSchema = z
  .object({
    accountId: z.string().max(100),
    phoneNumberId: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
    contactId: z.string().max(100),
    /** One per form render: a double submit sends nothing twice. */
    requestKey: z.uuid(),
    kind: z.enum(["TEMPLATE", "TEXT"]),
    templateName: z.string().trim().max(512).optional(),
    templateLanguage: z.string().trim().max(20).optional(),
    parameters: z.array(z.string().trim().min(1).max(1000)).max(MAX_TEMPLATE_PARAMETERS).optional(),
    text: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  })
  .superRefine((value, issues) => {
    if (value.kind === "TEMPLATE" && (!value.templateName || !value.templateLanguage)) {
      issues.addIssue({ code: "custom", path: ["templateName"], message: "required" });
    }
    if (value.kind === "TEXT" && !value.text) {
      issues.addIssue({ code: "custom", path: ["text"], message: "required" });
    }
  });

export type MessageContent =
  | { readonly kind: "TEMPLATE"; readonly parameters: readonly string[] }
  | { readonly kind: "TEXT"; readonly text: string };

const notFound = (resource: string) => new AppError("NOT_FOUND", { metadata: { resource } });
const refuse = (code: Parameters<typeof adsError>[1]) => adsError("CONFLICT", code);

/** What a send needs, loaded within the workspace (no number in clear). */
export async function loadSendContext(db: Db, workspaceId: string, messageId: string) {
  return db.whatsAppMessage.findFirst({
    where: { workspaceId, id: messageId },
    select: {
      id: true,
      status: true,
      kind: true,
      templateName: true,
      templateLanguage: true,
      content: true,
      phoneNumberId: true,
      createdAt: true,
      account: {
        select: {
          id: true,
          externalId: true,
          selected: true,
          platform: true,
          connection: { select: { status: true, scopes: true, version: true } },
          whatsappSnapshot: { select: { phoneNumbers: true, templates: true, fetchedAt: true } },
        },
      },
      contact: {
        select: {
          id: true,
          maskedNumber: true,
          phoneCiphertext: true,
          consentStatus: true,
          marketingOptedOutAt: true,
          consentSource: true,
          consentAt: true,
          lastInboundAt: true,
        },
      },
    },
  });
}

export type SendContext = NonNullable<Awaited<ReturnType<typeof loadSendContext>>>;

export function readContent(value: unknown): MessageContent | null {
  const parsed = z
    .union([
      z.strictObject({ kind: z.literal("TEMPLATE"), parameters: z.array(z.string()) }),
      z.strictObject({ kind: z.literal("TEXT"), text: z.string() }),
    ])
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Every rule a send must satisfy, checked on request and again right before sending.
 * Throws an AppError with the reason; returns nothing.
 */
export async function assertSendable(args: {
  readonly db: Db;
  readonly actor: TenantContext;
  readonly sendingEnabled: boolean;
  readonly configured: boolean;
  readonly message: {
    readonly id: string | null;
    readonly kind: string;
    readonly templateName: string | null;
    readonly templateLanguage: string | null;
    readonly phoneNumberId: string;
    readonly account: SendContext["account"];
    readonly contact: Pick<
      SendContext["contact"],
      "id" | "consentStatus" | "lastInboundAt" | "marketingOptedOutAt"
    >;
  };
  readonly now: Date;
}): Promise<void> {
  const { db, actor, message, now } = args;
  if (!can(actor.role, "ads.plan") || !can(actor.role, "automation.manage")) {
    throw new AppError("FORBIDDEN");
  }
  if (!args.sendingEnabled) throw refuse("whatsapp_sending_disabled");
  if (!args.configured) throw adsError("SERVICE_UNAVAILABLE", "ads_not_configured");
  const { account, contact } = message;
  if (account.platform !== "WHATSAPP" || !account.selected) {
    throw refuse("ads_account_unavailable");
  }
  if (account.connection.status !== "ACTIVE") throw refuse("ads_not_connected");
  if (!account.connection.scopes.includes(WHATSAPP_SEND_SCOPE)) {
    throw adsError("CONFLICT", "ads_permission_missing", { missing: [WHATSAPP_SEND_SCOPE] });
  }
  // Numbers and template statuses come from the last sync: too old, and a template Meta
  // has paused or rejected since would still look APPROVED here.
  const synced = account.whatsappSnapshot?.fetchedAt ?? null;
  if (synced === null || now.getTime() - synced.getTime() > SNAPSHOT_MAX_AGE_MS) {
    throw refuse("whatsapp_sync_required");
  }
  const snapshot =
    account.whatsappSnapshot === null
      ? null
      : whatsAppSnapshotSchema.safeParse({
          phoneNumbers: account.whatsappSnapshot.phoneNumbers,
          templates: account.whatsappSnapshot.templates,
          truncated: false,
        });
  const numbers = snapshot?.success === true ? snapshot.data.phoneNumbers : [];
  if (!numbers.some((number) => number.id === message.phoneNumberId)) {
    throw refuse("whatsapp_number_unavailable");
  }
  if (contact.consentStatus !== "OPTED_IN") throw refuse("whatsapp_no_consent");
  if (message.kind === "TEMPLATE") {
    const templates = snapshot?.success === true ? snapshot.data.templates : [];
    const template = templates.find(
      (item) =>
        item.name === message.templateName &&
        item.language === message.templateLanguage &&
        item.status === "APPROVED",
    );
    if (template === undefined) throw refuse("whatsapp_template_unavailable");
    // A customer who stopped marketing messages gets none (utility templates still go).
    if (contact.marketingOptedOutAt !== null && isMarketingCategory(template.category)) {
      throw refuse("whatsapp_marketing_opted_out");
    }
  } else if (!windowOpen(contact.lastInboundAt, now)) {
    throw refuse("whatsapp_window_closed");
  }
  // Caps count everything that went out or may have (not refused or cancelled sends).
  const since = new Date(now.getTime() - DAY_MS);
  const counted = {
    workspaceId: actor.workspaceId,
    createdAt: { gte: since },
    status: { notIn: ["FAILED", "CANCELLED"] },
    ...(message.id === null ? {} : { id: { not: message.id } }),
  } satisfies Prisma.WhatsAppMessageWhereInput;
  const [workspaceCount, contactCount] = await Promise.all([
    db.whatsAppMessage.count({ where: counted }),
    db.whatsAppMessage.count({ where: { ...counted, contactId: contact.id } }),
  ]);
  if (workspaceCount >= WORKSPACE_DAILY_CAP || contactCount >= CONTACT_DAILY_CAP) {
    throw adsError("RATE_LIMITED", "whatsapp_rate_limited");
  }
}

/** Marks requests whose run ended without sending (rejected, cancelled) as CANCELLED. */
export async function sweepAbandoned(db: Db, workspaceId: string) {
  // Never sent: the run ended (rejected, cancelled) while the message waited.
  await db.whatsAppMessage.updateMany({
    where: {
      workspaceId,
      status: "PENDING",
      run: { state: { in: ["FAILED", "CANCELLED"] } },
    },
    data: { status: "CANCELLED" },
  });
  // The worker stopped mid-send (crash, timeout): it may have gone out.
  await db.whatsAppMessage.updateMany({
    where: {
      workspaceId,
      status: "SENDING",
      run: { state: { in: ["FAILED", "CANCELLED"] } },
    },
    data: { status: "UNCERTAIN" },
  });
}

/**
 * An owner or admin (automation.approve) records that they checked a message whose
 * outcome is unknown (with the customer, or in WhatsApp Manager) and releases the contact
 * for further sends. The message keeps its UNCERTAIN status; nothing is resent.
 */
export async function resolveUncertainMessage(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  messageId: string,
): Promise<void> {
  assertCan(ctx, "automation.approve");
  if (!isUuid(messageId)) throw notFound("whatsapp_message");
  await sweepAbandoned(db, ctx.workspaceId);
  const message = await db.whatsAppMessage.findFirst({
    where: { workspaceId: ctx.workspaceId, id: messageId },
    select: { id: true, status: true, resolvedAt: true },
  });
  if (message === null) throw notFound("whatsapp_message");
  if (message.status !== "UNCERTAIN" || message.resolvedAt !== null) {
    throw adsError("CONFLICT", "whatsapp_send_pending");
  }
  await db.$transaction(async (tx) => {
    const updated = await tx.whatsAppMessage.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        id: message.id,
        status: "UNCERTAIN",
        resolvedAt: null,
      },
      data: { resolvedAt: new Date(), resolvedByUserId: ctx.userId },
    });
    if (updated.count === 0) throw adsError("CONFLICT", "whatsapp_send_pending");
    await recordAudit(tx, ctx, {
      action: "whatsapp.message_resolved",
      entityType: "whatsapp_message",
      entityId: message.id,
      metadata: { status: message.status },
    });
  });
}

/**
 * Asks to send one message (ads.plan + automation.manage). Creates the message (PENDING)
 * and its whatsapp_send run, which waits for an owner's or admin's approval.
 */
export async function requestWhatsAppSend<S>(
  deps: OrchestrationDeps<S> & {
    readonly sendingEnabled: boolean;
    readonly configured: boolean;
    readonly now?: () => Date;
  },
  ctx: TenantContext,
  input: unknown,
): Promise<{ readonly messageId: string; readonly runId: string; readonly created: boolean }> {
  assertCan(ctx, "ads.plan");
  assertCan(ctx, "automation.manage");
  const data = parseInput(sendSchema, input);
  if (!isUuid(data.accountId)) throw notFound("ad_account");
  if (!isUuid(data.contactId)) throw notFound("whatsapp_contact");
  const now = (deps.now ?? (() => new Date()))();
  const idempotencyKey = createHash("sha256")
    .update(`whatsapp_send:${ctx.workspaceId}:${data.requestKey}`)
    .digest("hex");
  const existing = await deps.db.whatsAppMessage.findFirst({
    where: { workspaceId: ctx.workspaceId, idempotencyKey },
    select: { id: true, runId: true },
  });
  if (existing !== null && existing.runId !== null) {
    return { messageId: existing.id, runId: existing.runId, created: false };
  }

  const [account, contact] = await Promise.all([
    deps.db.adAccount.findFirst({
      where: { workspaceId: ctx.workspaceId, id: data.accountId, platform: "WHATSAPP" },
      select: {
        id: true,
        externalId: true,
        selected: true,
        platform: true,
        connection: { select: { status: true, scopes: true, version: true } },
        whatsappSnapshot: { select: { phoneNumbers: true, templates: true, fetchedAt: true } },
      },
    }),
    deps.db.whatsAppContact.findFirst({
      where: { workspaceId: ctx.workspaceId, id: data.contactId, accountId: data.accountId },
      select: {
        id: true,
        consentStatus: true,
        lastInboundAt: true,
        maskedNumber: true,
        marketingOptedOutAt: true,
      },
    }),
  ]);
  if (account === null) throw notFound("ad_account");
  if (contact === null) throw notFound("whatsapp_contact");
  await sweepAbandoned(deps.db, ctx.workspaceId);
  // One message at a time per contact: an unfinished or unknown send blocks the next.
  const open = await deps.db.whatsAppMessage.count({
    where: {
      workspaceId: ctx.workspaceId,
      contactId: contact.id,
      status: { in: ["PENDING", "SENDING", "UNCERTAIN"] },
      resolvedAt: null,
    },
  });
  if (open > 0) throw refuse("whatsapp_send_pending");
  const message = {
    id: null,
    kind: data.kind,
    templateName: data.kind === "TEMPLATE" ? (data.templateName ?? null) : null,
    templateLanguage: data.kind === "TEMPLATE" ? (data.templateLanguage ?? null) : null,
    phoneNumberId: data.phoneNumberId,
    account,
    contact,
  };
  await assertSendable({
    db: deps.db,
    actor: ctx,
    sendingEnabled: deps.sendingEnabled,
    configured: deps.configured,
    message,
    now,
  });
  const content: MessageContent =
    data.kind === "TEMPLATE"
      ? { kind: "TEMPLATE", parameters: data.parameters ?? [] }
      : { kind: "TEXT", text: data.text ?? "" };

  const row = await deps.db.$transaction(async (tx) => {
    const created = await tx.whatsAppMessage.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        contactId: contact.id,
        phoneNumberId: data.phoneNumberId,
        kind: data.kind,
        templateName: message.templateName,
        templateLanguage: message.templateLanguage,
        content: content as unknown as Prisma.InputJsonValue,
        status: "PENDING",
        idempotencyKey,
        requestedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: "whatsapp.send_requested",
      entityType: "whatsapp_message",
      entityId: created.id,
      metadata: {
        accountId: account.id,
        to: contact.maskedNumber,
        kind: data.kind,
        template: message.templateName,
        language: message.templateLanguage,
      },
    });
    return created;
  });
  const { runId } = await createRun(
    deps,
    { workspaceId: ctx.workspaceId, requestedByUserId: ctx.userId },
    WHATSAPP_SEND_WORKFLOW,
    "MANUAL",
    `whatsapp_send:${row.id}`,
  );
  await deps.db.whatsAppMessage.updateMany({
    where: { workspaceId: ctx.workspaceId, id: row.id },
    data: { runId },
  });
  return { messageId: row.id, runId, created: true };
}

/**
 * Applies delivery reports that arrived (and were recorded) before the wamid was stored:
 * a webhook can beat the API's own answer.
 */
export async function applyEarlyReports(
  db: Db,
  workspaceId: string,
  message: { readonly id: string; readonly wabaId: string; readonly wamid: string },
): Promise<void> {
  const reports = ["sent", "delivered", "read", "failed"] as const;
  const events = await db.whatsAppWebhookEvent.findMany({
    where: {
      workspaceId,
      eventHash: {
        in: reports.map((report) => statusEventHash(message.wabaId, message.wamid, report)),
      },
    },
    select: { status: true, errorCode: true, eventAt: true },
    orderBy: { eventAt: "asc" },
  });
  for (const event of events) {
    await applyReport(db, workspaceId, message.id, event.status, event.errorCode, event.eventAt);
  }
}

/** Moves one message forward by a delivery report (stale or duplicate reports change nothing). */
export async function applyReport(
  db: Db,
  workspaceId: string,
  messageId: string,
  report: string,
  errorCode: number | null,
  at: Date,
): Promise<boolean> {
  if (report !== "sent" && report !== "delivered" && report !== "read" && report !== "failed") {
    return false;
  }
  const row = await db.whatsAppMessage.findFirst({
    where: { workspaceId, id: messageId },
    select: { status: true },
  });
  if (row === null) return false;
  const next = advanceStatus(row.status as MessageStatus, report);
  if (next === null) return false;
  // Compare-and-set: a concurrent report for the same message wins or loses cleanly.
  const updated = await db.whatsAppMessage.updateMany({
    where: { workspaceId, id: messageId, status: row.status },
    data: {
      status: next,
      statusAt: at,
      ...(next === "FAILED" ? { errorCode } : {}),
    },
  });
  return updated.count > 0;
}

export interface WhatsAppMessageView {
  readonly id: string;
  readonly kind: string;
  readonly templateName: string | null;
  readonly templateLanguage: string | null;
  readonly to: string;
  readonly status: string;
  readonly errorCode: number | null;
  readonly runState: string | null;
  readonly createdAt: Date;
  readonly statusAt: Date | null;
  /** An owner/admin checked this unknown outcome and released the contact. */
  readonly resolvedAt: Date | null;
}

export const MESSAGES_LISTED = 30;

/** Recent outbound messages (ads.view): masked recipients, statuses as recorded. */
export async function listWhatsAppMessages(
  db: Db,
  ctx: TenantContext,
): Promise<WhatsAppMessageView[]> {
  assertCan(ctx, "ads.view");
  const rows = await db.whatsAppMessage.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: MESSAGES_LISTED,
    select: {
      id: true,
      kind: true,
      templateName: true,
      templateLanguage: true,
      status: true,
      errorCode: true,
      createdAt: true,
      statusAt: true,
      resolvedAt: true,
      contact: { select: { maskedNumber: true } },
      run: { select: { state: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    templateName: row.templateName,
    templateLanguage: row.templateLanguage,
    to: row.contact.maskedNumber,
    status: row.status,
    errorCode: row.errorCode,
    runState: row.run?.state ?? null,
    createdAt: row.createdAt,
    statusAt: row.statusAt,
    resolvedAt: row.resolvedAt,
  }));
}
