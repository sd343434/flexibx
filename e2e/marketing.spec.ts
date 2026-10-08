import type { Page } from "@playwright/test";

import { expect, newClientPage, signUpVerifiedAndSignIn, test } from "./fixtures";

// Marketing Core end to end: brand, audiences, pillars, goals, campaigns, content and its
// workflow, the calendar, media and activity — real pages, server actions and database.
// Media is stored in the server process (STORAGE_DRIVER=test-memory, playwright.config.ts).

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// A valid 2×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=",
  "base64",
);

/** Fetches `path` from inside the page (with the browser's own session cookie). */
async function fetchInPage(page: Page, path: string) {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      nosniff: response.headers.get("x-content-type-options"),
    };
  }, path);
}

/**
 * The not-found page. Workspace pages stream (loading state), so a missing record is
 * Next's not-found page under a 200 status; the record's data must not be in it.
 */
async function expectNotFound(page: Page, secret: string) {
  await expect(page.locator("main")).toContainText("404");
  await expect(page.locator("body")).not.toContainText(secret);
}

async function workspaceFor(page: Page, locale: "ar" | "en", slug: string) {
  await signUpVerifiedAndSignIn(page, locale, `e2e-mkt-${tag()}@example.com`);
  await page.goto(`/${locale}/workspaces/new`);
  await page.fill("#workspace-name", `Marketing ${slug}`);
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/${locale}/w/${slug}`);
}

/** A wall-clock time a year ahead (workspace time zone), as a datetime-local value. */
function nextYear(month: string, day: string, time: string) {
  return `${String(new Date().getUTCFullYear() + 1)}-${month}-${day}T${time}`;
}

test("the marketing foundation, content workflow and calendar in /en", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `mkt-en-${tag()}`;
  await workspaceFor(page, "en", slug);
  const base = `/en/w/${slug}`;

  // Dashboard: setup checklist, nothing done yet.
  await expect(page.getByTestId("dashboard-setup")).toBeVisible();
  await expect(page.getByTestId("setup-brand")).toHaveAttribute("data-done", "false");

  // Brand profile.
  await page.getByTestId("nav-brand").click();
  await expect(page).toHaveURL(`${base}/brand`);
  await page.fill("#brand-form-name", "Qahwa House");
  await page.fill("#brand-form-website", "https://qahwa.example");
  await page.fill("#brand-form-toneOfVoice", "Warm and simple");
  await page.fill("#brand-form-keywords", "coffee\nspecialty, Riyadh");
  await page.getByTestId("brand-form-submit").click();
  await expect(page.getByTestId("form-saved")).toBeVisible();
  await page.reload();
  await expect(page.locator("#brand-form-keywords")).toHaveValue("coffee\nspecialty\nRiyadh");

  // Invalid input is rejected with a field message, nothing saved.
  await page.fill("#brand-form-website", "javascript:alert(1)");
  await page.getByTestId("brand-form-submit").click();
  await expect(page.locator("#brand-form-website-error")).toBeVisible();
  await page.reload();
  await expect(page.locator("#brand-form-website")).toHaveValue("https://qahwa.example");

  // Audience and pillar.
  await page.goto(`${base}/brand/audiences`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.fill("#audience-form-name", "Young professionals");
  await page.fill("#audience-form-attributes", "Age: 25–34\nCity: Riyadh");
  await page.getByTestId("audience-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`${base}/brand/audiences/[0-9a-f-]{36}$`));
  await expect(page.locator("#audience-form-attributes")).toHaveValue("Age: 25–34\nCity: Riyadh");

  await page.goto(`${base}/brand/pillars`);
  await page.fill("#pillar-form-name", "Coffee education");
  await page.selectOption("#pillar-form-audienceId", { label: "Young professionals" });
  await page.getByTestId("pillar-form-submit").click();
  await expect(page.getByTestId("pillar-row")).toHaveCount(1);

  // Goal, then a campaign linked to it and the pillar.
  await page.goto(`${base}/campaigns/goals`);
  await page.fill("#goal-form-title", "Grow brand awareness");
  await page.fill("#goal-form-target", "5000");
  await page.fill("#goal-form-startDate", "2030-02-10");
  await page.fill("#goal-form-endDate", "2030-02-01");
  await page.getByTestId("goal-form-submit").click();
  await expect(page.locator("#goal-form-endDate-error")).toBeVisible();
  await page.fill("#goal-form-endDate", "2030-03-01");
  await page.getByTestId("goal-form-submit").click();
  await expect(page.getByTestId("goal-row")).toHaveCount(1);

  await page.goto(`${base}/campaigns`);
  await page.getByTestId("campaign-new").click();
  await page.fill("#campaign-form-name", "Ramadan launch");
  await page.getByLabel("Grow brand awareness").check();
  await page.getByLabel("Coffee education").check();
  await page.fill("#campaign-form-budgetAmount", "1500.5");
  await page.fill("#campaign-form-budgetCurrency", "sar");
  await page.getByTestId("campaign-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`${base}/campaigns/[0-9a-f-]{36}$`));
  await expect(page.locator("#campaign-form-budgetAmount")).toHaveValue("1500.50");
  await expect(page.locator("#campaign-form-budgetCurrency")).toHaveValue("SAR");
  await page.getByTestId("campaign-status-PLANNED").getByRole("button").click();
  await expect(page.getByTestId("campaign-status")).toHaveText("Planned");

  // Media: upload an image; it is served through the access-checked route.
  await page.goto(`${base}/media`);
  await page.setInputFiles("#media-file", { name: "cup.png", mimeType: "image/png", buffer: PNG });
  await page.fill("#media-alt", "A cup of coffee");
  await page.getByTestId("media-upload-submit").click();
  await expect(page.getByTestId("media-row")).toHaveCount(1);
  await expect(page.getByTestId("media-row")).toContainText("2 × 1");
  const src = await page.getByTestId("media-image").getAttribute("src");
  expect(src).toMatch(new RegExp(`^/api/w/${slug}/media/[0-9a-f-]{36}$`));
  expect(await fetchInPage(page, src ?? "")).toEqual({
    status: 200,
    type: "image/png",
    nosniff: "nosniff",
  });
  await expect
    .poll(() =>
      page.getByTestId("media-image").evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(2);

  // A file that only claims to be an image is rejected.
  await page.setInputFiles("#media-file", {
    name: "evil.png",
    mimeType: "image/png",
    buffer: Buffer.from("<svg onload=alert(1)>"),
  });
  await page.getByTestId("media-upload-submit").click();
  await expect(page.getByTestId("form-error")).toBeVisible();
  await expect(page.getByTestId("media-row")).toHaveCount(1);

  // Content: create a draft linked to the campaign, with the image.
  await page.goto(`${base}/content/new`);
  await page.fill("#content-form-title", "Launch teaser");
  await page.fill("#content-form-body", "Something new is brewing.");
  await page.selectOption("#content-form-type", "REEL");
  await page.selectOption("#content-form-campaignId", { label: "Ramadan launch" });
  await page.selectOption("#content-form-pillarId", { label: "Coffee education" });
  await page.getByLabel("A cup of coffee").check();
  await page.getByTestId("content-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`${base}/content/[0-9a-f-]{36}$`));
  const contentUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId("content-status")).toHaveText("Draft");
  await expect(page.getByTestId("content-assets").locator("img")).toHaveCount(1);

  // Workflow: submit → approve → schedule (future) → visible on the calendar.
  await page.getByTestId("transition-submit").getByRole("button").click();
  await expect(page.getByTestId("content-status")).toHaveText("In review");
  await expect(page.getByTestId("content-form")).toHaveCount(0);
  await page.getByTestId("transition-approve").getByRole("button").click();
  await expect(page.getByTestId("content-status")).toHaveText("Approved");
  await page.fill('[data-testid="schedule-at"]', "2020-01-01T10:00");
  await page.getByTestId("transition-schedule").getByRole("button").click();
  await expect(page.getByTestId("action-error")).toBeVisible();
  await expect(page.getByTestId("content-status")).toHaveText("Approved");
  const when = nextYear("03", "15", "10:30");
  await page.fill('[data-testid="schedule-at"]', when);
  await page.getByTestId("transition-schedule").getByRole("button").click();
  await expect(page.getByTestId("content-status")).toHaveText("Scheduled");

  await page.goto(`${base}/calendar?view=week&date=${when.slice(0, 10)}`);
  const day = page.locator(`[data-testid="calendar-day"][data-date="${when.slice(0, 10)}"]`);
  await expect(day.getByTestId("calendar-item")).toContainText("Launch teaser");
  await expect(day.getByTestId("calendar-item")).toContainText("10:30");
  await page.getByTestId("calendar-next").click();
  await expect(page.getByTestId("calendar-empty")).toBeVisible();

  // Reschedule from the calendar's day view, then mark as published.
  await page.goto(`${base}/calendar?view=day&date=${when.slice(0, 10)}`);
  await page.getByTestId("calendar-item").locator("summary").click();
  const moved = nextYear("03", "16", "09:00");
  await page.getByTestId("calendar-move").locator('input[name="scheduledAt"]').fill(moved);
  await page.getByTestId("calendar-move").getByRole("button").click();
  await expect(page.getByTestId("calendar-item")).toHaveCount(0);
  await page.goto(`${base}/calendar?view=day&date=${moved.slice(0, 10)}`);
  await expect(page.getByTestId("calendar-item")).toContainText("Launch teaser");

  await page.goto(contentUrl);
  await page.getByTestId("transition-publish").getByRole("button").click();
  await expect(page.getByTestId("content-status")).toHaveText("Published");
  await expect(page.getByTestId("no-transitions")).toBeVisible();

  // Lists, filters, dashboard and activity reflect it.
  await page.goto(`${base}/content?status=PUBLISHED`);
  await expect(page.getByTestId("content-row")).toHaveCount(1);
  await page.goto(`${base}/content?status=DRAFT`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.goto(base);
  await expect(page.getByTestId("status-count-PUBLISHED")).toContainText("1");
  // Every setup step is done, so the checklist is gone.
  await expect(page.getByTestId("dashboard-setup")).toHaveCount(0);
  await page.getByTestId("nav-activity").click();
  await expect(
    page.locator('[data-testid="activity-row"][data-action="content.status_changed"]'),
  ).toHaveCount(4);
  await expect(page.getByTestId("activity-list")).toContainText("Approved → Scheduled");
});

test("Arabic RTL: brand and content draft in /ar", async ({ page }) => {
  const slug = `mkt-ar-${tag()}`;
  await workspaceFor(page, "ar", slug);
  const base = `/ar/w/${slug}`;

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("nav-content")).toHaveText("المحتوى");
  await page.goto(`${base}/brand`);
  await expect(page.getByTestId("page-title")).toHaveText("الملف التعريفي للعلامة التجارية");
  await page.fill("#brand-form-name", "بيت القهوة");
  await page.fill("#brand-form-keywords", "قهوة، مختصة، الرياض");
  await page.getByTestId("brand-form-submit").click();
  await expect(page.getByTestId("form-saved")).toHaveText("تم الحفظ");
  await page.reload();
  await expect(page.locator("#brand-form-keywords")).toHaveValue("قهوة\nمختصة\nالرياض");

  // A missing title gets an Arabic field message.
  await page.goto(`${base}/content/new`);
  await page.getByTestId("content-form-submit").click();
  await expect(page.locator("#content-form-title-error")).toHaveText(/[؀-ۿ]/);
  await page.fill("#content-form-title", "إطلاق قريب");
  await page.getByTestId("content-form-submit").click();
  await expect(page.getByTestId("content-status")).toHaveText("مسودة");
  await page.getByTestId("transition-submit").getByRole("button").click();
  await expect(page.getByTestId("content-status")).toHaveText("قيد المراجعة");

  await page.goto(`${base}/calendar`);
  await expect(page.getByTestId("calendar-grid")).toHaveAttribute("data-view", "week");
  await expect(page.getByTestId("calendar-day")).toHaveCount(7);
});

test("another workspace's records and media are not reachable", async ({ page, browser }) => {
  const slug = `mkt-a-${tag()}`;
  await workspaceFor(page, "en", slug);
  await page.goto(`/en/w/${slug}/content/new`);
  await page.fill("#content-form-title", "Private plan");
  await page.getByTestId("content-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`/content/[0-9a-f-]{36}$`));
  const contentId = /content\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? "";
  await page.goto(`/en/w/${slug}/media`);
  await page.setInputFiles("#media-file", { name: "a.png", mimeType: "image/png", buffer: PNG });
  await page.getByTestId("media-upload-submit").click();
  const src = (await page.getByTestId("media-image").getAttribute("src")) ?? "";
  const assetId = src.split("/").pop() ?? "";

  // A second account with its own workspace.
  const other = await newClientPage(browser);
  const otherSlug = `mkt-b-${tag()}`;
  await workspaceFor(other, "en", otherSlug);

  // Through its own workspace: another workspace's ids are unknown.
  await other.goto(`/en/w/${otherSlug}/content/${contentId}`);
  await expectNotFound(other, "Private plan");
  expect((await fetchInPage(other, `/api/w/${otherSlug}/media/${assetId}`)).status).toBe(404);
  // Through the first workspace's slug: not a member → the same 404, no data.
  const foreign = await other.goto(`/en/w/${slug}/content/${contentId}`);
  expect(foreign?.status()).toBe(404);
  await expectNotFound(other, "Private plan");
  expect((await fetchInPage(other, src)).status).toBe(404);
  // Signed out: no media.
  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.request.get(src);
  expect(anonymous.status()).toBe(401);
  await anonymousContext.close();
  await other.context().close();
});
