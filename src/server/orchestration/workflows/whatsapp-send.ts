import { AdPlatformError } from "../../ads/adapter";
import {
  WHATSAPP_ERRORS,
  whatsAppMessageBody,
  type WhatsAppAdapter,
  type WhatsAppOutbound,
} from "../../ads/adapters/whatsapp";
import { withPlatformToken } from "../../ads/connections";
import { decryptToken } from "../../ads/token-vault";
import { recordAudit } from "../../audit/audit-log";
import { AppError } from "../../errors/app-error";
import { applyMarketingPreference } from "../../whatsapp/consent";
import { CONTACT_BINDING } from "../../whatsapp/contacts";
import {
  applyEarlyReports,
  assertSendable,
  loadSendContext,
  readContent,
  WHATSAPP_SEND_WORKFLOW,
  type SendContext,
} from "../../whatsapp/sending";
import type { TaskContext, WorkflowDefinition } from "../workflow";
import { TaskError } from "../workflow";

import { guardWrite, type AdLaunchServices } from "./ad-launch";

// Sending one WhatsApp message: validate (INTERNAL) → send (EXTERNAL) → report. The send
// task describes exactly what goes out — from which business number, to which (masked)
// contact with which recorded consent, which template in which language with which
// parameters, or which text — so an owner or admin approves that message. It is
// re-described right before sending (any change → a new approval), re-checked (consent,
// template status, window, caps, permissions, emergency stop), and sent at most once:
// the message row moves PENDING → SENDING before the call, and anything but PENDING is
// never sent again. An unknown outcome is recorded UNCERTAIN, not retried.

export interface WhatsAppSendServices extends AdLaunchServices {
  readonly whatsapp?: () => WhatsAppAdapter | null;
  /** WHATSAPP_SENDING_ENABLED: outbound messages are refused unless true. */
  readonly whatsappSendingEnabled?: () => boolean;
}

type Context = Pick<TaskContext<WhatsAppSendServices>, "db" | "actor" | "runId" | "services">;

async function messageOf(context: Context): Promise<SendContext> {
  const row = await context.db.whatsAppMessage.findFirst({
    where: { workspaceId: context.actor.workspaceId, runId: context.runId },
    select: { id: true },
  });
  if (row === null) throw new TaskError("message_missing", false);
  const message = await loadSendContext(context.db, context.actor.workspaceId, row.id);
  if (message === null) throw new TaskError("message_missing", false);
  return message;
}

