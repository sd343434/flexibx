import { createTranslator } from "next-intl";

import { getDirection } from "@/i18n/config";

import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";

import type { MailMessage } from "./mailer";

// Localized email templates. Strings live in messages/{ar,en}.json under `emails`, so
// they are covered by the same key-parity test as the UI. Every interpolated value is
// HTML-escaped in the HTML part; the text part is plain text.

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const MESSAGES = { ar, en } as const;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Only absolute http(s) links are ever put into an email. */
function assertHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Email links must be http(s) URLs");
  }
  return url.toString();
}

interface MailParts {
  readonly subject: string;
  readonly intro: string;
  readonly action: string;
  readonly url: string;
  readonly expiry: string;
  readonly ignore: string;
}

function compose(locale: MailMessage["locale"], parts: MailParts): RenderedMail {
  // A subject is a header line: no line breaks, whatever the interpolated values contain.
  const subject = parts.subject.replace(/[\r\n]+/g, " ");
  const url = assertHttpUrl(parts.url);
  const text = [parts.intro, "", `${parts.action}: ${url}`, "", parts.expiry, parts.ignore].join(
    "\n",
  );
  const html = [
    `<!doctype html><html lang="${locale}" dir="${getDirection(locale)}"><body>`,
    `<p>${escapeHtml(parts.intro)}</p>`,
    `<p><a href="${escapeHtml(url)}">${escapeHtml(parts.action)}</a></p>`,
    `<p>${escapeHtml(parts.expiry)}</p>`,
    `<p>${escapeHtml(parts.ignore)}</p>`,
    "</body></html>",
  ].join("");
  return { subject, text, html };
}

function renderAccountLink(
  message: Extract<MailMessage, { template: "email_verification" | "password_reset" }>,
): RenderedMail {
  const { locale, data } = message;
  const t = createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace:
      message.template === "email_verification" ? "emails.verification" : "emails.passwordReset",
  });
  const params = { name: data.name, minutes: data.expiresInMinutes };
  return compose(locale, {
    subject: t("subject"),
    intro: t("intro", params),
    action: t("action"),
    url: data.url,
    expiry: t("expiry", params),
    ignore: t("ignore"),
  });
}

export function renderMail(message: MailMessage): RenderedMail {
  if (message.template !== "workspace_invitation") return renderAccountLink(message);
  const { locale, data } = message;
  const t = createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: "emails.invitation",
    timeZone: "Asia/Riyadh",
  });
  const tRoles = createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: "workspaces.roles",
  });
  const role = tRoles(data.role);
  const expires = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "Asia/Riyadh",
  }).format(data.expiresAt);
  const params = { workspace: data.workspaceName, inviter: data.inviterName, role, date: expires };
  return compose(locale, {
    subject: t("subject", { workspace: data.workspaceName }),
    intro: t("intro", params),
    action: t("action"),
    url: data.acceptUrl,
    expiry: t("expiry", params),
    ignore: t("ignore"),
  });
}
