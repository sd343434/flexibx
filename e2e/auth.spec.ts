import { expect, test, type Page } from "@playwright/test";

// Sign-up → sign-in → sign-out through the real pages, server actions, Better Auth and
// database. Needs the production build with DATABASE_URL and AUTH_SECRET set.

const PASSWORD = "correct horse battery";
const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;

const LOCALES = [
  { locale: "ar", dir: "rtl", name: "ريم", signOut: "تسجيل الخروج" },
  { locale: "en", dir: "ltr", name: "Reem", signOut: "Sign out" },
] as const;

async function sessionCookie(page: Page) {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name.endsWith("flexibx.session_token"));
}

for (const { locale, dir, name, signOut } of LOCALES) {
  test(`sign-up → sign-in → sign-out in /${locale} (${dir})`, async ({ page }) => {
    const email = uniqueEmail(locale);

    // A protected page sends an anonymous visitor to sign-in with a return path.
    await page.goto(`/${locale}/workspaces`);
    await expect(page).toHaveURL(
      `/${locale}/sign-in?next=${encodeURIComponent(`/${locale}/workspaces`)}`,
    );
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);

    // Sign-up (no automatic sign-in) lands back on sign-in, keeping the return path.
    await page.goto(`/${locale}/sign-up`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await expect(page.locator("#sign-up-email")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("#sign-up-password")).toHaveAttribute("dir", "ltr");
    await page.fill("#sign-up-name", name);
    await page.fill("#sign-up-email", email);
    await page.fill("#sign-up-password", PASSWORD);
    await page.getByTestId("sign-up-submit").click();
    await expect(page).toHaveURL(`/${locale}/sign-in?registered=1`);
    await expect(page.getByTestId("registered")).toBeVisible();
    expect(await sessionCookie(page)).toBeUndefined();

    // A wrong password gets the generic message and no session.
    await page.fill("#sign-in-email", email);
    await page.fill("#sign-in-password", "wrong password 123");
    await page.getByTestId("sign-in-submit").click();
    await expect(page.getByTestId("auth-error")).toBeVisible();
    expect(await sessionCookie(page)).toBeUndefined();

    // Correct credentials: an HttpOnly, SameSite=Lax session cookie, then the
    // workspace landing (a new user has none, so it continues to creation).
    await page.fill("#sign-in-password", PASSWORD);
    await page.getByTestId("sign-in-submit").click();
    await expect(page).toHaveURL(`/${locale}/workspaces/new`);
    const cookie = await sessionCookie(page);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");

    // Signed-in users are sent away from the auth pages.
    await page.goto(`/${locale}/sign-in`);
    await expect(page).toHaveURL(`/${locale}/workspaces/new`);

    // Sign-out ends the session; protected pages require sign-in again.
    await page.getByRole("button", { name: signOut }).click();
    await expect(page).toHaveURL(`/${locale}/sign-in`);
    expect(await sessionCookie(page)).toBeUndefined();
    await page.goto(`/${locale}/workspaces/new`);
    await expect(page).toHaveURL(new RegExp(`/${locale}/sign-in\\?next=`));
  });
}

test("an already-registered email gets the same sign-up result", async ({ page }) => {
  const email = uniqueEmail("dup");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto("/en/sign-up");
    await page.fill("#sign-up-name", "Reem");
    await page.fill("#sign-up-email", email);
    await page.fill("#sign-up-password", attempt === 0 ? PASSWORD : "another password 123");
    await page.getByTestId("sign-up-submit").click();
    await expect(page).toHaveURL("/en/sign-in?registered=1");
  }
});

test("an external next is never followed after sign-in", async ({ page }) => {
  const email = uniqueEmail("next");
  await page.goto("/en/sign-up");
  await page.fill("#sign-up-name", "Reem");
  await page.fill("#sign-up-email", email);
  await page.fill("#sign-up-password", PASSWORD);
  await page.getByTestId("sign-up-submit").click();
  await expect(page).toHaveURL("/en/sign-in?registered=1");

  await page.goto(`/en/sign-in?next=${encodeURIComponent("https://evil.example/")}`);
  await page.fill("#sign-in-email", email);
  await page.fill("#sign-in-password", PASSWORD);
  await page.getByTestId("sign-in-submit").click();
  await expect(page).toHaveURL("/en/workspaces/new");
});
