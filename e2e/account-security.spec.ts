import {
  emailLink,
  expect,
  mailCount,
  newClientPage,
  PASSWORD,
  signInHere,
  signUp,
  signUpVerifiedAndSignIn,
  test,
  uniqueEmail,
  verifyEmail,
} from "./fixtures";

// Account security end to end (Phase 2, Step 8) on the production build: production
// verification policy (sign-in and workspace creation never need a verified email, C1;
// verified-only operations do, C6), emails captured by the test outbox, rate limits per
// client.

const NEW_PASSWORD = "a brand new passphrase";

for (const { locale, dir } of [
  { locale: "ar", dir: "rtl" },
  { locale: "en", dir: "ltr" },
] as const) {
  test(`unverified sign-in and workspace creation, then a single-use verification link, in /${locale} (${dir})`, async ({
    page,
  }) => {
    const email = uniqueEmail(`verify-${locale}`);
    await signUp(page, locale, email);
    await signInHere(page, email);
    await expect(page).toHaveURL(`/${locale}/workspaces/new`);
    const slug = `unverified-${locale}-${Date.now().toString(36)}`;
    await page.fill("#workspace-name", `Unverified ${slug}`);
    await page.fill("#workspace-slug", slug);
    await page.getByTestId("create-workspace-submit").click();
    await expect(page).toHaveURL(`/${locale}/w/${slug}`);

    await page.goto(`/${locale}/verify-email`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await expect(page.locator("#resend-verification-email")).toHaveAttribute("dir", "ltr");

    const link = await emailLink(email, "email_verification");
    expect(link).toMatch(new RegExp(`^/${locale}/verify-email#token=`));
    await page.goto(link);
    // The token is read from the fragment and removed from the address bar.
    await expect(page.getByTestId("verify-email-form")).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    await page.getByTestId("verify-email-submit").click();
    await expect(page.getByTestId("verify-email-success")).toBeVisible();

    // Replaying the same link (a new tab, as from the email) fails.
    const replay = await page.context().newPage();
    await replay.goto(link);
    await replay.getByTestId("verify-email-submit").click();
    await expect(replay.getByTestId("verify-email-invalid")).toBeVisible();
    await replay.close();
  });
}

test("resend verification answers the same for any address and sends a working link", async ({
  page,
}) => {
  const email = uniqueEmail("resend");
  await signUp(page, "en", email);
  const before = mailCount(email, "email_verification");

  for (const address of [email, uniqueEmail("nobody")]) {
    await page.goto("/en/verify-email");
    await page.fill("#resend-verification-email", address);
    await page.getByTestId("resend-verification-submit").click();
    await expect(page.getByTestId("resend-verification-sent")).toBeVisible();
  }
  const link = await emailLink(email, "email_verification", before);
  await page.goto(link);
  await page.getByTestId("verify-email-submit").click();
  await expect(page.getByTestId("verify-email-success")).toBeVisible();
});

test("forgot password → reset → old password fails, other sessions end", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail("reset");
  await signUpVerifiedAndSignIn(page, "en", email);

  // Another browser requests and completes the reset.
  const other = await newClientPage(browser);
  await other.goto("/en/sign-in");
  await other.getByTestId("forgot-password-link").click();
  await expect(other).toHaveURL("/en/forgot-password");
  await other.fill("#forgot-password-email", email);
  await other.getByTestId("forgot-password-submit").click();
  await expect(other.getByTestId("forgot-password-sent")).toBeVisible();
  // Same answer for an unknown address.
  await other.goto("/en/forgot-password");
  await other.fill("#forgot-password-email", uniqueEmail("ghost"));
  await other.getByTestId("forgot-password-submit").click();
  await expect(other.getByTestId("forgot-password-sent")).toBeVisible();

  const link = await emailLink(email, "password_reset");
  expect(link).toMatch(/^\/en\/reset-password#token=[A-Za-z0-9]{24}$/);
  await other.goto(link);
  await expect(other.locator("#reset-new-password")).toHaveAttribute("dir", "ltr");
  await other.fill("#reset-new-password", NEW_PASSWORD);
  await other.getByTestId("reset-password-submit").click();
  await expect(other).toHaveURL("/en/sign-in?reset=1");
  await expect(other.getByTestId("passwordReset")).toBeVisible();

  // The first browser's session is gone.
  await page.goto("/en/workspaces");
  await expect(page).toHaveURL(new RegExp("/en/sign-in\\?next="));

  // Old password fails, new one works; the link cannot be used again.
  await signInHere(other, email, PASSWORD);
  await expect(other.getByTestId("auth-error")).toBeVisible();
  await signInHere(other, email, NEW_PASSWORD);
  await expect(other).toHaveURL("/en/workspaces/new");
  await other.goto(link);
  await other.fill("#reset-new-password", "yet another passphrase");
  await other.getByTestId("reset-password-submit").click();
  await expect(other.getByTestId("reset-password-invalid")).toBeVisible();
  await other.close();
});

test("change password from the account menu (Arabic) signs out other browsers", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail("change");
  await signUpVerifiedAndSignIn(page, "ar", email);
  const slug = `sec-${Date.now().toString(36)}`;
  await page.fill("#workspace-name", "Security");
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/ar/w/${slug}`);

  const other = await newClientPage(browser);
  await other.goto("/ar/sign-in");
  await signInHere(other, email);
  await expect(other).toHaveURL(`/ar/w/${slug}`);

  await page.getByTestId("user-menu").locator("summary").click();
  await page.getByTestId("account-security").click();
  await expect(page).toHaveURL("/ar/account/security");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("#current-password")).toHaveAttribute("dir", "ltr");
  await page.fill("#current-password", PASSWORD);
  await page.fill("#new-password", NEW_PASSWORD);
  await page.getByTestId("change-password-submit").click();
  await expect(page.getByTestId("change-password-success")).toBeVisible();

  // This browser stays signed in; the other one is signed out.
  await page.goto(`/ar/w/${slug}`);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await other.goto(`/ar/w/${slug}`);
  await expect(other).toHaveURL(new RegExp("/ar/sign-in\\?next="));
  await other.close();
});

test("repeated sign-in failures are rate limited per client", async ({ page, browser }) => {
  await page.goto("/en/sign-in");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await signInHere(page, `nobody-${String(attempt)}@example.com`, "wrong password!");
    await expect(page.getByTestId("auth-error")).toHaveText("The email or password is incorrect.");
  }
  await signInHere(page, "nobody@example.com", "wrong password!");
  await expect(page.getByTestId("auth-error")).toHaveText(
    "Too many attempts. Please wait a few minutes and try again.",
  );

  // Another client is unaffected; Arabic shows the Arabic message.
  const other = await newClientPage(browser);
  await other.goto("/ar/sign-in");
  await signInHere(other, "nobody@example.com", "wrong password!");
  await expect(other.getByTestId("auth-error")).toHaveText(
    "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  );
  await other.close();
});

test("a malicious return path is never followed after verification and sign-in", async ({
  page,
}) => {
  const email = uniqueEmail("next");
  await signUp(page, "en", email);
  await verifyEmail(page, email);
  for (const next of ["https://evil.example/", "//evil.example/en", "/\\evil.example"]) {
    await page.goto(`/en/sign-in?next=${encodeURIComponent(next)}`);
    await signInHere(page, email);
    await expect(page).toHaveURL("/en/workspaces/new");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/en/sign-in");
  }
  await page.goto(`/en/sign-in?next=${encodeURIComponent("/en/account/security")}`);
  await signInHere(page, email);
  await expect(page).toHaveURL("/en/account/security");
});