async function checkOrFail(context: Context, message: SendContext): Promise<void> {
  try {
    await assertSendable({
      db: context.db,
      actor: context.actor,
      sendingEnabled: context.services.whatsappSendingEnabled?.() ?? false,
      configured: (context.services.whatsapp?.() ?? null) !== null,
      message,
      now: new Date(),
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw new TaskError((error.fields[0]?.code ?? error.code.toLowerCase()).slice(0, 60), false);
    }
    throw error;
  }
}

function outboundOf(message: SendContext, to: string): WhatsAppOutbound {
  const content = readContent(message.content);
  if (content === null) throw new TaskError("message_invalid", false);
  return content.kind === "TEMPLATE"
    ? {
        kind: "TEMPLATE",
        to,
        templateName: message.templateName ?? "",
        language: message.templateLanguage ?? "",
        parameters: content.parameters,
      }
    : { kind: "TEXT", to, text: content.text };
}

export const whatsappSendWorkflow: WorkflowDefinition<WhatsAppSendServices> = {
  id: WHATSAPP_SEND_WORKFLOW,
  summaryTask: "report",
  tasks: [
    {
      key: "validate",
      dependsOn: [],
      risk: "INTERNAL",
      maxAttempts: 1,
      timeoutMs: 10_000,
      run: async (context) => {
        const message = await messageOf(context);
        if (message.status !== "PENDING") throw new TaskError("message_not_pending", false);
        await checkOrFail(context, message);
        return { status: "succeeded", output: { messageId: message.id } };
      },
    },
    {
      key: "send",
      dependsOn: ["validate"],
      risk: "EXTERNAL",
      // Never retried: a second attempt could send the message twice.
      maxAttempts: 1,
      timeoutMs: 30_000,
      describe: async (context) => {
        const message = await messageOf(context);
        // The body exactly as sent, with the recipient masked.
        const body = whatsAppMessageBody(outboundOf(message, "0".repeat(8)));
        return {
          action: "send_whatsapp_message",
          details: {
            messageId: message.id,
            account: message.account.externalId,
            connectionVersion: message.account.connection.version,
            fromNumberId: message.phoneNumberId,
            to: message.contact.maskedNumber,
            // The opt-in being relied on (its current status is checked when sending:
            // an opt-out stops the message rather than asking for a new approval).
            consent: {
              source: message.contact.consentSource,
              at: message.contact.consentAt.toISOString(),
            },
            kind: message.kind,
            template: message.templateName,
            language: message.templateLanguage,
            body: { ...body, to: message.contact.maskedNumber },
          },
        };
      },
      run: async (context) => {
        const message = await messageOf(context);
        if (message.status !== "PENDING") {
          // SENDING/UNCERTAIN: it may already have gone out — never send it again.
          throw new TaskError("message_not_pending", false);
        }
        await checkOrFail(context, message);
        const whatsapp = context.services.whatsapp?.() ?? null;
        const key = context.services.tokenKey();
        if (whatsapp === null || key === null) throw new TaskError("ads_not_configured", false);
        const workspaceId = context.actor.workspaceId;
        // The emergency stop, again, immediately before the message can leave.
        await guardWrite(context)();
        const claimed = await context.db.whatsAppMessage.updateMany({
          where: { workspaceId, id: message.id, status: "PENDING" },
          data: { status: "SENDING" },
        });
        if (claimed.count === 0) throw new TaskError("message_not_pending", false);

        const finish = async (
          data: { status: string; externalMessageId?: string; errorCode?: number | null },
          action: "whatsapp.send_succeeded" | "whatsapp.send_failed" | "whatsapp.send_uncertain",
          code: string | null,
        ) => {
          await context.db.$transaction(async (tx) => {
            await tx.whatsAppMessage.updateMany({
              where: { workspaceId, id: message.id, status: "SENDING" },
              data: {
                ...data,
                ...(data.status === "ACCEPTED" ? { sentAt: new Date() } : {}),
                statusAt: new Date(),
              },
            });
            await recordAudit(
              tx,
              { workspaceId, userId: null },
              {
                action,
                entityType: "whatsapp_message",
                entityId: message.id,
                metadata: {
                  to: message.contact.maskedNumber,
                  kind: message.kind,
                  template: message.templateName,
                  code,
                },
              },
            );
          });
        };

        let to: string;
        try {
          to = decryptToken(key, message.contact.phoneCiphertext, {
            workspaceId,
            platform: CONTACT_BINDING,
          });
        } catch {
          await finish({ status: "FAILED" }, "whatsapp.send_failed", "contact_unreadable");
          throw new TaskError("contact_unreadable", false);
        }
        try {
          const { messageId: wamid } = await withPlatformToken(
            { db: context.db, adapters: context.services.ads(), tokenKey: key },
            workspaceId,
            "WHATSAPP",
            (token) => whatsapp.sendMessage(token, message.phoneNumberId, outboundOf(message, to)),
          );
          await finish(
            { status: "ACCEPTED", externalMessageId: wamid },
            "whatsapp.send_succeeded",
            null,
          );
          await applyEarlyReports(context.db, workspaceId, {
            id: message.id,
            wabaId: message.account.externalId,
            wamid,
          });
          return { status: "succeeded", output: { messageId: message.id } };
        } catch (error) {
          const raw =
            error instanceof AdPlatformError
              ? error.platformCode
              : error instanceof AppError
                ? error.metadata.platformCode
                : null;
          const platformCode = typeof raw === "number" && Number.isSafeInteger(raw) ? raw : null;
          const uncertain =
            (error instanceof AdPlatformError && error.uncertain) ||
            (error instanceof AppError && error.fields[0]?.code === "ads_outcome_unknown") ||
            !(error instanceof AdPlatformError || error instanceof AppError);
          if (uncertain) {
            await finish({ status: "UNCERTAIN" }, "whatsapp.send_uncertain", "outcome_unknown");
            throw new TaskError("whatsapp_outcome_unknown", false);
          }
          const code =
            platformCode === WHATSAPP_ERRORS.reEngagement
              ? "whatsapp_window_closed"
              : error instanceof AppError
                ? (error.fields[0]?.code ?? error.code)
                : "send_failed";
          await finish({ status: "FAILED", errorCode: platformCode }, "whatsapp.send_failed", code);
          if (platformCode === WHATSAPP_ERRORS.marketingOptOut) {
            // Meta: the customer stopped marketing messages from this business.
            await applyMarketingPreference(context.db, {
              workspaceId,
              contactId: message.contact.id,
              at: new Date(),
              preference: "stop",
              source: "error_131050",
            });
          }
          throw new TaskError(code.slice(0, 60), false);
        }
      },
    },
    {
      key: "report",
      dependsOn: ["validate", "send"],
      risk: "INTERNAL",
      maxAttempts: 1,
      timeoutMs: 10_000,
      run: (context) =>
        Promise.resolve({
          status: "succeeded",
          output: {
            messageId:
              (context.inputs.send as { messageId?: string } | undefined)?.messageId ?? null,
          },
        }),
    },
  ],
};
