import type { Page } from "@playwright/test";

import { expect, signUpVerifiedAndSignIn, test } from "./fixtures";

// Pass 4 end to end: campaign → content plan (brief, AI-proposed posts from the fake
// provider, edits, a hand-written post) → approval → drafts → review → the campaign's
// progress and next steps. Real pages, server actions and database; no external call.

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const nextYear = () => String(new Date().getUTCFullYear() + 1);

async function campaignFor(page: Page, locale: "ar" | "en", slug: string, name: string) {
  await signUpVerifiedAndSignIn(page, locale, `e2e-plan-${tag()}@example.com`);
  await page.goto(`/${locale}/workspaces/new`);
  await page.fill("#workspace-name", `Plan ${slug}`);
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/${locale}/w/${slug}`);
  await page.goto(`/${locale}/w/${slug}/campaigns/new`);
  await page.fill("#campaign-form-name", name);
  await page.fill("#campaign-form-startDate", `${nextYear()}-03-05`);
  await page.fill("#campaign-form-endDate", `${nextYear()}-03-19`);
  await page.getByTestId("campaign-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/w/${slug}/campaigns/[0-9a-f-]{36}$`));
  return new URL(page.url()).pathname;
}

test("a campaign goes from plan to approved drafts, review and progress in /en", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const slug = `plan-en-${tag()}`;
  const campaignUrl = await campaignFor(page, "en", slug, "Spring launch");

  // No plan yet: the overview says what to do first; nothing is published.
  await expect(page.getByTestId("campaign-step-write_plan")).toBeVisible();
  await expect(page.getByTestId("campaign-progress-empty")).toBeVisible();
  await expect(page.getByTestId("campaign-result-publishedConfirmed")).toHaveText("0");
  await expect(page.getByTestId("campaign-results-note")).toContainText("not collected");

  // The brief: the person's offer, channels and budget assumptions.
  await page.getByRole("link", { name: "Content plan", exact: true }).click();
  await expect(page).toHaveURL(`${campaignUrl}/plan`);
  await expect(page.getByTestId("plan-status")).toHaveText("Not started");
  await page.fill("#plan-brief-form-offer", "Two drinks for the price of one before 10am");
  await page.getByLabel("Instagram").check();
  await page.fill("#plan-brief-form-budgetNotes", "Organic posts only");
  await page.getByTestId("plan-brief-form-submit").click();
  await expect(page.getByTestId("plan-status")).toHaveText("Draft");

  // AI proposes posts (fake provider: clearly labelled sample text).
  await page.selectOption("#plan-generate-form-count", "3");
  await page.getByTestId("plan-generate-form-submit").click();
  await expect(page.getByTestId("plan-item")).toHaveCount(3);
  await expect(page.getByTestId("plan-ai-note")).toBeVisible();
  await expect(page.getByTestId("plan-ai-test-provider")).toBeVisible();
  // Dates come from the campaign window, channels rotate in the chosen order.
  await expect(page.locator("#plan-item-form-1-plannedDate")).toHaveValue(`${nextYear()}-03-05`);
  await expect(page.locator("#plan-item-form-3-plannedDate")).toHaveValue(`${nextYear()}-03-19`);
  await expect(page.locator("#plan-item-form-2-channel")).toHaveValue("INSTAGRAM");

  // A person edits a proposal and adds one by hand; a blank title is refused in place.
  await page.fill("#plan-item-form-1-title", "Morning offer");
  await page.getByTestId("plan-item-form-1-submit").click();
  await expect(page.locator("#plan-item-form-1-title")).toHaveValue("Morning offer");
  await page.getByTestId("plan-add-form-submit").click();
  await expect(page.locator("#plan-add-form-title-error")).toBeVisible();
  await page.fill("#plan-add-form-title", "Newsletter: spring menu");
  await page.selectOption("#plan-add-form-channel", "EMAIL");
  await page.selectOption("#plan-add-form-contentType", "EMAIL");
  await page.fill("#plan-add-form-plannedDate", `${nextYear()}-03-12`);
  await page.getByTestId("plan-add-form-submit").click();
  await expect(page.getByTestId("plan-item")).toHaveCount(4);
  await expect(page.getByTestId("plan-items-count")).toHaveText("4 planned, 4 included");

  // Approve, then create the drafts (once).
  await page.getByTestId("plan-approve-submit").click();
  await expect(page.getByTestId("plan-status")).toHaveText("Approved");
  await expect(page.getByTestId("plan-brief-form")).toHaveCount(0);
  await page.getByTestId("plan-create-drafts-submit").click();
  await expect(page.getByTestId("plan-all-drafted")).toBeVisible();
  await expect(page.getByTestId("plan-item-drafted")).toHaveCount(4);

  // Progress: four drafts, nothing published, nothing pretending to be.
  await page.goto(campaignUrl);
  await expect(page.getByTestId("campaign-progress-row")).toHaveCount(4);
  await expect(page.getByTestId("campaign-progress-summary")).toHaveText("0 of 4 published");
  await expect(
    page.locator('[data-testid="campaign-progress-row"][data-stage="draft"]'),
  ).toHaveCount(4);
  await expect(page.getByTestId("campaign-steps-none")).toBeVisible();

  // The first draft goes through review; the reviewer asks for changes.
  await page.getByRole("link", { name: "Morning offer" }).click();
  await expect(page.getByTestId("content-status")).toHaveText("Draft");
  await page.getByTestId("transition-submit").getByRole("button").click();
  await expect(page.getByTestId("content-status")).toHaveText("In review");
  const requestChanges = page.getByTestId("transition-request_changes");
  await requestChanges.getByLabel("What needs to change").fill("Show the new cup.");
  await requestChanges.getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByTestId("content-status")).toHaveText("Draft");

  await page.goto(campaignUrl);
  await expect(page.getByTestId("campaign-step-revise_changes")).toContainText(
    "Revise 1 item a reviewer sent back",
  );
  await expect(
    page.locator('[data-testid="campaign-progress-row"][data-stage="changes_requested"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId("campaign-result-publishedConfirmed")).toHaveText("0");
});

