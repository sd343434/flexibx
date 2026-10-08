import type { Page } from "@playwright/test";

import { expect, newClientPage, signUpVerifiedAndSignIn, test } from "./fixtures";

// The workspace shell end to end: real pages, server actions, Better Auth and database.
// Needs the production build with DATABASE_URL and AUTH_SECRET set.

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function signUpAndSignIn(page: Page, locale: "ar" | "en") {
  await signUpVerifiedAndSignIn(page, locale, `e2e-shell-${tag()}@example.com`);
}

async function createWorkspace(page: Page, locale: "ar" | "en", name: string, slug: string) {
  await page.goto(`/${locale}/workspaces/new`);
  await page.fill("#workspace-name", name);
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/${locale}/w/${slug}`);
}

for (const { locale, dir, signOut } of [
  { locale: "ar", dir: "rtl", signOut: "تسجيل الخروج" },
  { locale: "en", dir: "ltr", signOut: "Sign out" },
] as const) {
  test(`shell, switching and sign-out in /${locale} (${dir})`, async ({ page }) => {
    const id = tag();
    const alpha = `alpha-${id}`;
    const beta = `beta-${id}`;
    await signUpAndSignIn(page, locale);
    await createWorkspace(page, locale, `Alpha ${id}`, alpha);
    await createWorkspace(page, locale, `Beta ${id}`, beta);

    // The shell: direction, current workspace, switcher, navigation, user menu.
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("current-workspace")).toHaveText(`Beta ${id}`);
    await expect(page.getByTestId("workspace-name")).toHaveText(`Beta ${id}`);
    await expect(page.getByTestId("nav-home")).toHaveAttribute("href", `/${locale}/w/${beta}`);

    // Switching is navigation within the same locale.
    await page.getByTestId("workspace-switcher").locator("summary").click();
    await page.getByTestId(`switch-to-${alpha}`).click();
    await expect(page).toHaveURL(`/${locale}/w/${alpha}`);
    await expect(page.getByTestId("workspace-name")).toHaveText(`Alpha ${id}`);

    // /workspaces now goes to the last workspace; ?list=1 lists both.
    await page.goto(`/${locale}/workspaces`);
    await expect(page).toHaveURL(`/${locale}/w/${alpha}`);
    await page.goto(`/${locale}/workspaces?list=1`);
    await expect(page.getByTestId("workspace-list").locator("li")).toHaveCount(2);

    // Sign-out from the user menu; going back shows no workspace data.
    await page.goto(`/${locale}/w/${beta}`);
    await page.getByTestId("user-menu").locator("summary").click();
    await expect(page.getByTestId("user-role")).toBeVisible();
    await page.getByRole("button", { name: signOut }).click();
    await expect(page).toHaveURL(`/${locale}/sign-in`);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/${locale}/sign-in\\?next=`));
    await expect(page.getByTestId("app-shell")).toHaveCount(0);
    await expect(page.getByText(`Beta ${id}`)).toHaveCount(0);
  });
}

test("anonymous and foreign access to a workspace", async ({ page, browser }) => {
  const slug = `private-${tag()}`;
  await signUpAndSignIn(page, "en");
  await createWorkspace(page, "en", "Private", slug);

  // Anonymous: sign-in with a safe return path.
  const anonymous = await newClientPage(browser);
  await anonymous.goto(`/en/w/${slug}`);
  await expect(anonymous).toHaveURL(`/en/sign-in?next=${encodeURIComponent(`/en/w/${slug}`)}`);
  await anonymous.close();

  // Another signed-in user: the same 404 as for an unknown workspace.
  const intruder = await newClientPage(browser);
  await signUpAndSignIn(intruder, "en");
  const response = await intruder.goto(`/en/w/${slug}`);
  expect(response?.status()).toBe(404);
  await expect(intruder.getByTestId("app-shell")).toHaveCount(0);
  await expect(intruder.getByText("Private")).toHaveCount(0);
  await intruder.close();
});
