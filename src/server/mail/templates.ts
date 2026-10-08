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

export function renderMail(message: MailMessage): RenderedMail {
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
  const url = assertHttpUrl(data.acceptUrl);
  const params = { workspace: data.workspaceName, inviter: data.inviterName, role, date: expires };

  // A subject is a header line: no line breaks, whatever the workspace name contains.
  const subject = t("subject", { workspace: data.workspaceName }).replace(/[\r\n]+/g, " ");
  const intro = t("intro", params);
  const expiry = t("expiry", params);
  const action = t("action");
  const ignore = t("ignore");

  const text = [intro, "", `${action}: ${url}`, "", expiry, ignore].join("\n");
  const html = [
    `<!doctype html><html lang="${locale}" dir="${getDirection(locale)}"><body>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p>`,
    `<p>${escapeHtml(expiry)}</p>`,
    `<p>${escapeHtml(ignore)}</p>`,
    "</body></html>",
  ].join("");
  return { subject, text, html };
}
