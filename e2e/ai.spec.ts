import type { Page } from "@playwright/test";

import { expect, signUpVerifiedAndSignIn, test, type Locale } from "./fixtures";

// AI Marketing Engine end to end with the deterministic fake provider (AI_PROVIDER=fake,
// playwright.config.ts): AI Studio, a generated suggestion, using it to create a DRAFT,
// and assistance on a draft — in Arabic (RTL) and English (LTR). The "not configured"
// state, the daily cap and the per-user limits are covered by integration tests, since
// one E2E server runs with one provider setting and a 20-request limit.

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function workspaceFor(page: Page, locale: Locale, slug: string) {
  await signUpVerifiedAndSignIn(page, locale, `e2e-ai-${tag()}@example.com`);
  await page.goto(`/${locale}/workspaces/new`);
  await page.fill("#workspace-name", `AI ${slug}`);
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/${locale}/w/${slug}`);
}

test("ideas → use → draft, copy, and draft assistance in /en", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `ai-en-${tag()}`;
  await workspaceFor(page, "en", slug);
  const base = `/en/w/${slug}`;

  // A pillar for the AI to cite.
  await page.goto(`${base}/brand/pillars`);
  await page.fill("#pillar-form-name", "Coffee education");
  await page.getByTestId("pillar-form-submit").click();
  await expect(page).toHaveURL(`${base}/brand/pillars`);

  // AI Studio from the navigation; nothing generated yet.
  await page.getByTestId("nav-ai").click();
  await expect(page).toHaveURL(`${base}/ai`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AI Studio");
  await expect(page.getByTestId("ai-not-configured")).toHaveCount(0);
  await expect(page.getByTestId("ai-result-empty")).toBeVisible();

  // Ideas.
  await page.fill("#ai-ideas-form-topic", "Winter drinks");
  await page.selectOption("#ai-ideas-form-count", "4");
  await page.selectOption("#ai-ideas-form-pillarId", { label: "Coffee education" });
  await page.getByTestId("ai-ideas-form-submit").click();
  await expect(page).toHaveURL(/\/ai\?tool=ideas&g=[0-9a-f-]{36}$/);
  const suggestion = page.getByTestId("suggestion");
  await expect(suggestion).toHaveAttribute("data-operation", "IDEAS");
  await expect(suggestion).toContainText("AI suggestion");
  await expect(page.getByTestId("suggestion-option")).toHaveCount(4);
  await expect(page.getByTestId("suggestion-option").first()).toContainText("Coffee education");
  await expect(page.getByTestId("suggestion-history").locator("li")).toHaveCount(1);
  const studioUrl = page.url();

  // Use the first idea: a new DRAFT, linked to the cited pillar.
  await page.getByTestId("use-0-submit").click();
  await expect(page).toHaveURL(/\/content\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("content-status")).toHaveText("Draft");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Sample suggestion");
  await expect(page.locator("#content-form-pillarId")).toHaveValue(/[0-9a-f-]{36}/);
  const draftUrl = page.url();

  // The suggestion is used once; its page says so and offers no second use.
  await page.goto(studioUrl);
  await expect(page.getByTestId("suggestion-used")).toBeVisible();
  await expect(page.getByTestId("use-0")).toHaveCount(0);

  // Copy with variants.
  await page.goto(`${base}/ai?tool=copy`);
  await page.fill("#ai-copy-form-topic", "Friday offer: second cup free");
  await page.selectOption("#ai-copy-form-contentType", "STORY");
  await page.selectOption("#ai-copy-form-variants", "1");
  await page.getByTestId("ai-copy-form-submit").click();
  await expect(page).toHaveURL(/\/ai\?tool=copy&g=/);
  await expect(page.getByTestId("suggestion-option")).toHaveCount(2);
  await expect(page.getByTestId("ai-regenerate")).toBeVisible();

  // Assistance on the draft: calls to action, then use the second one.
  await page.goto(draftUrl);
  const assist = page.getByTestId("ai-assist");
  await expect(assist).toBeVisible();
  await page.selectOption("#ai-assist-form-operation", "CONTENT_CTA");
  await page.selectOption("#ai-assist-form-language", "en");
  await page.getByTestId("ai-assist-form-submit").click();
  await expect(page).toHaveURL(/\?ai=[0-9a-f-]{36}#ai-assist$/);
  await expect(assist.getByTestId("suggestion-option")).toHaveCount(3);
  await assist.getByTestId("use-1-submit").click();
  await expect(page).toHaveURL(draftUrl);
  await expect(page.locator("#content-form-callToAction")).toHaveValue("Learn more 2");
  await expect(page.getByTestId("content-status")).toHaveText("Draft");

  // Not a draft any more: no assistance offered.
  await page.getByTestId("transition-submit-submit").click();
  await expect(page.getByTestId("content-status")).toHaveText("In review");
  await expect(page.getByTestId("ai-assist")).toHaveCount(0);
});

test("Arabic AI Studio: brief → draft, right to left", async ({ page }) => {
  test.setTimeout(90_000);
  const slug = `ai-ar-${tag()}`;
  await workspaceFor(page, "ar", slug);
  const base = `/ar/w/${slug}`;

  await page.goto(`${base}/ai?tool=brief`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("استوديو الذكاء الاصطناعي");
  await expect(page.getByTestId("nav-ai")).toHaveText("استوديو الذكاء الاصطناعي");

  // A missing topic is a field error; nothing is generated.
  await page.getByTestId("ai-brief-form-submit").click();
  await expect(page.locator("#ai-brief-form-topic-error")).toBeVisible();
  await expect(page.getByTestId("ai-result-empty")).toBeVisible();

  await page.fill("#ai-brief-form-topic", "قهوة باردة للصيف");
  await page.selectOption("#ai-brief-form-contentType", "REEL");
  await page.getByTestId("ai-brief-form-submit").click();
  await expect(page).toHaveURL(/\/ai\?tool=brief&g=/);
  const suggestion = page.getByTestId("suggestion");
  await expect(suggestion).toContainText("اقتراح من الذكاء الاصطناعي");
  await expect(suggestion).toContainText("اقتراح تجريبي");
  await expect(suggestion).toContainText("ريلز");

  await page.getByTestId("use-0-submit").click();
  await expect(page).toHaveURL(/\/ar\/w\/.+\/content\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("content-status")).toHaveText("مسودة");
  await expect(page.locator("#content-form-notes")).toHaveValue(/موجز من اقتراح الذكاء الاصطناعي/);
});

test("another person cannot open someone else's suggestion", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const slug = `ai-own-${tag()}`;
  await workspaceFor(page, "en", slug);
  await page.goto(`/en/w/${slug}/ai`);
  await page.getByTestId("ai-ideas-form-submit").click();
  await expect(page).toHaveURL(/g=[0-9a-f-]{36}$/);
  const generation = new URL(page.url()).searchParams.get("g") ?? "";

  const other = await browser.newPage();
  const otherSlug = `ai-oth-${tag()}`;
  await workspaceFor(other, "en", otherSlug);
  // Same id under the other person's own workspace: not found (no data shown).
  await other.goto(`/en/w/${otherSlug}/ai?g=${generation}`);
  await expect(other.locator("main")).toContainText("404");
  await expect(other.getByTestId("suggestion")).toHaveCount(0);
  // And their own workspace slug cannot reach the first workspace at all.
  await other.goto(`/en/w/${slug}/ai?g=${generation}`);
  await expect(other.getByTestId("suggestion")).toHaveCount(0);
  await other.close();
});
