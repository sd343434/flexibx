import { expect, test, type Page } from "@playwright/test";

/** Collects CSP violations and console errors so pages must render cleanly. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

test.describe("locale routing", () => {
  test.use({ locale: "ar-SA" });

  test("redirects / to Arabic by default", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/ar$/);
  });
});

test.describe("Accept-Language detection", () => {
  test.use({ locale: "en-US" });

  test("redirects / to English when the browser prefers English", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/en$/);
  });
});

test.describe("Arabic (RTL)", () => {
  test("renders with lang=ar, dir=rtl and a right-to-left layout", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/ar");

    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "ar");
    await expect(html).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "مدير تسويق ذكي يعمل من أجلك على مدار الساعة",
    );
    expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe("rtl");

    // In RTL the brand (start) sits to the right of the theme toggle (end).
    const brand = await page.getByRole("link", { name: "فلكسيبكس" }).boundingBox();
    const toggle = await page.getByTestId("theme-toggle").boundingBox();
    expect(brand && toggle && brand.x > toggle.x).toBe(true);

    expect(problems).toEqual([]);
  });
});

test.describe("English (LTR)", () => {
  test("renders with lang=en, dir=ltr and a left-to-right layout", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/en");

    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en");
    await expect(html).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "An AI marketing manager that works for you 24/7",
    );
    expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe("ltr");

    const brand = await page.getByRole("link", { name: "Flexibx" }).boundingBox();
    const toggle = await page.getByTestId("theme-toggle").boundingBox();
    expect(brand && toggle && brand.x < toggle.x).toBe(true);

    expect(problems).toEqual([]);
  });
});

test("the locale switcher keeps the page and remembers the choice", async ({ page, context }) => {
  await page.goto("/ar/does-not-exist");
  await page.getByTestId("locale-switch-en").click();
  await expect(page).toHaveURL(/\/en\/does-not-exist$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === "NEXT_LOCALE")?.value).toBe("en");

  // The explicit choice (cookie) wins over Accept-Language on the next visit to /.
  await page.goto("/");
  await expect(page).toHaveURL(/\/en$/);
});

test("unknown pages and locales render a localized 404", async ({ page }) => {
  const arabic = await page.goto("/ar/missing-page");
  expect(arabic?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("الصفحة غير موجودة");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const english = await page.goto("/en/missing-page");
  expect(english?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");

  const unknownLocale = await page.goto("/xx");
  expect(unknownLocale?.status()).toBe(404);
});
