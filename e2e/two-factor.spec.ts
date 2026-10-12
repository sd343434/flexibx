import { totp, wrongCode } from "../tests/integration/totp";

import {
  expect,
  newClientPage,
  signInHere,
  signUpVerifiedAndSignIn,
  test,
  uniqueEmail,
} from "./fixtures";

// Two-step verification end to end on the production build: enrollment on the account
// security page, then a sign-in that needs the code (password alone opens nothing), in
// both directions. TOTP codes are computed from the setup key shown on the page.

for (const { locale, dir } of [
  { locale: "ar", dir: "rtl" },
  { locale: "en", dir: "ltr" },
] as const) {
  test(`enroll, then sign in with password and code, in /${locale} (${dir})`, async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail(`mfa-${locale}`);
    await signUpVerifiedAndSignIn(page, locale, email);

    await page.goto(`/${locale}/account/security`);
    await expect(page.getByTestId("two-factor-section")).toBeVisible();
    await page.fill("#two-factor-start-password", "correct horse battery");
    await page.getByTestId("two-factor-start").click();
    const key = (await page.getByTestId("two-factor-key").textContent())?.trim() ?? "";
    expect(key).toMatch(/^[A-Z2-7]+=*$/);
    await expect(page.getByTestId("backup-codes").locator("li")).toHaveCount(10);
    await page.fill("#two-factor-confirm-code", totp(key));
    await page.getByTestId("two-factor-confirm").click();
    await expect(page).toHaveURL(`/${locale}/account/security?mfa=enabled`);
    await expect(page.getByTestId("two-factor-notice-enabled")).toBeVisible();

    // A new browser: the password step leads to the code step, with no session yet.
    const other = await newClientPage(browser);
    await other.goto(`/${locale}/sign-in`);
    await signInHere(other, email);
    await expect(other).toHaveURL(`/${locale}/sign-in/two-factor`);
    await expect(other.locator("html")).toHaveAttribute("dir", dir);
    await other.goto(`/${locale}/workspaces`);
    await expect(other).toHaveURL(new RegExp(`/${locale}/sign-in`));

    await other.goto(`/${locale}/sign-in`);
    await signInHere(other, email);
    await expect(other).toHaveURL(`/${locale}/sign-in/two-factor`);
    await other.fill("#two-factor-code", wrongCode(key));
    await other.getByTestId("two-factor-submit").click();
    await expect(other.getByTestId("auth-error")).toBeVisible();
    await other.fill("#two-factor-code", totp(key, 1));
    await other.getByTestId("two-factor-submit").click();
    await expect(other).toHaveURL(new RegExp(`/${locale}/workspaces`));
    await other.close();
  });
}
