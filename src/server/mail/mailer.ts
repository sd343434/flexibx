import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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

/** Email verification and password reset: a single-use link for the account owner. */
export interface AccountLinkMailData {
  readonly name: string;
  /** Absolute link built from APP_URL; the token is in the URL fragment. */
  readonly url: string;
  readonly expiresInMinutes: number;
}

interface MailEnvelope {
  readonly to: string;
  readonly locale: Locale;
}

export type MailMessage = MailEnvelope &
  (
    | { readonly template: "workspace_invitation"; readonly data: InvitationMailData }
    | { readonly template: "email_verification"; readonly data: AccountLinkMailData }
    | { readonly template: "password_reset"; readonly data: AccountLinkMailData }
  );

export type MailTemplate = MailMessage["template"];

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

/**
 * Test outbox: writes each rendered message as a JSON file (mode 0600) to an absolute
 * directory, where end-to-end tests read the links. Only used when MAIL_TRANSPORT is
 * explicitly `test-outbox`; reports "captured", never "sent". The files contain
 * single-use links: never configure this in a real deployment.
 */
export class OutboxMailer implements Mailer {
  readonly transport = "test-outbox";

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error("MAIL_OUTBOX_DIR must be an absolute path");
  }

  send(message: MailMessage): Promise<{ readonly status: MailDeliveryStatus }> {
    const rendered = renderMail(message);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const name = `${Date.now().toString()}-${randomUUID()}.json`;
    writeFileSync(
      join(this.directory, name),
      JSON.stringify({
        to: message.to,
        locale: message.locale,
        template: message.template,
        ...rendered,
      }),
      { mode: 0o600 },
    );
    return Promise.resolve({ status: "captured" });
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

export interface MailerOptions {
  /** MAIL_TRANSPORT: unset = the environment default; `test-outbox` = OutboxMailer. */
  readonly transport?: "test-outbox" | undefined;
  /** MAIL_OUTBOX_DIR: required with `test-outbox`. */
  readonly outboxDir?: string | undefined;
}

interface MailerLogger extends MailLogger {
  warn(object: Record<string, unknown>, message: string): void;
}

/**
 * The transport for an environment. No real provider exists yet (adding one is a later
 * phase), so production gets UnconfiguredMailer — unless the test outbox is configured
 * explicitly (end-to-end runs of the production build), which is logged loudly.
 */
export function createMailer(
  nodeEnv: string | undefined,
  log: MailerLogger,
  options: MailerOptions = {},
): Mailer {
  if (options.transport === "test-outbox") {
    if (options.outboxDir === undefined) {
      throw new Error("MAIL_TRANSPORT=test-outbox requires MAIL_OUTBOX_DIR");
    }
    log.warn(
      { mail: { transport: "test-outbox" } },
      "Test mail outbox is active: emails are written to disk, none are sent",
    );
    return new OutboxMailer(options.outboxDir);
  }
  if (nodeEnv === "production") return new UnconfiguredMailer();
  if (nodeEnv === "test") return new MemoryMailer();
  return new LogMailer(log);
}
