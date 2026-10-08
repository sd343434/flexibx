import type { Locale } from "@/i18n/config";

import { AppError } from "../errors/app-error";
import type { Role } from "../tenancy/roles";

import { renderMail, type RenderedMail } from "./templates";

// Transactional email, server side only. Pure module (no `server-only`) so transports
// can be unit-tested; application code gets the configured mailer from ./index.ts.
//
// Honesty rule: a transport reports "sent" only when a real provider accepted the
// message. The development and test transports say what they did instead, and with no
// provider in production `send` throws — callers must never report an email as sent.

export interface InvitationMailData {
  readonly workspaceName: string;
  readonly inviterName: string;
  readonly role: Role;
  /** Absolute accept link, built from APP_URL only (see invitation-links.ts). */
  readonly acceptUrl: string;
  readonly expiresAt: Date;
}

export interface MailMessage {
  readonly to: string;
  readonly locale: Locale;
  readonly template: "workspace_invitation";
  readonly data: InvitationMailData;
}

/** sent: a provider accepted it. logged / captured: development / test transports only. */
export type MailDeliveryStatus = "sent" | "logged" | "captured";

export interface Mailer {
  /** Transport name for logs and diagnostics. */
  readonly transport: string;
  send(message: MailMessage): Promise<{ readonly status: MailDeliveryStatus }>;
}

/** `reem@example.com` → `r***@example.com`: enough to debug, not a full address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Test transport: renders and keeps messages in memory. Never leaves the process. */
export class MemoryMailer implements Mailer {
  readonly transport = "memory";
  readonly outbox: (RenderedMail & { readonly to: string; readonly message: MailMessage })[] = [];

  send(message: MailMessage): Promise<{ readonly status: MailDeliveryStatus }> {
    this.outbox.push({ ...renderMail(message), to: message.to, message });
    return Promise.resolve({ status: "captured" });
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

interface MailLogger {
  info(object: Record<string, unknown>, message: string): void;
}

/**
 * Development transport: renders the message (so template errors surface) and logs a
 * redacted record — template, locale, masked recipient. Never the subject, body or link:
 * the link carries the one-time invitation token.
 */
export class LogMailer implements Mailer {
  readonly transport = "log";

  constructor(private readonly log: MailLogger) {}

  send(message: MailMessage): Promise<{ readonly status: MailDeliveryStatus }> {
    renderMail(message);
    this.log.info(
      {
        mail: {
          transport: this.transport,
          template: message.template,
          locale: message.locale,
          to: maskEmail(message.to),
        },
      },
      "Email not sent (development transport); share the link manually",
    );
    return Promise.resolve({ status: "logged" });
  }
}

/** Production with no provider configured: every send fails explicitly. */
export class UnconfiguredMailer implements Mailer {
  readonly transport = "none";

  send(message: MailMessage): Promise<{ readonly status: MailDeliveryStatus }> {
    return Promise.reject(
      new AppError("SERVICE_UNAVAILABLE", {
        message: "No email provider is configured; the email was not sent",
        metadata: { reason: "mailer_not_configured", template: message.template },
      }),
    );
  }
}

/**
 * The transport for an environment. No real provider exists yet (adding one is a later
 * phase), so production always gets UnconfiguredMailer.
 */
export function createMailer(nodeEnv: string | undefined, log: MailLogger): Mailer {
  if (nodeEnv === "production") return new UnconfiguredMailer();
  if (nodeEnv === "test") return new MemoryMailer();
  return new LogMailer(log);
}