test("Arabic RTL: a hand-written plan, approval and a stale edit in /ar", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const slug = `plan-ar-${tag()}`;
  const campaignUrl = await campaignFor(page, "ar", slug, "حملة الربيع");
  await page.goto(`${campaignUrl}/plan`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("plan-status")).toHaveText("لم تبدأ");
  await page.getByTestId("plan-brief-form-submit").click();
  await expect(page.getByTestId("plan-status")).toHaveText("مسودة");
  await expect(page.getByTestId("plan-approve-empty")).toBeVisible();

  await page.fill("#plan-add-form-title", "عرض الصباح");
  await page.fill("#plan-add-form-brief", "صورة للمشروب الجديد مع السعر");
  await page.getByTestId("plan-add-form-submit").click();
  await expect(page.getByTestId("plan-item")).toHaveCount(1);
  await expect(page.getByTestId("plan-item-title")).toHaveText("عرض الصباح");

  // A second tab edits the plan; this tab's older version is refused, not overwritten.
  const other = await context.newPage();
  await other.goto(`${campaignUrl}/plan`);
  await other.fill("#plan-item-form-1-title", "عرض الصباح المحدّث");
  await other.getByTestId("plan-item-form-1-submit").click();
  await expect(other.locator("#plan-item-form-1-title")).toHaveValue("عرض الصباح المحدّث");
  await page.fill("#plan-item-form-1-title", "عنوان قديم");
  await page.getByTestId("plan-item-form-1-submit").click();
  await expect(page.getByTestId("plan-item-form-1").getByTestId("form-error")).toContainText(
    "غيّر شخص آخر هذه الخطة",
  );
  await page.reload();
  await expect(page.getByTestId("plan-item-title")).toHaveText("عرض الصباح المحدّث");

  await page.getByTestId("plan-approve-submit").click();
  await expect(page.getByTestId("plan-status")).toHaveText("معتمدة");
  await page.getByTestId("plan-create-drafts-submit").click();
  await expect(page.getByTestId("plan-item-drafted")).toHaveCount(1);

  await page.goto(campaignUrl);
  await expect(page.getByTestId("campaign-progress-summary")).toHaveText("نُشر 0 من 1");
  await expect(page.getByTestId("campaign-progress-stage")).toHaveText("مسودة");
});
