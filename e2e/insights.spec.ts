import type { Page } from "@playwright/test";

import { expect, newClientPage, signUpVerifiedAndSignIn, test } from "./fixtures";

// Pass 5 end to end: a campaign with a goal and a budget → results imported by a person
// (validation and duplicates shown) → dashboard with sourced numbers → evidence-based
// recommendations → dismiss with a reason, create a draft that still needs approval →
// another workspace cannot see any of it. Real pages, server actions and database; no
// provider is called.

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function workspaceWithCampaign(page: Page, locale: "ar" | "en", slug: string) {
  await signUpVerifiedAndSignIn(page, locale, `e2e-insights-${tag()}@example.com`);
  await page.goto(`/${locale}/workspaces/new`);
  await page.fill("#workspace-name", `Insights ${slug}`);
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/${locale}/w/${slug}`);
  const base = `/${locale}/w/${slug}`;

  // A goal measured in impressions, then a campaign that is two thirds through.
  await page.goto(`${base}/campaigns/goals`);
  await page.fill("#goal-form-title", "Reach 50k");
  await page.fill("#goal-form-target", "50000");
  await page.selectOption("#goal-form-targetMetric", "IMPRESSIONS");
  await page.getByTestId("goal-form-submit").click();
  await expect(page.getByTestId("goal-row")).toHaveCount(1);

  await page.goto(`${base}/campaigns/new`);
  await page.fill("#campaign-form-name", "Autumn offer");
  await page.getByLabel("Reach 50k").check();
  await page.fill("#campaign-form-startDate", isoDay(-20));
  await page.fill("#campaign-form-endDate", isoDay(10));
  await page.fill("#campaign-form-budgetAmount", "100");
  await page.fill("#campaign-form-budgetCurrency", "SAR");
  await page.getByTestId("campaign-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`${base}/campaigns/[0-9a-f-]{36}$`));
  const campaignId = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  await page.goto(`${base}/content/new`);
  await page.fill("#content-form-title", "Morning post");
  await page.selectOption("#content-form-campaignId", { label: "Autumn offer" });
  await page.getByTestId("content-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`${base}/content/[0-9a-f-]{36}$`));
  const contentId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  return { base, campaignId, contentId };
}

const csv = (contentId: string, extra: readonly string[] = []) =>
  [
    "period_start,period_end,metric,value,currency,content_id",
    `${isoDay(-14)},${isoDay(-8)},IMPRESSIONS,2000,,`,
    `${isoDay(-14)},${isoDay(-8)},SPEND,150.00,SAR,`,
    `${isoDay(-14)},${isoDay(-8)},IMPRESSIONS,1200,,${contentId}`,
    ...extra,
  ].join("\n");

test("results import, dashboard, recommendations and a draft in /en", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const slug = `ins-en-${tag()}`;
  const { base, campaignId, contentId } = await workspaceWithCampaign(page, "en", slug);

  // 1. The campaign says results are not collected and links to Insights.
  await page.goto(`${base}/campaigns/${campaignId}`);
  await page.getByTestId("campaign-insights-link").click();
  await expect(page).toHaveURL(`${base}/insights?campaign=${campaignId}`);

  // 2. Nothing recorded yet: an empty state, no invented number, no recommendation.
  await expect(page.getByTestId("insights-provenance")).toBeVisible();
  await expect(page.getByTestId("insights-empty")).toBeVisible();
  await expect(page.getByTestId("insights-recommendation")).toHaveCount(0);

  // 3. An import with one bad row: valid rows are stored, the bad one is named.
  await page.selectOption("#metrics-import-campaign", campaignId);
  await page.fill(
    "#metrics-import-csv",
    csv(contentId, [`${isoDay(-14)},${isoDay(-8)},LIKES,5,,`]),
  );
  await page.getByTestId("metrics-import-submit").click();
  await expect(page.getByTestId("metrics-import-result")).toContainText(
    "3 stored, 0 already recorded, 1 rejected.",
  );
  await expect(page.getByTestId("metrics-import-issues")).toContainText("Row 5: unknown metric");

  // 4. The same rows imported again are recognized, not counted twice.
  await page.reload();
  await page.selectOption("#metrics-import-campaign", campaignId);
  await page.fill("#metrics-import-csv", csv(contentId));
  await page.getByTestId("metrics-import-submit").click();
  await expect(page.getByTestId("metrics-import-result")).toContainText(
    "0 stored, 3 already recorded, 0 rejected.",
  );

  // 5. The dashboard: totals with their source, budget against recorded spend.
  await page.reload();
  await expect(page.getByTestId("insights-total-IMPRESSIONS")).toHaveText("2,000");
  await expect(page.getByTestId("insights-recorded")).toBeVisible();
  await expect(page.getByTestId("insights-campaign")).toContainText("Entered by a person");
  await expect(page.getByTestId("insights-budget")).toContainText("SAR");
  await expect(page.getByTestId("insights-content-row")).toHaveCount(1);
  await expect(page.getByTestId("insights-import-row")).toHaveCount(2);

  // 6. Recommendations with evidence: below the goal's pace, spend above the budget.
  const below = page.locator('[data-testid="insights-recommendation"][data-kind="BELOW_TARGET"]');
  const spend = page.locator(
    '[data-testid="insights-recommendation"][data-kind="SPEND_OVER_BUDGET"]',
  );
  await expect(below).toBeVisible();
  await expect(spend).toBeVisible();
  await expect(below).toContainText("1 observation");
  await expect(below).not.toContainText("1 observations");
  await expect(below.getByTestId("insights-rec-status")).toHaveText("Open");

  // 7. Dismissing needs a reason; with one it is recorded with who and why.
  await spend.getByTestId("insights-rec-dismiss-submit").click();
  await expect(spend.getByTestId("action-error")).toBeVisible();
  await spend.locator('input[name="reason"]').fill("Budget was raised offline");
  await spend.getByTestId("insights-rec-dismiss-submit").click();
  await expect(spend.getByTestId("insights-rec-status")).toHaveText("Dismissed");
  await expect(spend).toContainText("Budget was raised offline");

  // 8. A draft from the recommendation: created once, still a draft needing approval.
  await below.getByTestId("insights-rec-draft-create-submit").click();
  await expect(below.getByTestId("insights-rec-status")).toHaveText("Draft created");
  await expect(below.getByTestId("insights-rec-draft-create-submit")).toHaveCount(0);
  await below.getByTestId("insights-rec-draft").click();
  await expect(page).toHaveURL(new RegExp(`${base}/content/[0-9a-f-]{36}$`));
  await expect(page.getByTestId("content-status")).toHaveText("Draft");

  // 9. Withdrawing an import removes its numbers from the dashboard.
  await page.goto(`${base}/insights`);
  // The oldest import stored the rows (the newer one only found duplicates).
  const firstImport = page.getByTestId("insights-import-row").last();
  await firstImport.getByRole("button", { name: "Withdraw", exact: true }).click();
  await firstImport.getByTestId("insights-import-void-submit").click();
  await expect(firstImport).toContainText("Withdrawn");
  await expect(page.getByTestId("insights-empty")).toBeVisible();

  // 10. Another person's workspace cannot reach this one.
  const other = await newClientPage(browser);
  await signUpVerifiedAndSignIn(other, "en", `e2e-insights-other-${tag()}@example.com`);
  const response = await other.goto(`${base}/insights`);
  expect(response?.status()).toBe(404);
  await expect(other.getByTestId("insights-provenance")).toHaveCount(0);
  await other.context().close();
});

test("Arabic RTL: an import with errors and a dismissed recommendation in /ar", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const slug = `ins-ar-${tag()}`;
  const { base, campaignId, contentId } = await workspaceWithCampaign(page, "ar", slug);
  await page.goto(`${base}/insights`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("insights-empty")).toBeVisible();

  // A file without the header is refused as a whole, in Arabic.
  await page.selectOption("#metrics-import-campaign", campaignId);
  await page.fill("#metrics-import-csv", `${isoDay(-14)},${isoDay(-8)},IMPRESSIONS,5,,`);
  await page.getByTestId("metrics-import-submit").click();
  await expect(page.getByTestId("metrics-import-error")).toHaveText(/[؀-ۿ]/);
  await expect(page.getByTestId("insights-empty")).toBeVisible();

  await page.reload();
  await page.selectOption("#metrics-import-campaign", campaignId);
  await page.fill(
    "#metrics-import-csv",
    csv(contentId, [`${isoDay(-14)},${isoDay(-8)},LIKES,5,,`]),
  );
  await page.getByTestId("metrics-import-submit").click();
  await expect(page.getByTestId("metrics-import-issues")).toContainText("مقياس غير معروف");

  await page.reload();
  const below = page.locator('[data-testid="insights-recommendation"][data-kind="BELOW_TARGET"]');
  await expect(below.getByTestId("insights-rec-status")).toHaveText("مفتوحة");
  await below.locator('input[name="reason"]').fill("الهدف قيد المراجعة");
  await below.getByTestId("insights-rec-dismiss-submit").click();
  await expect(below.getByTestId("insights-rec-status")).toHaveText("مرفوضة");
  await expect(below).toContainText("الهدف قيد المراجعة");
});
