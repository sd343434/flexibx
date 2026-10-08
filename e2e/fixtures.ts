import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { test as base, expect, type Browser, type Page } from "@playwright/test";

import { E2E_IP_HEADER, MAIL_OUTBOX_DIR } from "./env";

// Shared end-to-end helpers. Every browser context is its own client (its own trusted
// client IP), so per-client rate limits never leak between tests. Emails are read from
// the test outbox of the production-build server (MAIL_TRANSPORT=test-outbox).

export const PASSWORD = "correct horse battery";
export type Locale = "ar" | "en";

let ipCounter = 0;
function clientIp(): string {
  ipCounter += 1;
  const n = (process.pid % 200) * 10_000 + ipCounter;
  return `10.${String((n >> 16) & 255)}.${String((n >> 8) & 255)}.${String(n & 255)}`;
}

/** `test` whose `context` (and `page`) is a distinct client. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({ [E2E_IP_HEADER]: clientIp() });
    await use(context);
  },
});

export { expect };

/** A new page in a new browser context with its own client IP. */
export async function newClientPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { [E2E_IP_HEADER]: clientIp() } });
  return context.newPage();
}

export const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;

interface OutboxMail {
  readonly to: string;
  readonly template: string;
  readonly locale: string;
  readonly text: string;
}

function outbox(): (OutboxMail & { file: string })[] {
  let files: string[];
  try {
    files = readdirSync(MAIL_OUTBOX_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return files.sort().map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(MAIL_OUTBOX_DIR, file), "utf8")) as OutboxMail),
  }));
}

/** Number of messages to `email` of `template` so far. */
export function mailCount(email: string, template: string): number {
  return outbox().filter((mail) => mail.to === email && mail.template === template).length;
}

/**
 * The link of the newest email of `template` to `email` (waits up to 10 s), as a path
 * plus fragment for `page.goto`. `after`: only messages beyond that count.
 */
export async function emailLink(email: string, template: string, after = 0): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const mails = outbox().filter((mail) => mail.to === email && mail.template === template);
    const mail = mails.length > after ? mails.at(-1) : undefined;
    const match = mail === undefined ? null : /https?:\/\/\S+/.exec(mail.text);
    if (match !== null) {
      const url = new URL(match[0]);
      return `${url.pathname}${url.search}${url.hash}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no ${template} email to ${email}`);
}

/** Opens a verification link and confirms it. */
export async function verifyEmail(page: Page, email: string) {
  await page.goto(await emailLink(email, "email_verification"));
  await page.getByTestId("verify-email-submit").click();
  await expect(page.getByTestId("verify-email-success")).toBeVisible();
}

/** Sign-up form only (lands on sign-in with `registered=1`). */
export async function signUp(page: Page, locale: Locale, email: string, name = "Reem") {
  await page.goto(`/${locale}/sign-up`);
  await page.fill("#sign-up-name", name);
  await page.fill("#sign-up-email", email);
  await page.fill("#sign-up-password", PASSWORD);
  await page.getByTestId("sign-up-submit").click();
  await expect(page).toHaveURL(`/${locale}/sign-in?registered=1`);
}

/** Sign-in form on the current page; waits until the submission has been answered. */
export async function signInHere(page: Page, email: string, password = PASSWORD) {
  await page.fill("#sign-in-email", email);
  await page.fill("#sign-in-password", password);
  await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/sign-in"),
    ),
    page.getByTestId("sign-in-submit").click(),
  ]);
}

/** A new, verified account, signed in (lands on workspace creation). */
export async function signUpVerifiedAndSignIn(
  page: Page,
  locale: Locale,
  email: string,
  name = "Reem",
) {
  await signUp(page, locale, email, name);
  await verifyEmail(page, email);
  await page.goto(`/${locale}/sign-in`);
  await signInHere(page, email);
  await expect(page).toHaveURL(`/${locale}/workspaces/new`);
}
